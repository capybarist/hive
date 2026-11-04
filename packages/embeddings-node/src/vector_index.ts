// HIVE v0.8 — vector store behind a swappable interface.
// The queen RECEIVES pre-computed vectors from bees and only stores/searches
// them (no embedding here). Default backend: LanceDB (embedded). A Qdrant
// backend can implement the same interface later for high-scale queens.

export interface IndexRecord {
  id: string;
  vector: number[];            // 768-d (decoded from the fragment's fp16)
  text: string;
  title: string;
  url: string;
  source: string;
  source_type: string;
  lang: string;
  node_id: string;
  content_hash: string;
  status: string;
  /** JSON-serialized FragmentV08.meta ('' when absent). Stored + returned verbatim. */
  meta?: string;
  /** v1.2 — promoted meta columns (HIVE_META_COLUMNS): selected meta keys
   *  lifted into real, filterable LanceDB columns, named `meta_<key>`. Every
   *  record in a batch carries the same key set ('' for absent values). */
  extra?: Record<string, string>;
}

export interface SearchHit {
  id: string;
  score: number;               // cosine similarity (higher = closer), in [-1, 1]
  text: string;
  title: string;
  url: string;
  source: string;
  source_type: string;
  lang: string;
  node_id: string;
  /** SHA-256 of the normalized text (schema v2). Identical text from any bee
   *  hashes identically — the key corroboration counts and dedupes on. */
  content_hash?: string;
  /** Parsed FragmentV08.meta, when the fragment carried one. */
  meta?: Record<string, unknown>;
  /** v1.4 — cross-encoder relevance logit when the reranker ordered this hit
   *  (HIVE_RERANK=on). Results are sorted by it, NOT by `score`. */
  rerank_score?: number;
  /** v1.5 — distinct bees (node_ids) that signed this exact text
   *  (HIVE_CORROBORATION=on). */
  corroboration_count?: number;
  /** v1.5 — `score × ln(1 + corroboration_count)`, the order the results
   *  follow when HIVE_CORROBORATION=on and the reranker is off. */
  corroboration_score?: number;
}

export interface SearchFilters {
  lang?: string;
  source_type?: string;
  node_id?: string;
  status?: string;
  /** v1.4 — exact match on PROMOTED meta columns (HIVE_META_COLUMNS), keyed by
   *  the bare meta key: `{ act_name: ['GDPR', 'NIS2'] }` → `meta_act_name IN
   *  (...)`. Applied before the top-k cut, so a narrow filter still fills k
   *  instead of being starved by the global ranking. Only keys the queen
   *  promotes are accepted (QueenIndex validates). */
  meta?: Record<string, string | string[]>;
}

export interface VectorIndex {
  ready(): Promise<void>;
  /** Upsert; skips ids already present (fragments are immutable). Returns # newly added. */
  upsertBatch(records: IndexRecord[]): Promise<number>;
  /** Direct-mode ingest upsert: update-on-match, insert-on-miss (LanceDB
   *  mergeInsert). Records whose stored content_hash already matches are
   *  skipped and counted as `unchanged` — re-ingesting an identical batch is
   *  a no-op by construction (the direct-mode idempotency invariant). */
  mergeUpsertBatch(records: IndexRecord[]): Promise<{ upserted: number; unchanged: number }>;
  search(vector: number[], k: number, filters?: SearchFilters): Promise<SearchHit[]>;
  has(id: string): boolean;
  /** v1.5 — for each content_hash, how many DISTINCT node_ids signed it,
   *  across the whole index (agreement is a property of the text, not of the
   *  query's filters). Hashes absent from the index are absent from the map. */
  corroborationCounts(hashes: string[]): Promise<Map<string, number>>;
  count(): Promise<number>;
  countByNode(nodeIds: string[]): Promise<Record<string, number>>;
  /** Compact small fragments and prune MVCC versions older than `keepMs`.
   *  Without this, LanceDB grows unbounded — every `upsertBatch` leaves a
   *  permanent manifest version. No-op when the backend has nothing to do. */
  optimize(keepMs: number): Promise<void>;
  close(): Promise<void>;
}
