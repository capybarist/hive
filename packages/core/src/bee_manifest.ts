/**
 * BeeManifest — v0.7.3 source-driven identity for a BEE node.
 *
 * Every BEE publishes a manifest at startup, stored under 'bee:manifest'
 * in its Hyperbee (backed by its Hypercore). Queens read it when they
 * open a remote core and build the /api/directory from collected manifests.
 *
 * The manifest is self-sovereign: no central registry approves it.
 * Queens observe discrepancies between declared and actual coverage;
 * they do not enforce conformance.
 */

export interface DeclaredSource {
  /** Canonical adapter id: "wikipedia-en" | "arxiv" | "rss" | "web" */
  id: string;
  /** Adapter-specific runtime config (language, feed URLs, arXiv categories…) */
  config?: Record<string, unknown>;
  /**
   * Optional constraint within the source.
   * Wikipedia: { category_tree: "Category:Medicine" }
   * arXiv:     { categories: ["cs.AI", "stat.ML"] }
   * RSS:       { feeds: ["https://example.com/rss"] }
   * Omit to cover the full source (drift-ok behaviour).
   */
  scope?: Record<string, unknown>;
  /**
   * What the forager does with links that fall outside `scope`:
   *   "drift-ok"  — follow anyway (v0.6 behaviour, default)
   *   "exclusive" — drop out-of-scope links; specialist bee
   * Category-tree enforcement for Wikipedia requires v0.7.4+;
   * until then "exclusive" is recorded but treated as "drift-ok".
   */
  policy: 'drift-ok' | 'exclusive';
}

export interface BeeManifest {
  /** ed25519 public key (node ID) of the publishing BEE. */
  bee_id: string;
  /** Free-text operator name / contact. Not validated. */
  operator?: string;
  /** Sources this BEE has committed to extract from. */
  declared_sources: DeclaredSource[];
  /** BCP-47 language codes this BEE targets. */
  declared_languages: string[];
  /**
   * Bee↔bee replication topology:
   *   "all"       — replicate every peer found via DHT (v0.6 default)
   *   "neighbors" — replicate peers whose scope overlaps (v0.7.6+)
   *   "none"      — producer-only, no peer replication
   */
  replication: 'none' | 'neighbors' | 'all';
  /** HIVE binary version at publish time. */
  version: string;
  /** ISO timestamp when this manifest was written. */
  published_at: string;
}

/**
 * Build DeclaredSource list from environment variables.
 *
 * HIVE_SOURCES  — comma-separated adapter ids (default: "wikipedia-en")
 * HIVE_POLICY   — "drift-ok" | "exclusive" applied to all sources (default: "drift-ok")
 * HIVE_SCOPE    — JSON scope object applied to all sources (default: none)
 */
export function buildDeclaredSources(): DeclaredSource[] {
  const ids = (process.env.HIVE_SOURCES ?? 'wikipedia-en')
    .split(',').map(s => s.trim()).filter(Boolean);
  const policy = (['drift-ok', 'exclusive'].includes(process.env.HIVE_POLICY ?? '')
    ? process.env.HIVE_POLICY
    : 'drift-ok') as DeclaredSource['policy'];
  let scope: Record<string, unknown> | undefined;
  if (process.env.HIVE_SCOPE) {
    try { scope = JSON.parse(process.env.HIVE_SCOPE); } catch {
      console.warn('[manifest] HIVE_SCOPE is not valid JSON — ignored');
    }
  }
  return ids.map(id => ({ id, ...(scope ? { scope } : {}), policy }));
}
