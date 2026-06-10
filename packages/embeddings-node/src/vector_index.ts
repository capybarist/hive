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
}

export interface SearchFilters {
  lang?: string;
  source_type?: string;
  node_id?: string;
  status?: string;
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
  count(): Promise<number>;
  countByNode(nodeIds: string[]): Promise<Record<string, number>>;
  /** Compact small fragments and prune MVCC versions older than `keepMs`.
   *  Without this, LanceDB grows unbounded — every `upsertBatch` leaves a
   *  permanent manifest version. No-op when the backend has nothing to do. */
  optimize(keepMs: number): Promise<void>;
  close(): Promise<void>;
}
