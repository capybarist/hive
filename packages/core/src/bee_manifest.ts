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
  /**
   * v0.7.6 — bucket of work this bee claims inside (source, scope).
   *
   * Partitions are sub-units of the scope that bees claim independently
   * so multiple bees on the same scope can split work without overlap.
   * The adapter's `partitions(scope)` method enumerates valid values.
   *
   * Examples:
   *   Wikipedia + scope.category_tree="Category:Medicine" → "Category:Pharmacology"
   *   arXiv     + scope.categories=["cs.*"]               → "cs.LG"
   *   CC        + scope.domains=[…]                       → "pubmed.ncbi.nlm.nih.gov"
   *
   * Omit when there's only one bee on this source, or when the source
   * isn't partitionable at the declared scope. Coordination is opt-in.
   */
  partition?: string;
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
 * HIVE_SOURCES   — comma-separated adapter ids (default: "wikipedia-en")
 * HIVE_POLICY    — "drift-ok" | "exclusive" applied to all sources (default: "drift-ok")
 * HIVE_SCOPE     — JSON scope object. Either a single object applied to
 *                  all sources, or a map { "<source_id>": {…}, … } per-source.
 * HIVE_PARTITION — v0.7.6 — JSON map { "<source_id>": "<partition_key>", … }
 *                  or a plain string applied to the only declared source.
 *                  Coordination unit when multiple bees split a scope.
 */
export function buildDeclaredSources(): DeclaredSource[] {
  const ids = (process.env.HIVE_SOURCES ?? 'wikipedia-en')
    .split(',').map(s => s.trim()).filter(Boolean);
  const policy = (['drift-ok', 'exclusive'].includes(process.env.HIVE_POLICY ?? '')
    ? process.env.HIVE_POLICY
    : 'drift-ok') as DeclaredSource['policy'];

  // Scope: accept either a flat object (applied to all sources) or a per-source
  // map { id: scopeObj }. The latter is needed when a bee declares mixed
  // sources (e.g. wikipedia + arxiv) with different scope shapes.
  let scopeRaw: any = undefined;
  if (process.env.HIVE_SCOPE) {
    try { scopeRaw = JSON.parse(process.env.HIVE_SCOPE); } catch {
      console.warn('[manifest] HIVE_SCOPE is not valid JSON — ignored');
    }
  }
  const scopeFor = (id: string): Record<string, unknown> | undefined => {
    if (!scopeRaw || typeof scopeRaw !== 'object') return undefined;
    // Per-source map: { "wikipedia-en": {...}, "arxiv": {...} }
    if (id in scopeRaw && typeof scopeRaw[id] === 'object' && scopeRaw[id] !== null) {
      return scopeRaw[id] as Record<string, unknown>;
    }
    // Flat object: applied to all sources
    return scopeRaw as Record<string, unknown>;
  };

  // v0.7.6 — partition: per-source map or plain string for the single-source case.
  let partitionRaw: any = undefined;
  if (process.env.HIVE_PARTITION) {
    const trimmed = process.env.HIVE_PARTITION.trim();
    if (trimmed.startsWith('{')) {
      try { partitionRaw = JSON.parse(trimmed); } catch {
        console.warn('[manifest] HIVE_PARTITION is not valid JSON — ignored');
      }
    } else if (trimmed) {
      // Plain string — only valid if there's exactly one declared source.
      if (ids.length === 1) partitionRaw = { [ids[0]!]: trimmed };
      else console.warn('[manifest] HIVE_PARTITION as plain string requires a single HIVE_SOURCES entry — ignored');
    }
  }
  const partitionFor = (id: string): string | undefined => {
    if (!partitionRaw || typeof partitionRaw !== 'object') return undefined;
    const v = partitionRaw[id];
    return typeof v === 'string' && v ? v : undefined;
  };

  return ids.map(id => {
    const s = scopeFor(id);
    const p = partitionFor(id);
    return {
      id,
      ...(s ? { scope: s } : {}),
      policy,
      ...(p ? { partition: p } : {}),
    } as DeclaredSource;
  });
}
