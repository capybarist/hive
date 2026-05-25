/**
 * RssSource — RSS / Atom feeds as ForagerSource.
 *
 * Maps v0.6's `rss_fetch` to the source-driven interface.
 *
 * RSS doesn't quite fit the URL-as-unit model of Wikipedia and arXiv:
 * the unit of crawl is the **feed URL** (one HTTP call yields N items).
 * We model that by having `fetch(feedUrl)` return the items as
 * fragments. `seed(opts)` returns the feed URL itself wrapped in an
 * array — the autonomous extractor's RSS branch passes the feed URL
 * directly through to fetch().
 *
 * Source-of-truth list of feeds: HIVE_AUX_RSS_FEEDS env var (comma
 * separated), with the same default as v0.6 (BBC + Reuters). The
 * adapter is stateless; the extractor decides which feed to use.
 *
 * Behaviour preserved bit-for-bit from v0.6 rss_fetch:
 *   - Same User-Agent.
 *   - Same XML parser config (fast-xml-parser, attributeNamePrefix '@_').
 *   - Same body extraction order (content:encoded → content → description
 *     → summary).
 *   - Same minimum-body filter (80 chars).
 *   - Same fragment id (`rss_<feedHost>_<titleSlug>`) and confidence (0.85).
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';

const USER_AGENT = 'HIVE/0.7 (knowledge crawler; mailto:capy@capybaralabs.tech)';
const MIN_BODY_LEN = 80;
const DEFAULT_FETCH_LIMIT = 15;

// Same minimal entity table the Wikipedia adapter uses, plus a few
// extras frequently emitted by RSS publishers.
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
  '&laquo;': '«', '&raquo;': '»', '&lsquo;': "'", '&rsquo;': "'",
  '&ldquo;': '"', '&rdquo;': '"',
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

export class RssSource implements ForagerSource {
  readonly id = 'rss';
  readonly displayName = 'RSS feed';
  // RSS feeds are publisher-dependent. We don't track per-feed licences
  // here; consumers should treat fragments at "publisher-defined" terms.
  readonly licence = 'publisher-defined';

  normalize(url: string): string {
    // Strip #fragment but preserve query string — many feed URLs carry
    // meaningful ?param=value identifiers (e.g. RSS feed aggregators).
    return url.split('#')[0]!;
  }

  /**
   * RSS feed URLs are operator-configured via env (HIVE_AUX_RSS_FEEDS).
   * We can't infer feed-ness from a URL alone (anything ending in .xml,
   * .rss, /feed, /rss, etc. is a hint, not a guarantee). Returning false
   * means the generic forager never dispatches a random discovered URL
   * to this adapter — the autonomous extractor's RSS branch passes feed
   * URLs through explicitly.
   */
  owns(_url: string): boolean {
    return false;
  }

  /**
   * v0.7.6 — partitions for RSS.
   *
   * Each declared feed is its own partition. If scope.feeds is set, each
   * feed URL becomes a partition string; bees coordinating on a multi-feed
   * deployment can claim one feed each. Without a scope, returns ["*"]
   * (no partitioning possible — the feed list is unknown).
   */
  partitions(scope?: Record<string, unknown>): string[] {
    const feeds = scope?.feeds;
    if (Array.isArray(feeds) && feeds.length > 0) {
      return feeds.filter((f): f is string => typeof f === 'string');
    }
    return ['*'];
  }

  isInPartition(url: string, _scope: Record<string, unknown> | undefined, partition: string): boolean {
    if (partition === '*') return true;
    // A feed-URL partition matches if the fetched URL equals the partition
    // (RSS fragments carry the feed URL as their source via the bridge).
    return this.normalize(url) === this.normalize(partition);
  }

  /**
   * For RSS, `opts.query` is the feed URL itself. seed returns [feedUrl]
   * (one element) so the caller can iterate uniformly with the other
   * adapters' seed → URL → fetch pattern.
   */
  async seed(opts: SeedOptions): Promise<string[]> {
    return [this.normalize(opts.query)];
  }

  async fetch(url: string): Promise<FetchResult> {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status} for ${url}`);
    const xml = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    // RSS 2.0 lives under rss.channel; Atom under feed. Both modelled.
    const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
    const rawItems = channel?.item ?? channel?.entry ?? [];
    const items: any[] = Array.isArray(rawItems) ? rawItems : [rawItems];

    const feedHost = hostnameFromUrl(url);
    const fragments: VerbatimFragment[] = [];

    for (const item of items.slice(0, DEFAULT_FETCH_LIMIT)) {
      // Prefer the richest field available. v0.6 rss_fetch order:
      // content:encoded → content → description → summary.
      const fullContent = item['content:encoded']
        ?? item.content?.['#text']
        ?? item.content
        ?? '';
      const description = typeof item.description === 'string'
        ? item.description
        : item.description?.['#text']
            ?? item.summary?.['#text']
            ?? item.summary
            ?? '';
      const bodyText = decodeHtmlEntities(
        String(fullContent || description).replace(/<[^>]+>/g, ''),
      ).replace(/\s+/g, ' ').trim();

      const title = (typeof item.title === 'string'
        ? item.title
        : item.title?.['#text'] ?? item.title?.['_'] ?? '').toString().trim();

      if (!title || bodyText.length < MIN_BODY_LEN) continue;

      // Atom uses link as an object with @_href; RSS uses a plain string.
      const link = (item.link?.['@_href']
        ?? (typeof item.link === 'string' ? item.link : '')
        ?? item.id
        ?? url) as string;

      fragments.push({
        id: `rss_${feedHost}_${slugify(title)}`,
        text: bodyText,
        source: link,
        title,
        doi: null,
        confidence: 0.85,
      });
    }

    return {
      fragments,
      // RSS items are individual articles; the feed itself doesn't expose
      // outbound URLs we'd want to crawl. Discovered article URLs go into
      // the `source` field of each fragment — the consumer can follow
      // them with the WebSource if desired.
      outboundLinks: [],
      // News-rate content. v0.6 used 24h TTL; same here.
      refreshPolicy: { ttlSeconds: 24 * 3600 },
    };
  }
}

export const rssSource = new RssSource();
