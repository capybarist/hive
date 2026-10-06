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
  /** Parsed FragmentV08.meta, when the fragment carried one. */
  meta?: Record<string, unknown>;
  /** v1.4 — cross-encoder relevance logit when the reranker ordered this hit
   *  (HIVE_RERANK=on). Results are sorted by it, NOT by `score`. */
  rerank_score?: number;
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
  /** Hybrid retrieval (HIVE_HYBRID): the k best WORD-OVERLAP matches for the
   *  query under the same filters, each scored by cosine against `vector` so
   *  the hit is shaped like a vector hit. Optional: a backend without it makes
   *  the queen fall back to vector-only retrieval. */
  lexicalSearch?(query: string, vector: number[], k: number, filters?: SearchFilters): Promise<SearchHit[]>;
  has(id: string): boolean;
  count(): Promise<number>;
  countByNode(nodeIds: string[]): Promise<Record<string, number>>;
  /** Compact small fragments and prune MVCC versions older than `keepMs`.
   *  Without this, LanceDB grows unbounded — every `upsertBatch` leaves a
   *  permanent manifest version. No-op when the backend has nothing to do. */
  optimize(keepMs: number): Promise<void>;
  close(): Promise<void>;
}
