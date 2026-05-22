/**
 * WikipediaSource — v0.7.1 reference implementation of ForagerSource.
 *
 * Wraps the Wikipedia REST API (action=parse) the way the v0.6
 * `wikipedia_fetch` tool did, but exposed through the source-driven
 * interface so the generic forager can treat it uniformly with arXiv,
 * RSS, Common Crawl, etc. in v0.7.2+.
 *
 * Behaviour is bit-for-bit identical to v0.6's wikipedia_fetch tool:
 *
 *   - Same User-Agent (so Wikipedia's request-limit policy continues to
 *     class us correctly).
 *   - Same chunking thresholds (1500 chars to trigger, 350-token chunks
 *     with 50-token overlap via text_chunker).
 *   - Same fragment id scheme `wiki_<articleSlug>_<sectionSlug>[_cN]` so
 *     downstream dedup-by-id in autonomous_extractor matches existing
 *     Hypercore entries (no rewrite-storm after migration).
 *   - Same SKIP_SECTIONS, same H2/H3 hierarchy, same link extraction.
 *
 * The differences vs `tools_registry.ts::wikipedia_fetch`:
 *
 *   1. Returns fragments + outboundLinks instead of calling onFragment /
 *      onCrawlEnqueue side-effect callbacks.
 *   2. Public API speaks URLs, not titles. Titles are encapsulated.
 *   3. Outbound links are emitted as full Wikipedia URLs (in v0.6 they
 *      were titles, which the queue stored directly). The
 *      autonomous_extractor bridges this until v0.7.3 moves the queue
 *      itself to URL storage.
 */

import { chunkText } from '../text_chunker.js';
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const ARTICLE_URL_PREFIX = 'https://en.wikipedia.org/wiki/';
const USER_AGENT = 'HIVE/0.7 (research crawler; mailto:capy@capybaralabs.tech)';

// Match v0.6 wikipedia_fetch (tools_registry.ts).
const CHUNK_THRESHOLD = 1500;
const CHUNK_MAX_TOKENS = 350;
const CHUNK_OVERLAP = 50;
const MIN_FRAGMENT_LEN = 100;

const SKIP_SECTIONS = new Set([
  'references', 'see also', 'notes', 'external links',
  'further reading', 'bibliography', 'footnotes',
]);

// Wikipedia namespaces we never want to crawl (they're meta-pages, not articles).
const NON_ARTICLE_NAMESPACE = /^(File|Image|Template|Category|Help|Portal|Special|Wikipedia|Talk|User|Draft):/i;

// Minimal entity table — covers the entities Wikipedia's parser commonly
// emits in section text. Kept in sync with tools_registry.ts.
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
  '&laquo;': '«', '&raquo;': '»', '&lsquo;': "'", '&rsquo;': "'",
  '&ldquo;': '"', '&rdquo;': '"', '&deg;': '°', '&times;': '×',
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&[a-zA-Z]+;/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export class WikipediaSource implements ForagerSource {
  readonly id = 'wikipedia-en';
  readonly displayName = 'Wikipedia (English)';
  readonly licence = 'CC-BY-SA-4.0';

  /** Title → canonical article URL. Used by the bridge in autonomous_extractor. */
  urlFromTitle(title: string): string {
    return ARTICLE_URL_PREFIX + encodeURIComponent(title.trim().replace(/ /g, '_'));
  }

  /** Article URL → title. Returns null if the URL is not a Wikipedia article. */
  titleFromUrl(url: string): string | null {
    const normalised = this.normalize(url);
    if (!normalised.startsWith(ARTICLE_URL_PREFIX)) return null;
    const slug = normalised.slice(ARTICLE_URL_PREFIX.length);
    try {
      return decodeURIComponent(slug).replace(/_/g, ' ').trim();
    } catch {
      return null;
    }
  }

  normalize(url: string): string {
    // Strip #fragment and any query string; we always want the canonical
    // article URL. Wikipedia ignores query params for the parse endpoint
    // anyway so this is safe.
    return url.split('#')[0]!.split('?')[0]!;
  }

  owns(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.hostname !== 'en.wikipedia.org') return false;
      if (!u.pathname.startsWith('/wiki/')) return false;
      const slug = u.pathname.slice('/wiki/'.length);
      return !!slug && !NON_ARTICLE_NAMESPACE.test(decodeURIComponent(slug));
    } catch {
      return false;
    }
  }

  async seed(opts: SeedOptions): Promise<string[]> {
    // wikipedia_search via the MediaWiki API. Returns up to opts.limit
    // canonical article URLs (passing owns() trivially because they all
    // come from en.wikipedia.org).
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const params = new URLSearchParams({
      action: 'query', list: 'search', srsearch: opts.query,
      srlimit: String(limit), format: 'json', formatversion: '2',
    });
    const res = await fetch(`${WIKIPEDIA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`wikipedia_search: HTTP ${res.status}`);
    const data = await res.json() as any;
    const titles: string[] = (data?.query?.search ?? [])
      .map((h: any) => h.title as string)
      .filter(Boolean);
    return titles.map((t) => this.urlFromTitle(t));
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.owns(url)) throw new Error(`WikipediaSource: not a Wikipedia article URL: ${url}`);
    const title = this.titleFromUrl(url);
    if (!title) throw new Error(`WikipediaSource: cannot extract title from ${url}`);

    const params = new URLSearchParams({
      action: 'parse', page: title, prop: 'sections|text',
      format: 'json', redirects: '1', formatversion: '2',
    });
    const res = await fetch(`${WIKIPEDIA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Wikipedia API: HTTP ${res.status} for "${title}"`);
    const data = await res.json() as any;
    if (data?.error) throw new Error(`Wikipedia API: ${data.error.code} ${data.error.info}`);

    const parse = data?.parse;
    if (!parse?.text) return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 7 * 24 * 3600 } };

    const fullHtml: string = typeof parse.text === 'string' ? parse.text : (parse.text?.['*'] ?? '');
    const sections: Array<{ line: string; toclevel?: number }> = parse.sections ?? [];
    const resolvedTitle: string = parse.title ?? title;
    const resolvedSlug = slugify(resolvedTitle);
    const resolvedUrl = this.urlFromTitle(resolvedTitle);

    const clean = (html: string) =>
      decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

    // Outbound links: every /wiki/X href in the raw HTML, normalised to
    // canonical article URLs and filtered against owns() so caller never
    // sees File:/Category: etc.
    const outboundLinks = this._extractLinks(fullHtml, resolvedTitle, title);

    const fragments: VerbatimFragment[] = [];

    const emitSection = (slugPath: string, headingPath: string, rawText: string) => {
      if (rawText.length < MIN_FRAGMENT_LEN) return;
      if (rawText.length <= CHUNK_THRESHOLD) {
        fragments.push({
          id: `wiki_${resolvedSlug}_${slugPath}`,
          text: rawText,
          source: resolvedUrl,
          title: `${resolvedTitle} — ${headingPath}`,
          doi: null,
          confidence: 0.9,
        });
        return;
      }
      for (const chunk of chunkText(rawText, CHUNK_MAX_TOKENS, CHUNK_OVERLAP)) {
        fragments.push({
          id: `wiki_${resolvedSlug}_${slugPath}_c${chunk.index}`,
          text: chunk.text,
          source: resolvedUrl,
          title: `${resolvedTitle} — ${headingPath} (part ${chunk.index + 1})`,
          doi: null,
          confidence: 0.9,
        });
      }
    };

    // ── Lead / intro ──
    const h2Split = fullHtml.split(/<h2[^>]*>/);
    const leadText = clean(h2Split[0] ?? '');
    emitSection('intro', 'Introduction', leadText);

    // ── Top-level sections (H2), each split further by H3 ──
    const topLevel = sections.filter((s) => s.toclevel === 1);
    for (let i = 0; i < h2Split.length - 1; i++) {
      const sectionHtml = h2Split[i + 1]!;
      const sectionMeta = topLevel[i];
      if (!sectionMeta) continue;
      const sTitle = clean(sectionMeta.line ?? '');
      if (!sTitle || SKIP_SECTIONS.has(sTitle.toLowerCase())) continue;
      const sSlug = slugify(sTitle);

      const h3Split = sectionHtml.split(/<h3[^>]*>/);
      emitSection(sSlug, sTitle, clean(h3Split[0] ?? ''));

      for (let j = 1; j < h3Split.length; j++) {
        const subClean = clean(h3Split[j]!);
        const headingGuess = subClean.split(/[.,;]/)[0]?.slice(0, 60).trim() || `subsection-${j}`;
        const subSlug = slugify(headingGuess) || `sub${j}`;
        emitSection(`${sSlug}_${subSlug}`, `${sTitle} → ${headingGuess}`, subClean);
      }
    }

    return {
      fragments,
      outboundLinks,
      // Wikipedia is updated continuously; v0.6 TTL of 7 days has held up
      // well — re-fetches catch substantive edits without thrashing.
      refreshPolicy: { ttlSeconds: 7 * 24 * 3600 },
    };
  }

  /**
   * Extract /wiki/X links from raw HTML, returning canonical article URLs.
   * Filters out the article we just fetched (no self-loops) and non-article
   * namespaces (File:, Category:, …).
   */
  private _extractLinks(html: string, resolvedTitle: string, requestedTitle: string): string[] {
    const out = new Set<string>();
    const re = /href="\/wiki\/([^"#:?]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = decodeURIComponent(m[1]!).replace(/_/g, ' ').trim();
      if (!raw || raw.length > 120) continue;
      if (NON_ARTICLE_NAMESPACE.test(raw)) continue;
      if (raw === resolvedTitle || raw === requestedTitle) continue;
      out.add(this.urlFromTitle(raw));
    }
    return [...out];
  }
}

/** Singleton — adapters are stateless, no need to construct per call. */
export const wikipediaSource = new WikipediaSource();
