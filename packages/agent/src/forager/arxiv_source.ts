/**
 * ArxivSource — arXiv.org abstracts as ForagerSource.
 *
 * Behaviour preserves v0.6's `arxiv_search` tool:
 *   - Same arXiv API endpoint and query shape (relevance+date sort).
 *   - Same fragment confidence (0.7) and id scheme (<arxiv_id>_c0).
 *   - Same DOI extraction (when arXiv provides one in the entry metadata).
 *
 * The interface mapping:
 *   - seed(query)   → one arXiv search → list of canonical abstract URLs.
 *   - fetch(url)    → one paper lookup by arxiv_id → 1 fragment.
 *
 * v0.6 did search+index in a single call (each search result became one
 * indexed abstract). The v0.7.2 seam doubles that to search → list URLs,
 * then 1 lookup per URL. Cost: the aux branch is one cycle/minute and
 * indexes ≤5 papers per cycle, so we add ~5 small arXiv API calls/min
 * per bee. The alternative (caching seed results) is a v0.7.x perf
 * optimisation, not a correctness concern.
 */

import { XMLParser } from 'fast-xml-parser';
import { fetchPapers } from '../arxiv_client.js';
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';
const ABSTRACT_URL_PREFIX = 'https://arxiv.org/abs/';

// arXiv IDs come in two formats:
//   modern: NNNN.NNNNN[vN]   (post-2007)
//   legacy: <category>/NNNNNNN[vN]
// Both are valid in the /abs/ URL path. Stripping the version suffix
// gives the canonical (latest-version) identifier.
const VERSION_SUFFIX = /v\d+$/;

export class ArxivSource implements ForagerSource {
  readonly id = 'arxiv';
  readonly displayName = 'arXiv';
  readonly licence = 'arXiv-perpetual'; // see https://arxiv.org/help/license

  /** Extract arxiv_id from `https://arxiv.org/abs/2501.12345[v2]`. */
  arxivIdFromUrl(url: string): string | null {
    const normalised = this.normalize(url);
    if (!normalised.startsWith(ABSTRACT_URL_PREFIX)) return null;
    return normalised.slice(ABSTRACT_URL_PREFIX.length) || null;
  }

  urlFromArxivId(id: string): string {
    return ABSTRACT_URL_PREFIX + id.replace(VERSION_SUFFIX, '');
  }

  normalize(url: string): string {
    // Strip #fragment and ?query, and the trailing version suffix on the
    // arxiv_id portion so 2501.12345v3 → 2501.12345 (canonical id).
    const cleaned = url.split('#')[0]!.split('?')[0]!;
    if (!cleaned.startsWith(ABSTRACT_URL_PREFIX)) return cleaned;
    const id = cleaned.slice(ABSTRACT_URL_PREFIX.length).replace(VERSION_SUFFIX, '');
    return ABSTRACT_URL_PREFIX + id;
  }

  owns(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.hostname !== 'arxiv.org') return false;
      // /abs/<id> is the canonical abstract page. /pdf/<id> is the PDF;
      // we treat that as the same paper but don't crawl the binary —
      // the abstract page carries the metadata we want.
      return u.pathname.startsWith('/abs/');
    } catch {
      return false;
    }
  }

  async seed(opts: SeedOptions): Promise<string[]> {
    const papers = await fetchPapers(opts.query, opts.limit ?? 5);
    return papers
      .filter((p) => !!p.arxiv_id)
      .map((p) => this.urlFromArxivId(p.arxiv_id));
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.owns(url)) throw new Error(`ArxivSource: not an arXiv abstract URL: ${url}`);
    const arxivId = this.arxivIdFromUrl(url);
    if (!arxivId) throw new Error(`ArxivSource: cannot parse id from ${url}`);

    // Single-paper lookup via the id_list endpoint. Same arXiv API,
    // different query parameter; the rate-limit policy is the same.
    const apiUrl = `${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`arXiv API: HTTP ${res.status} for ${arxivId}`);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    const entry = parsed?.feed?.entry;
    if (!entry) return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };

    // entry may be an array if id_list contains multiple ids; we asked
    // for one so unwrap defensively.
    const e = Array.isArray(entry) ? entry[0] : entry;
    const title = (e.title ?? '').replace(/\s+/g, ' ').trim();
    const abstract = (e.summary ?? '').replace(/\s+/g, ' ').trim();
    if (!abstract) return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };

    let doi: string | null = e['arxiv:doi'] ?? null;
    if (!doi) {
      const links: any[] = Array.isArray(e.link) ? e.link : [e.link].filter(Boolean);
      const doiLink = links.find((l: any) => l?.['@_title'] === 'doi');
      if (doiLink) doi = doiLink['@_href']?.replace('http://dx.doi.org/', '') ?? null;
    }

    const fragments: VerbatimFragment[] = [{
      // Preserve v0.6 id scheme: <arxiv_id>_c0 (the _c0 marks single-chunk;
      // multi-chunk arXiv papers were never produced by v0.6 since we only
      // ever index the abstract, never the full PDF).
      id: `${arxivId.replace(/[/.]/g, '_')}_c0`,
      text: abstract,
      source: `arXiv:${arxivId}`,
      title,
      doi,
      confidence: 0.7,
      arxiv_id: arxivId,
    }];

    return {
      fragments,
      // arXiv abstracts don't link to other arXiv papers in any
      // machine-readable way at this endpoint. Crawl expansion happens
      // when Wikipedia articles link to /abs/ URLs (handled by the
      // generic forager once it dispatches by owns()).
      outboundLinks: [],
      // arXiv abstracts are immutable after acceptance — they can get
      // a new version (v2, v3) but the previous version stays. 30 days
      // matches v0.6's TTL and is conservative.
      refreshPolicy: { ttlSeconds: 30 * 24 * 3600 },
    };
  }
}

export const arxivSource = new ArxivSource();
