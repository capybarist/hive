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

  /**
   * v0.7.6 — partitions over the arXiv taxonomy.
   *
   * If scope.categories is set (e.g. ["cs.*"]), each category becomes its
   * own partition. So three bees on scope=cs.* can pick cs.LG / cs.AI /
   * cs.CL respectively without overlap, and each one's outbound URLs are
   * all within scope=cs.*.
   *
   * Without a scope, partitions are the seven canonical arXiv top-level
   * categories — generalist bees can split by domain.
   */
  partitions(scope?: Record<string, unknown>): string[] {
    const cats = scope?.categories;
    if (Array.isArray(cats) && cats.length > 0) {
      // Expand wildcards (e.g. "cs.*" → returned as-is; the actual leaf
      // breakdown happens at seed time and isn't enumerable cheaply here).
      // Operator declares concrete sub-categories if they want finer splits.
      const expanded: string[] = [];
      for (const c of cats) {
        if (typeof c !== 'string') continue;
        if (c.endsWith('.*')) {
          // Common arXiv leaves for the major roots. This is intentionally
          // a curated list rather than a live API call — arXiv doesn't
          // expose a "list subcategories" endpoint, and the leaves are
          // stable enough that hardcoding is fine.
          const root = c.slice(0, -2);
          const map: Record<string, string[]> = {
            cs:      ['cs.AI', 'cs.CL', 'cs.CR', 'cs.CV', 'cs.DC', 'cs.DS', 'cs.LG', 'cs.NE', 'cs.PL', 'cs.RO', 'cs.SE'],
            math:    ['math.AG', 'math.AT', 'math.CA', 'math.CO', 'math.DG', 'math.NT', 'math.PR', 'math.ST'],
            physics: ['physics.atom-ph', 'physics.bio-ph', 'physics.chem-ph', 'physics.optics', 'physics.plasm-ph'],
            'q-bio': ['q-bio.BM', 'q-bio.CB', 'q-bio.GN', 'q-bio.NC', 'q-bio.QM'],
            stat:    ['stat.AP', 'stat.ME', 'stat.ML', 'stat.TH'],
            econ:    ['econ.EM', 'econ.GN', 'econ.TH'],
          };
          if (map[root]) expanded.push(...map[root]!);
          else expanded.push(c); // unknown root → keep as-is, no leaf split
        } else {
          expanded.push(c);
        }
      }
      return expanded.length > 0 ? expanded : ['*'];
    }
    // Generalist: top-level groups as partitions.
    return ['cs', 'math', 'physics', 'q-bio', 'q-fin', 'stat', 'econ'];
  }

  /**
   * v0.7.6 — does this paper URL fall in the partition?
   *
   * arXiv categories are encoded in the entry metadata, not the URL. We do
   * a best-effort using the legacy URL format (e.g. /abs/cs.LG/0123456)
   * which carries the category in the path. Modern URLs (/abs/2501.12345)
   * don't expose the category — those return true and the seed-time filter
   * does the actual narrowing.
   */
  isInPartition(url: string, _scope: Record<string, unknown> | undefined, partition: string): boolean {
    if (partition === '*') return true;
    const arxivId = this.arxivIdFromUrl(url);
    if (!arxivId) return false;
    // Legacy IDs: "cs.LG/0123456" — category in the prefix.
    const legacyMatch = arxivId.match(/^([a-z-]+(\.[A-Z][a-zA-Z-]+)?)\//);
    if (legacyMatch) {
      const cat = legacyMatch[1]!;
      return cat === partition || cat.startsWith(partition + '.');
    }
    // Modern IDs (post-2007) don't carry category in the URL. The seed
    // filter handles narrowing; here we conservatively accept.
    return true;
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
