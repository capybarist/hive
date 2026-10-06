// HIVE v0.8 — the "thin queen" module. Consumes v0.8 fragments produced and
// signed by bees (with the embedding INLINE), validates the embedding model
// matches the network standard, and indexes the pre-computed vectors into
// LanceDB. The queen does NO embedding for passages — only for queries.
// Pairs with the retrieval gate (recalibrated for e5) and is meant to be
// dropped into the live api_server at the Phase 5 cutover.

import type { FragmentV08 } from '@hive/core';
import { EMBEDDING_MODEL, EMBEDDING_DIM, verifyFragmentV08 } from '@hive/core';
import { decodeVector } from './vector_codec.js';
import { embedQuery } from './embedder.js';
import type { IndexRecord, SearchFilters, SearchHit, VectorIndex } from './vector_index.js';
import { LanceVectorIndex } from './lance_index.js';
import { isRelevant, meaningfulTokens } from './retrieval_gate.js';
import { rerankerEnabled, rerankPool, rerankScores } from './reranker.js';
import { hybridEnabled, lexicalK, rrf } from './lexical.js';

export interface QueenSearchHit extends SearchHit { relevant: boolean; }

/** A caller-supplied filter the index cannot honour — a client error (400),
 *  never silently dropped: ignoring it would answer outside the asked scope. */
export class QueryFilterError extends Error {}
export interface QueenQueryResult { hits: QueenSearchHit[]; has_hive_data: boolean; }

export class QueenIndex {
  private idx: VectorIndex;
  private dropped = { model: 0, signature: 0, dim: 0 };
  /** v1.2 — meta keys promoted to filterable `meta_<key>` LanceDB columns
   *  (HIVE_META_COLUMNS). Closed-product queens use this to make domain
   *  metadata (e.g. legal anchors) queryable without forking the schema. */
  private metaColumns: string[];

  constructor(dir: string, idx?: VectorIndex, opts: { metaColumns?: string[] } = {}) {
    this.idx = idx ?? new LanceVectorIndex(dir);
    this.metaColumns = opts.metaColumns ?? [];
  }

  async ready(): Promise<void> { await this.idx.ready(); }

  /** Validate a bee fragment is index-compatible. v0.8 invariants:
   *  same network model+dim; optional ed25519 signature verification when a
   *  pubkey is supplied. */
  validate(frag: FragmentV08, pubkey?: string): true | string {
    if (frag.embedding_model !== EMBEDDING_MODEL) {
      this.dropped.model++;
      return `model mismatch (${frag.embedding_model} ≠ ${EMBEDDING_MODEL})`;
    }
    if (frag.embedding_dim !== EMBEDDING_DIM) {
      this.dropped.dim++;
      return `dim mismatch (${frag.embedding_dim} ≠ ${EMBEDDING_DIM})`;
    }
    if (pubkey && !verifyFragmentV08(frag, pubkey)) {
      this.dropped.signature++;
      return 'signature does not verify';
    }
    return true;
  }

  /** Upsert validated v0.8 fragments. Decodes fp16 vectors and pushes them
   *  to LanceDB. Returns counts; dedup honoured by the index. */
  async upsertFragments(frags: FragmentV08[], opts: { pubkeyByNode?: Record<string, string> } = {}): Promise<{ added: number; skipped: number }> {
    const records: IndexRecord[] = [];
    let skipped = 0;
    for (const f of frags) {
      const pk = opts.pubkeyByNode?.[f.node_id];
      const ok = this.validate(f, pk);
      if (ok !== true) { skipped++; continue; }
      records.push(this.toRecord(f));
    }
    const added = await this.idx.upsertBatch(records);
    return { added, skipped };
  }

  private toRecord(f: FragmentV08): IndexRecord {
    let extra: Record<string, string> | undefined;
    if (this.metaColumns.length > 0) {
      extra = {};
      for (const k of this.metaColumns) {
        const v = f.meta?.[k];
        extra[`meta_${k}`] = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    return {
      ...(extra ? { extra } : {}),
      id: f.id,
      vector: Array.from(decodeVector(f.vector, EMBEDDING_DIM)),
      text: f.text,
      title: f.title ?? '',
      url: f.url,
      source: f.source,
      source_type: f.source_type,
      lang: f.lang,
      node_id: f.node_id,
      content_hash: f.content_hash,
      status: f.status,
      meta: f.meta ? JSON.stringify(f.meta) : '',
    };
  }

  /**
   * Direct-mode ingest (docs/direct-mode.md): verify EVERY fragment in the
   * batch against the trusted bee's pubkey before touching the index. Any
   * failure rejects the whole batch — partial acceptance is forbidden so the
   * bee's retry semantics stay trivial. On success, upsert via mergeInsert
   * (update-on-match) and report unchanged re-deliveries.
   */
  async ingestBatch(
    frags: FragmentV08[],
    pubkey: string,
  ): Promise<
    | { ok: true; upserted: number; unchanged: number }
    | { ok: false; rejected: string[]; reason: string }
  > {
    const rejected: string[] = [];
    let reason = '';
    for (const f of frags) {
      const ok = this.validate(f, pubkey);
      if (ok !== true) {
        rejected.push(f.id);
        if (!reason) reason = ok;   // first failure names the batch's reason
      }
    }
    if (rejected.length > 0) return { ok: false, rejected, reason };
    const { upserted, unchanged } = await this.idx.mergeUpsertBatch(frags.map((f) => this.toRecord(f)));
    return { ok: true, upserted, unchanged };
  }

  /** Query: embed (queen-side, the ONE place the queen embeds), search,
   *  cross-encoder re-rank the candidates (precision stage over e5's recall),
   *  apply the recalibrated relevance gate per hit, derive has_hive_data. */
  async query(question: string, k = 8, filters?: SearchFilters, opts: { pool?: number } = {}): Promise<QueenQueryResult> {
    // Before embedding: a bad filter is the caller's error and costs nothing.
    for (const key of Object.keys(filters?.meta ?? {})) {
      if (!this.metaColumns.includes(key)) {
        throw new QueryFilterError(`meta filter '${key}' is not a promoted column (HIVE_META_COLUMNS: ${this.metaColumns.join(', ') || 'none'})`);
      }
    }
    const qVec = Array.from(await embedQuery(question));
    // Over-fetch a candidate pool, then let the cross-encoder pick the true
    // top-k. e5's cosine compresses on homogeneous corpora, so the answering
    // passage can sit several ranks down — the reranker reads (query,passage)
    // jointly and restores the ordering. Reranking is a precision booster, not
    // a hard dependency: any failure falls back to e5's cosine order.
    const useRerank = rerankerEnabled();
    // The pool is what the cross-encoder scores, so it IS the latency: a
    // caller that only needs a few candidates (a per-filter top-up) can ask
    // for a smaller one. Never below k, never above the configured pool.
    const pool = useRerank ? Math.max(k, Math.min(rerankPool(k), opts.pool ?? Infinity)) : k;
    let hits = await this.idx.search(qVec, pool, filters);
    if (hybridEnabled() && this.idx.lexicalSearch) {
      // Hybrid: word-overlap candidates fused with the vector ones by rank
      // (RRF), cut back to the SAME pool — the reranker scores as many pairs
      // as before, so latency is unchanged; only who gets a seat changes.
      try {
        const lexical = await this.idx.lexicalSearch(question, qVec, Math.min(lexicalK(), pool), filters);
        const fused = rrf([hits.map((h) => h.id), lexical.map((h) => h.id)]);
        const byId = new Map([...lexical, ...hits].map((h) => [h.id, h]));
        hits = [...fused].sort((a, b) => b[1] - a[1]).slice(0, pool).map(([id]) => byId.get(id)!);
      } catch (err) {
        console.warn(`[hybrid] falling back to vector-only candidates: ${(err as Error).message}`);
      }
    }
    if (useRerank && hits.length > 1) {
      try {
        const rel = await rerankScores(question, hits.map((h) => `${h.title ? `${h.title}. ` : ''}${h.text}`));
        // The logit travels with the hit: callers that need a relevance gate
        // can only judge the order they receive by the score that produced it.
        hits = hits.map((h, i) => ({ h, r: rel[i] ?? -Infinity }))
          .sort((a, b) => b.r - a.r).map((x) => ({ ...x.h, rerank_score: x.r }));
      } catch (err) {
        console.warn(`[rerank] falling back to e5 cosine order: ${(err as Error).message}`);
      }
      hits = hits.slice(0, k);
    }
    const tokens = meaningfulTokens(question);
    const marked: QueenSearchHit[] = hits.map((h) => ({
      ...h,
      relevant: isRelevant(h.score, `${h.title} ${h.text}`.toLowerCase(), tokens),
    }));
    return { hits: marked, has_hive_data: marked.some((h) => h.relevant) };
  }

  stats(): { dropped: { model: number; signature: number; dim: number } } {
    return { dropped: this.dropped };
  }
  async count(): Promise<number> { return this.idx.count(); }
  async optimize(keepMs: number): Promise<void> { return this.idx.optimize(keepMs); }
  async close(): Promise<void> { return this.idx.close(); }
}
