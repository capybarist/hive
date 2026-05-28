// HIVE v0.8 — barrel exports for the @hive/embeddings-node workspace.
// Stable surface other packages import (agent for embedPassage + chunker,
// api for QueenIndex + retrieval gate). Implementation files stay private.
export { embedPassage, embedQuery, warmup } from './embedder.js';
export { encodeVector, decodeVector } from './vector_codec.js';
export { chunkDocument, CHUNKER_VERSION } from './chunker.js';
export type { Section, Chunk } from './chunker.js';
export { QueenIndex } from './queen_index.js';
export type { QueenSearchHit, QueenQueryResult } from './queen_index.js';
export { LanceVectorIndex } from './lance_index.js';
export type { VectorIndex, IndexRecord, SearchHit, SearchFilters } from './vector_index.js';
export { RELEVANT_SCORE, meaningfulTokens, meetsKeywordGate, isRelevant } from './retrieval_gate.js';
