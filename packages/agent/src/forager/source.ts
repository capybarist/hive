/**
 * ForagerSource — v0.7 source-driven extraction interface.
 *
 * Every source HIVE knows how to extract from — Wikipedia, arXiv, RSS feeds,
 * Common Crawl snapshots, future ones — implements this single interface.
 * The generic forager (autonomous_extractor) owns the queue, dedup,
 * budgeting, signing, and storage. Adapters just talk to their specific
 * endpoint and return verbatim fragments + outbound URLs to crawl next.
 *
 * Design notes:
 *
 * 1. **Verbatim only.** The text in each VerbatimFragment must be a
 *    byte-for-byte copy of what the source returned. No LLM has touched
 *    it. The downstream ed25519 signature is only meaningful under this
 *    invariant.
 *
 * 2. **URL is the public identity.** Every adapter accepts and returns
 *    URLs. Source-specific identifiers (Wikipedia titles, arXiv IDs)
 *    stay encapsulated inside each adapter. This keeps the queue and the
 *    cross-source dispatch (`owns(url)`) generic.
 *
 * 3. **No I/O on construction.** Adapters are cheap to instantiate.
 *    Long-running setup (HTTP clients, parsers) lives in module scope or
 *    behind lazy fields. Lets us list/route adapters without waking them.
 *
 * 4. **Idempotent fetch.** Calling `fetch(url)` twice for the same URL
 *    must return the same fragment IDs. Determinism here is what makes
 *    the v0.6 dedup-by-id mechanism in autonomous_extractor work.
 */

/**
 * One unit of verbatim content extracted from a source. The text is
 * byte-for-byte from the source API; no LLM has touched it. Signing
 * happens downstream when the autonomous_extractor calls store.save().
 */
export interface VerbatimFragment {
  /** Deterministic per (source, URL, section). Re-fetching produces the same id. */
  id: string;
  /** Byte-for-byte from the source. */
  text: string;
  /** Canonical URL of the parent document this fragment came from. */
  source: string;
  /** Human-readable title for display. */
  title?: string;
  /** Populated for DOI-bearing sources (arXiv, CrossRef). null otherwise. */
  doi: string | null;
  /** 0..1 source-specific quality signal. Wikipedia uses ~0.9, arXiv ~0.85, RSS ~0.7. */
  confidence: number;
  /** Populated for arXiv papers; used by downstream filters. */
  arxiv_id?: string;
}

/**
 * Options for the seed phase — a one-shot search to bootstrap the crawl
 * frontier when the queue is empty.
 */
export interface SeedOptions {
  query: string;
  limit?: number;
}

/**
 * Result of fetching one URL.
 */
export interface FetchResult {
  /** Verbatim fragments emitted from this URL, in source order. */
  fragments: VerbatimFragment[];
  /** URLs this source owns and wants the forager to crawl next. */
  outboundLinks: string[];
  /** How long fragments from this URL stay fresh before re-fetch is worthwhile. */
  refreshPolicy: { ttlSeconds: number };
}

/**
 * A source the forager knows how to extract from. v0.7's source-driven
 * model treats every source uniformly behind this interface.
 */
export interface ForagerSource {
  /** Canonical identifier, e.g. "wikipedia-en", "arxiv", "common-crawl-2026-04". */
  readonly id: string;
  /** Human-readable name for UI / logs. */
  readonly displayName: string;
  /** SPDX-like licence string. Tracked per-source so consumers can filter. */
  readonly licence: string;

  /**
   * Bootstrap a crawl by turning a search query into a list of URLs this
   * source owns. Used when the persistent crawl queue is empty.
   */
  seed(opts: SeedOptions): Promise<string[]>;

  /**
   * Fetch one URL, emit verbatim fragments, discover outbound links.
   * Throws on transient failures (network, 5xx); the forager handles
   * retries. Returns successfully with `fragments: []` if the URL is
   * reachable but produced no usable content (e.g. a stub article).
   */
  fetch(url: string): Promise<FetchResult>;

  /**
   * Normalise a URL to canonical form (strip fragment, resolve casing,
   * drop tracking params). Same physical document → same canonical URL.
   */
  normalize(url: string): string;

  /**
   * True if this URL belongs to this source. Used by the generic
   * forager to dispatch a discovered link to the right adapter.
   */
  owns(url: string): boolean;
}
