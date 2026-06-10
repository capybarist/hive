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
  /** v1.x — extensible structured metadata (FragmentV08.meta). Carried into
   *  the signed fragment verbatim; core never interprets it. */
  meta?: Record<string, unknown>;
}

/**
 * v0.9 — self-describing metadata for the ForagerRegistry.
 *
 * One descriptor per adapter is the single source of truth that manifest
 * validation, the Settings source-picker (UI), source_type/lang derivation and
 * the source-aware dashboard all derive from — replacing the adapter lists that
 * used to be hardcoded in five disconnected places (api_server VALID_ADAPTERS,
 * ui ADAPTER_CONFIG + sourceIcon, extractor sourceTypeFor/langFor + if-ladder,
 * schema_v08 DEFAULT_TTL key, bee_manifest default). Third-party foragers
 * become first-class by shipping a descriptor + registering — no core edits.
 */
export type ForagerKind =
  /** seed(query/terms) → fetch; no link frontier (PubMed, arXiv, RSS, Web). */
  | 'search'
  /** BFS over a link frontier persisted in CrawlQueue (Wikipedia, Common Crawl). */
  | 'crawl'
  /** Authoritative registry enumerates every document (CatalogSource):
   *  sweeps are complete + verifiable, change detection by content_hash. */
  | 'catalog';

/** How the UI renders a scope field and (de)serialises it to `scope[field]`. */
export type ScopeInput =
  | 'text'        // single string  → scope[field] = "value"
  | 'csv'         // comma list      → scope[field] = ["a","b"]
  | 'lines'       // one-per-line    → scope[field] = ["a","b"]
  | 'multiselect' // checkbox list from `options` → scope[field] = ["a","b"] (chosen)
  | 'none';       // adapter takes no operator-provided scope

/** One choice in a `multiselect` scope field. */
export interface ScopeOption {
  value: string;
  label: string;
  /** Optional hint shown under the choice (e.g. where the data is read from). */
  help?: string;
}

export interface ForagerScopeSchema {
  /** Manifest scope key this field writes, e.g. 'terms', 'category_tree'. */
  field: string;
  label: string;
  placeholder: string;
  input: ScopeInput;
  help?: string;
  /** Choices for `input: 'multiselect'`. Ignored otherwise. */
  options?: ScopeOption[];
  /** Default selection for `multiselect` when the manifest doesn't set the field. */
  defaultSelected?: string[];
  /** Legacy scope key to also read when displaying (e.g. pubmed 'query' → terms). */
  aliasField?: string;
  /**
   * If true, the extractor rotates ONE entry of this (array) scope field per
   * cycle and uses it as the seed query — so a multi-entry bee keeps pulling
   * fresh content across all entries instead of replateauing on one. Used for
   * pubmed `terms`, rss `feeds`, cc `domains`. False/absent ⇒ the field is a
   * filter (arxiv `categories`), not a rotated query.
   */
  rotates?: boolean;
}

export interface ForagerDescriptor {
  id: string;
  displayName: string;
  /** Emoji used in the UI source chips / picker. */
  icon: string;
  kind: ForagerKind;
  /** v0.8 fragment `source_type` (also the DEFAULT_TTL key in @hive/core). */
  sourceType: string;
  /** Default content languages when the manifest doesn't override. */
  defaultLanguages: string[];
  /** How many seed URLs to request per cycle for a `search` source (default 5). */
  seedLimit?: number;
  /** Scope-field schema for the Settings picker; null = no operator scope. */
  scope: ForagerScopeSchema | null;
}

/**
 * Options for the seed phase — a one-shot search to bootstrap the crawl
 * frontier when the queue is empty.
 */
export interface SeedOptions {
  query: string;
  limit?: number;
  /**
   * Source-specific scope hints, copied verbatim from the bee's manifest
   * `DeclaredSource.scope`. Lets the adapter narrow the search at seed time
   * (arXiv: `scope.categories` as a category filter; Common Crawl: `domains` /
   * `snapshot`; RSS: `feeds`). Optional — adapters that don't recognise any
   * keys ignore it.
   */
  scope?: Record<string, unknown>;
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
   * v0.9 — self-describing metadata for the ForagerRegistry. Must be pure and
   * cheap (no I/O): it's called to build manifest validation, the UI picker and
   * the dashboard. See {@link ForagerDescriptor}.
   */
  describe(): ForagerDescriptor;

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

  /**
   * v0.7.6 — enumerate the partitions available for a given scope.
   *
   * Partitions are sub-units of a scope that bees can claim independently
   * so multiple bees on the same scope can split work without overlapping.
   *
   * The partitions must live INSIDE the scope, never cut across it.
   * Otherwise drift control (policy=exclusive) becomes incoherent: a bee
   * claiming an alphabetical bucket "A-G" over the entire Wikipedia
   * would receive Aspirin (in-scope for a Medicine bee) AND Aardvark
   * (out-of-scope), so it would reject 99% of its assigned work.
   *
   * Per-adapter conventions:
   *   - WikipediaSource: if scope.category_tree set, returns subcategories
   *     of that tree; otherwise returns ["A-G", "H-N", "O-Z"] (alphabetical).
   *   - ArxivSource:     if scope.categories set, returns sub-categories
   *     (cs.LG → cs.LG.* etc.); otherwise returns top-level groups.
   *   - CommonCrawlSource: if scope.domains set, returns each domain as a
   *     partition; otherwise groups by TLD.
   *   - RssSource:       each declared feed is its own partition.
   *
   * Returning a single-element list ["*"] means the source is not
   * partitionable at this scope; the operator can still claim the whole
   * scope but won't be able to split it across multiple bees.
   */
  partitions(scope?: Record<string, unknown>): string[] | Promise<string[]>;

  /**
   * v0.7.6 — does this URL fall inside the given partition?
   *
   * Called by the forager after fetch() returns outboundLinks. Links
   * outside the partition are dropped (under policy=exclusive) or
   * forwarded to whichever bee claims that partition (future v0.7.x).
   *
   * Default behaviour for adapters that don't implement this: every URL
   * is "in partition" (no partition-level filtering). Concrete adapters
   * override for the partition shapes they emit.
   */
  isInPartition?(url: string, scope: Record<string, unknown> | undefined, partition: string): boolean | Promise<boolean>;
}

// ── CatalogSource (v1.x — direct mode, docs/direct-mode.md §4) ──────────────

/** One document in an authoritative catalog. */
export interface CatalogEntry {
  /** Stable identifier within the source (the inventory key). */
  sourceId: string;
  url: string;
  /** ISO date, when the catalog provides it (lets changedSince avoid fetches). */
  lastModified?: string;
}

/**
 * A ForagerSource over a *catalogued* corpus: an authoritative registry can
 * enumerate every document and report changes — unlike frontier sources
 * (Wikipedia) that discover documents by following links. This makes
 * completeness verifiable: after a full sweep, diff(catalog ids, local
 * inventory ids) must be empty. The sweep loop lives in catalog_sweep.ts.
 *
 * Naming note: the spec sketches `fetch(entry) → RawDocument`, but
 * ForagerSource already owns `fetch(url) → FetchResult` with an incompatible
 * signature, so the per-entry fetch is `fetchEntry` and reuses FetchResult
 * (the existing verbatim-fragment envelope) instead of a new RawDocument type.
 */
export interface CatalogSource extends ForagerSource {
  /** Enumerate the complete catalog. */
  listAll(): AsyncIterable<CatalogEntry>;
  /** Enumerate entries changed since `date` (incremental sweeps). Err on the
   *  inclusive side (>=, or a small overlap window): over-reporting is free —
   *  the sweep's content_hash check skips unchanged docs — while
   *  under-reporting silently loses updates. */
  changedSince(date: Date): AsyncIterable<CatalogEntry>;
  /** Fetch one catalogued document as verbatim fragments. */
  fetchEntry(entry: CatalogEntry): Promise<FetchResult>;
}

export function isCatalogSource(s: ForagerSource): s is CatalogSource {
  const c = s as Partial<CatalogSource>;
  return typeof c.listAll === 'function'
    && typeof c.changedSince === 'function'
    && typeof c.fetchEntry === 'function';
}
