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

export interface QueenSearchHit extends SearchHit { relevant: boolean; }
export interface QueenQueryResult { hits: QueenSearchHit[]; has_hive_data: boolean; }

export class QueenIndex {
  private idx: VectorIndex;
  private dropped = { model: 0, signature: 0, dim: 0 };

  constructor(dir: string, idx?: VectorIndex) {
    this.idx = idx ?? new LanceVectorIndex(dir);
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
      const vec = decodeVector(f.vector, EMBEDDING_DIM);
      records.push({
        id: f.id,
        vector: Array.from(vec),
        text: f.text,
        title: f.title ?? '',
        url: f.url,
        source: f.source,
        source_type: f.source_type,
        lang: f.lang,
        node_id: f.node_id,
        content_hash: f.content_hash,
        status: f.status,
      });
    }
    const added = await this.idx.upsertBatch(records);
    return { added, skipped };
  }

  /** Query: embed (queen-side, the ONE place the queen embeds), search,
   *  apply the recalibrated relevance gate per hit, derive has_hive_data. */
  async query(question: string, k = 8, filters?: SearchFilters): Promise<QueenQueryResult> {
    const qVec = Array.from(await embedQuery(question));
    const hits = await this.idx.search(qVec, k, filters);
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
