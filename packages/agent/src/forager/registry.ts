/**
 * ForagerRegistry — the single source of truth for "what sources HIVE knows".
 *
 * Before v0.9 the set of adapters was duplicated across five disconnected
 * places (api_server `VALID_ADAPTERS`, ui `ADAPTER_CONFIG`/`sourceIcon`,
 * extractor `sourceTypeFor`/`langFor` + the per-source if-ladder, schema_v08
 * `DEFAULT_TTL` keys, bee_manifest default). Adding a source meant editing all
 * of them and silently breaking when one was missed (the `pubmed` ship missed
 * `VALID_ADAPTERS` → "Unknown adapter").
 *
 * Now every adapter ships a {@link ForagerDescriptor} via `describe()` and is
 * listed here once. Manifest validation, the Settings picker (over
 * `/api/sources`), source_type/lang, TTL and the source-aware dashboard all
 * derive from this registry. A third-party forager becomes first-class by
 * being added to `ALL` (or, later, pushed in at runtime) — no edits elsewhere.
 */
import type { ForagerSource, ForagerDescriptor } from './source.js';
import { wikipediaSource } from './wikipedia_source.js';
import { arxivSource } from './arxiv_source.js';
import { pubmedSource } from './pubmed_source.js';
import { rssSource } from './rss_source.js';
import { commonCrawlSource } from './common_crawl_source.js';
import { webSource } from './web_source.js';
import { claudeMemorySource } from './claude_memory_source.js';

/** The registered forager singletons. Order = display order in the UI picker. */
const ALL: ForagerSource[] = [
  wikipediaSource,
  arxivSource,
  pubmedSource,
  rssSource,
  commonCrawlSource,
  webSource,
  claudeMemorySource,
];

// Keyed by the *canonical* descriptor id (e.g. 'common-crawl'), which is what
// manifests and the UI use — distinct from the instance `.id`, which may carry
// a variant suffix (CommonCrawl's id is `common-crawl-<snapshot>`).
const BY_ID = new Map<string, ForagerSource>(ALL.map((s) => [s.describe().id, s]));

/** Register a forager at runtime (third-party adapters). Idempotent by id. */
export function registerForager(source: ForagerSource): void {
  const id = source.describe().id;
  if (!BY_ID.has(id)) ALL.push(source);
  BY_ID.set(id, source);
}

/** Look up a forager by its canonical adapter id. */
export function getForager(id: string): ForagerSource | undefined {
  return BY_ID.get(id);
}

/** All registered forager instances, in display order. */
export function listForagers(): ForagerSource[] {
  return [...ALL];
}

/** All adapter descriptors — the UI picker, validation and TTL derive from these. */
export function listDescriptors(): ForagerDescriptor[] {
  return ALL.map((s) => s.describe());
}

/** Valid adapter ids — canonical descriptor ids (replaces `VALID_ADAPTERS`). */
export function validAdapterIds(): string[] {
  return ALL.map((s) => s.describe().id);
}

/** Descriptor for one adapter id, if registered. */
export function describeForager(id: string): ForagerDescriptor | undefined {
  return BY_ID.get(id)?.describe();
}
