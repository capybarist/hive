/**
 * WebSource — arbitrary web pages as ForagerSource.
 *
 * The catch-all adapter. When a Wikipedia article or RSS feed item links
 * to a page outside the specialised adapters (Wikipedia, arXiv), the
 * generic forager dispatches the URL here. WebSource fetches the HTML,
 * strips tags, chunks, emits one fragment per chunk.
 *
 * Behaviour preserved from v0.6's `web_fetch` tool:
 *   - Same User-Agent.
 *   - Same chunking thresholds (200 token chunks, 40 overlap; v0.6
 *     numbers — smaller than Wikipedia's 350/50 because random-web pages
 *     tend to be less structured).
 *   - Same 30 KB text cap.
 *   - Same fragment id (`web_<host>_<titleSlug>_c<chunk>`) and default
 *     confidence (0.7).
 *
 * Differences from v0.6 web_fetch:
 *   - No `confidence` parameter — adapter clients can layer their own
 *     filter if they need to. v0.6's call sites always used 0.7.
 *   - owns() returns true for plain HTTP(S) URLs that don't fall to
 *     a more specific adapter. The generic forager dispatches
 *     "everything else" here.
 */

import { chunkText } from '../text_chunker.js';
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';

const USER_AGENT = 'HIVE/0.7 (research crawler; mailto:capy@capybaralabs.tech)';
const MAX_TEXT_CHARS = 30_000;
const CHUNK_MAX_TOKENS = 200;
const CHUNK_OVERLAP = 40;
const DEFAULT_CONFIDENCE = 0.7;

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

export class WebSource implements ForagerSource {
  readonly id = 'web';
  readonly displayName = 'Generic web';
  // The web is everything; we tag this "site-defined" since each page
  // carries its own terms. Consumers should treat the source URL as the
  // source of truth for re-verification.
  readonly licence = 'site-defined';

  describe() {
    return {
      id: 'web',
      displayName: this.displayName,
      icon: '🔗',
      kind: 'crawl' as const,
      sourceType: 'custom',
      defaultLanguages: ['en'],
      scope: {
        field: 'domains',
        label: 'Domains (one per line, optional)',
        placeholder: 'pubmed.ncbi.nlm.nih.gov',
        input: 'lines' as const,
        help: 'Leave empty for unrestricted web crawl',
      },
    };
  }

  normalize(url: string): string {
    return url.split('#')[0]!;
  }

  /**
   * Catch-all for any HTTP(S) URL not claimed by a more specific adapter.
   * The generic forager calls owns() on each adapter in priority order
   * (Wikipedia, arXiv, RSS, …) and lands here only if none claimed.
   * We exclude non-HTTP schemes and anything that's already owned by a
   * specialised adapter — but checking the specialised adapters here
   * would create a cycle, so we keep it permissive: any http(s) URL.
   */
  owns(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** The generic web isn't partitionable — it has no enumerable scope. */
  partitions(_scope?: Record<string, unknown>): string[] {
    return ['*'];
  }

  /**
   * No notion of "search" for the generic web. seed returns an empty
   * list — the WebSource only handles URLs dispatched from other
   * adapters (Wikipedia outbound links, RSS article URLs) or from the
   * persistent crawl queue.
   */
  async seed(_opts: SeedOptions): Promise<string[]> {
    return [];
  }

  async fetch(url: string): Promise<FetchResult> {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const html = await res.text();

    const stripHtml = (s: string) =>
      decodeHtmlEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const text = stripHtml(html).slice(0, MAX_TEXT_CHARS);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? stripHtml(titleMatch[1]!).slice(0, 200) : undefined;

    if (!text || text.length < MAX_TEXT_CHARS / 200) {
      return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 3 * 24 * 3600 } };
    }

    const host = hostnameFromUrl(url);
    const slug = slugify(pageTitle ?? url.replace(/^https?:\/\//, ''));
    const chunks = chunkText(text, CHUNK_MAX_TOKENS, CHUNK_OVERLAP);

    const fragments: VerbatimFragment[] = chunks.map((c) => ({
      id: `web_${host}_${slug}_c${c.index}`,
      text: c.text,
      source: this.normalize(url),
      title: pageTitle,
      doi: null,
      confidence: DEFAULT_CONFIDENCE,
    }));

    return {
      fragments,
      // WebSource doesn't currently extract outbound links — the v0.6
      // web_fetch tool didn't either. A future v0.7.x could add a
      // <a href="..."> extractor here for breadth-first crawling, but
      // it would need much stronger rate-limit + scope guards than the
      // structured-source adapters need.
      outboundLinks: [],
      // 3 days matches v0.6's web TTL.
      refreshPolicy: { ttlSeconds: 3 * 24 * 3600 },
    };
  }
}

export const webSource = new WebSource();
