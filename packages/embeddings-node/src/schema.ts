// HIVE v0.8 — Fragment schema + network-wide standards.
// Source-agnostic, signed (text + metadata + vector), versioned.

/** Network-wide embedding standard. Changing these = a network migration. */
export const EMBEDDING_MODEL = 'intfloat/multilingual-e5-base';
/** transformers.js hub id (Xenova ONNX conversion of the above). */
export const EMBEDDING_MODEL_ONNX = 'Xenova/multilingual-e5-base';
export const EMBEDDING_DIM = 768;
export const EMBEDDING_DTYPE = 'q8'; // int8 ONNX

/** Bumped whenever the Fragment shape changes; lets the queen handle mixed versions. */
export const SCHEMA_VERSION = 2; // 1 = legacy v0.7

/** Deterministic chunker version — two bees on the same chunker_version + input
 *  produce identical chunks → identical content_hash → corroboration works. */
export const CHUNKER_VERSION = 'layout-v1';

export type FragmentStatus = 'current' | 'superseded' | 'historical';

export interface Fragment {
  // A. Identity & version
  id: string;
  schema_version: number;
  node_id: string;
  node_pubkey: string;

  // B. Content
  text: string;
  lang: string;                         // BCP-47
  title?: string;
  content_hash: string;                 // SHA-256(normalize(text)) — see content_hash.ts

  // C. Provenance (source-agnostic)
  source: string;                       // adapter id, e.g. "wikipedia-en"
  source_type: string;                  // "wikipedia" | "arxiv" | "rss" | "commoncrawl" | "custom"
  url: string;
  license?: string;
  identifiers?: Record<string, string>; // { doi, arxiv, pmid, isbn, … }
  retrieved_at: string;

  // D. Structure / chunking
  section_path?: string[];
  chunk_index?: number;
  chunk_count?: number;

  // E. Embedding (bee-side)
  vector: string;                       // base64(Float16Array) — see vector_codec.ts
  embedding_model: string;
  embedding_dim: number;

  // F. Lifecycle / TTL
  extracted_at: string;
  ttl_seconds?: number;
  status: FragmentStatus;
  supersedes: string[];
  superseded_by: string | null;

  // G. Coordination
  partition?: string;

  // H. Integrity (signed)
  confidence: number;
  hash: string;                         // SHA-256 of the canonical payload INCLUDING the vector
  signature: string;                    // ed25519 over { id, hash }
}

/** Default TTL by source type (seconds). */
export const DEFAULT_TTL: Record<string, number> = {
  wikipedia: 7 * 24 * 3600,
  rss: 24 * 3600,
  arxiv: 30 * 24 * 3600,
  commoncrawl: 30 * 24 * 3600,
};
