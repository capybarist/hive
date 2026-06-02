/**
 * PubmedSource — PubMed (NCBI) abstracts as ForagerSource.
 *
 * The biomedical analogue of ArxivSource. PubMed is a *search* corpus, not a
 * crawlable domain, so — like arXiv — we never scrape the website. We use the
 * official NCBI E-utilities JSON/XML API:
 *
 *   - seed(query)  → esearch.fcgi → list of PMIDs → canonical abstract URLs.
 *   - fetch(url)   → efetch.fcgi (one PMID) → 1 verbatim fragment (the abstract).
 *
 * Determinism: the same `term` returns the same PMID set, and a PMID's
 * abstract is immutable once published, so two bees declaring the same query
 * produce the same fragments → same content_hash → corroboration. This is why
 * a dedicated connector beats live web crawling of pubmed.ncbi.nlm.nih.gov.
 *
 * Rate limits (NCBI policy): 3 requests/sec without an API key, 10/sec with
 * one. The autonomous_extractor caps PubMed at ≤5 fetches/cycle (one
 * cycle/min), so we stay well under the unauthenticated limit. Set
 * `NCBI_API_KEY` to raise the ceiling; we forward it when present.
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';
import { promises as fsp } from 'node:fs';
import { join as pathJoin } from 'node:path';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const ABSTRACT_URL_PREFIX = 'https://pubmed.ncbi.nlm.nih.gov/';
// NCBI asks every client to identify itself (tool + email). Polite + required
// for higher rate tiers; matches the User-Agent convention in web_source.
const TOOL = 'hive';
const EMAIL = 'capy@capybaralabs.tech';

/** Append api_key + tool + email to an E-utilities query string. */
function withCreds(params: URLSearchParams): URLSearchParams {
  params.set('tool', TOOL);
  params.set('email', EMAIL);
  const key = process.env.NCBI_API_KEY;
  if (key) params.set('api_key', key);
  return params;
}

// NCBI throttles to 3 req/s without an API key, 10/s with one (HTTP 429 over
// the limit). The extractor fires esearch + N efetch back-to-back per cycle, so
// without spacing it bursts past 3/s and gets 429'd. A tiny module-global
// limiter serialises every E-utilities call from this source with a minimum
// gap. Reserving the slot synchronously (`nextSlot`) keeps concurrent awaiters
// correctly spaced rather than all reading the same `lastReq`.
const MIN_GAP_MS = process.env.NCBI_API_KEY ? 120 : 360;
let nextSlot = 0;
async function eutilsThrottle(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** fetch() wrapper that throttles + surfaces 429 with a clear, retryable error. */
async function eutilsFetch(url: string): Promise<Response> {
  await eutilsThrottle();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 429) throw new Error('NCBI rate limit (429) — set NCBI_API_KEY or lower cycle budget');
  return res;
}

// ── Pagination cursor ───────────────────────────────────────────────────────
// sort=date + retmax alone only ever surfaces a term's newest N PMIDs; once
// those are signed every revisit is "0 new" until new papers publish. To keep
// ingesting a term's back-catalogue we walk down the result list with retstart,
// persisting a per-term offset across cycles (and process restarts) in the data
// dir so progress isn't lost. The offset wraps to 0 once we pass the count.
const CURSOR_FILE = pathJoin(process.env.HIVE_DATA_DIR || '.', 'pubmed_cursors.json');
let cursors: Record<string, number> | null = null;
async function loadCursors(): Promise<Record<string, number>> {
  if (cursors) return cursors;
  try { cursors = JSON.parse(await fsp.readFile(CURSOR_FILE, 'utf8')) as Record<string, number>; }
  catch { cursors = {}; }
  return cursors;
}
async function saveCursors(): Promise<void> {
  try { await fsp.writeFile(CURSOR_FILE, JSON.stringify(cursors ?? {}), 'utf8'); }
  catch { /* best-effort: a lost cursor just re-walks from the top next restart */ }
}

// PubMed efetch XML leaks HTML entities into text nodes (e.g. a non-breaking
// space arrives as `&#xa0;` after the XML layer is parsed). Decode them so the
// embedded/displayed text is clean — same approach as web_source.ts. nbsp is
// folded to a regular space so downstream whitespace collapse is uniform.
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&[a-zA-Z]+;/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/ /g, ' ');
}

/**
 * AbstractText comes in several shapes from efetch XML:
 *   - a plain string
 *   - an object { '#text': '...', '@_Label': 'BACKGROUND' } for structured
 *     abstracts
 *   - an array of either of the above (multi-section abstracts)
 * Flatten to one string, prefixing each labelled section ("BACKGROUND: …").
 */
function flattenAbstract(node: unknown): string {
  const one = (n: any): string => {
    if (n == null) return '';
    if (typeof n === 'string') return n;
    if (typeof n === 'number') return String(n);
    const text = typeof n['#text'] === 'string' ? n['#text'] : (n['#text'] != null ? String(n['#text']) : '');
    const label = typeof n['@_Label'] === 'string' ? n['@_Label'] : '';
    return label ? `${label}: ${text}` : text;
  };
  const parts = Array.isArray(node) ? node.map(one) : [one(node)];
  const joined = parts.map((s) => s.trim()).filter(Boolean).join('\n\n').replace(/\s+\n/g, '\n').trim();
  return decodeEntities(joined);
}

export class PubmedSource implements ForagerSource {
  readonly id = 'pubmed';
  readonly displayName = 'PubMed';
  // PubMed records are bibliographic metadata; abstracts carry the publisher's
  // copyright. We store the abstract as the verbatim citation context and
  // treat the source URL as the source of truth for re-verification.
  readonly licence = 'NCBI-public-metadata';

  /** Extract the numeric PMID from `https://pubmed.ncbi.nlm.nih.gov/12345/`. */
  pmidFromUrl(url: string): string | null {
    const normalised = this.normalize(url);
    if (!normalised.startsWith(ABSTRACT_URL_PREFIX)) return null;
    const pmid = normalised.slice(ABSTRACT_URL_PREFIX.length).replace(/\/$/, '');
    return /^\d+$/.test(pmid) ? pmid : null;
  }

  urlFromPmid(pmid: string): string {
    return `${ABSTRACT_URL_PREFIX}${pmid}/`;
  }

  normalize(url: string): string {
    // Strip #fragment and ?query; PMID URLs carry no meaningful query params.
    const cleaned = url.split('#')[0]!.split('?')[0]!;
    if (!cleaned.startsWith(ABSTRACT_URL_PREFIX)) return cleaned;
    const pmid = cleaned.slice(ABSTRACT_URL_PREFIX.length).replace(/\/$/, '');
    return /^\d+$/.test(pmid) ? this.urlFromPmid(pmid) : cleaned;
  }

  owns(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.hostname !== 'pubmed.ncbi.nlm.nih.gov') return false;
      // /<pmid>/ is the canonical abstract page. Reject search / listing pages.
      return /^\/\d+\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  }

  /**
   * v0.7.6 — PubMed isn't cheaply partitionable by URL (PMIDs are opaque).
   * If the operator declares multiple search terms, each term is its own
   * partition so N bees can split a query set; otherwise a single bucket.
   */
  partitions(scope?: Record<string, unknown>): string[] {
    const terms = scope?.terms;
    if (Array.isArray(terms) && terms.length > 0) {
      return (terms as unknown[]).filter((t): t is string => typeof t === 'string');
    }
    return ['*'];
  }

  /**
   * The PMID URL doesn't encode the query, so we can't tell from the URL alone
   * which term-partition a paper belongs to. Accept conservatively; the
   * seed-time term selection already narrows the set.
   */
  isInPartition(_url: string, _scope: Record<string, unknown> | undefined, partition: string): boolean {
    return partition === '*' || true;
  }

  /**
   * esearch: turn a search term into a list of canonical abstract URLs.
   *
   * Scope hints (from BeeManifest `DeclaredSource.scope`):
   *   - scope.query  : explicit PubMed search term (overrides opts.query)
   *   - scope.terms  : string[] — first term used unless a partition is given
   * The PubMed query syntax is rich (`asthma[mesh] AND 2024[pdat]`); we pass
   * the term through verbatim so operators can use field tags and filters.
   */
  async seed(opts: SeedOptions): Promise<string[]> {
    const scopeQuery = typeof opts.scope?.query === 'string' ? (opts.scope!.query as string) : undefined;
    const scopeTerms = Array.isArray(opts.scope?.terms)
      ? (opts.scope!.terms as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    // The extractor resolves topic rotation (scope.terms) and passes the chosen
    // term as opts.query, so it takes precedence here; scopeQuery / scopeTerms[0]
    // remain the fallback for direct callers that don't pre-resolve a term.
    const term = (opts.query?.trim() || scopeQuery || scopeTerms[0] || '').trim();
    if (!term) return [];

    // Default to most-recent (sort=date) rather than relevance: a continuously
    // running bee re-querying a fixed term under sort=relevance gets the same
    // top-N PMIDs every cycle forever (all already-signed → "0 new"). Newest-first
    // keeps fresh abstracts arriving as they are published. Override via scope.sort.
    const sort = typeof opts.scope?.sort === 'string' ? (opts.scope.sort as string) : 'date';
    const limit = opts.limit ?? 5;

    // Resume where this term left off last cycle so we keep pulling fresh PMIDs
    // instead of replateauing on its newest `limit`.
    const store = await loadCursors();
    const retstart = store[term] ?? 0;

    const params = withCreds(new URLSearchParams({
      db: 'pubmed',
      term,
      retmode: 'json',
      retmax: String(limit),
      retstart: String(retstart),
      sort,
    }));
    const res = await eutilsFetch(`${EUTILS}/esearch.fcgi?${params}`);
    if (!res.ok) throw new Error(`PubMed esearch: HTTP ${res.status}`);
    const json = await res.json() as { esearchresult?: { idlist?: string[]; count?: string } };
    const pmids = json.esearchresult?.idlist ?? [];
    const count = Number(json.esearchresult?.count ?? 0);

    // Advance the cursor; wrap to the top once we've walked past the last page
    // (empty page or next offset ≥ total), so the term re-harvests over time.
    const next = retstart + limit;
    store[term] = (pmids.length === 0 || (count > 0 && next >= count)) ? 0 : next;
    await saveCursors();

    return pmids.filter((id) => /^\d+$/.test(id)).map((id) => this.urlFromPmid(id));
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.owns(url)) throw new Error(`PubmedSource: not a PubMed abstract URL: ${url}`);
    const pmid = this.pmidFromUrl(url);
    if (!pmid) throw new Error(`PubmedSource: cannot parse PMID from ${url}`);

    const params = withCreds(new URLSearchParams({
      db: 'pubmed',
      id: pmid,
      rettype: 'abstract',
      retmode: 'xml',
    }));
    const res = await eutilsFetch(`${EUTILS}/efetch.fcgi?${params}`);
    if (!res.ok) throw new Error(`PubMed efetch: HTTP ${res.status} for PMID ${pmid}`);
    const xml = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
    const parsed = parser.parse(xml);
    const article = parsed?.PubmedArticleSet?.PubmedArticle;
    // efetch with a single id returns one PubmedArticle (object). Books return
    // PubmedBookArticle, which we don't handle — bail out cleanly.
    const a = Array.isArray(article) ? article[0] : article;
    const noContent: FetchResult = { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 90 * 24 * 3600 } };
    if (!a) return noContent;

    const articleNode = a?.MedlineCitation?.Article;
    if (!articleNode) return noContent;

    const rawTitle = articleNode.ArticleTitle;
    const title = decodeEntities((typeof rawTitle === 'object' ? flattenAbstract(rawTitle) : String(rawTitle ?? '')))
      .replace(/\s+/g, ' ').trim();
    const abstract = flattenAbstract(articleNode.Abstract?.AbstractText);
    if (!abstract) return noContent;

    // DOI: prefer the PubmedData ArticleIdList (authoritative), fall back to
    // the Article ELocationID.
    let doi: string | null = null;
    const ids = a?.PubmedData?.ArticleIdList?.ArticleId;
    const idArr = Array.isArray(ids) ? ids : [ids].filter(Boolean);
    for (const id of idArr) {
      if (id?.['@_IdType'] === 'doi') { doi = String(id['#text'] ?? '').trim() || null; break; }
    }
    if (!doi) {
      const eloc = articleNode.ELocationID;
      const elocArr = Array.isArray(eloc) ? eloc : [eloc].filter(Boolean);
      for (const e of elocArr) {
        if (e?.['@_EIdType'] === 'doi') { doi = String(e['#text'] ?? '').trim() || null; break; }
      }
    }

    const fragments: VerbatimFragment[] = [{
      // <pmid>_c0 mirrors arXiv's single-chunk id scheme. The downstream v0.8
      // chunker may still split a long abstract into multiple chunks, in which
      // case buildAndSaveV08 appends _c<index>; for single-chunk it keeps this.
      id: `pubmed_${pmid}_c0`,
      text: abstract,
      source: this.urlFromPmid(pmid),
      title: title || undefined,
      doi,
      confidence: 0.8,
    }];

    return {
      fragments,
      // Abstracts don't expose machine-readable outbound links at this endpoint.
      outboundLinks: [],
      // PubMed abstracts are stable post-publication (revisions are rare and
      // additive). 90 days is conservative for a slow-changing corpus.
      refreshPolicy: { ttlSeconds: 90 * 24 * 3600 },
    };
  }
}

export const pubmedSource = new PubmedSource();
