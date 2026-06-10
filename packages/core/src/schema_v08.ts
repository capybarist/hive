// HIVE v0.8 — canonical Fragment data model + network-wide standards.
// Lives in @hive/core (where signing + the store are). The embed RUNTIME
// (ONNX model id, dtype, the embedder/chunker/index) lives in
// @hive/embeddings-node and imports the shared constants from here.
//
// Additive in v0.8: the legacy v0.7 `Fragment` in interfaces.ts is untouched
// until the cutover. This is the target schema the migration builds toward.

export const EMBEDDING_MODEL = 'intfloat/multilingual-e5-base';
export const EMBEDDING_DIM = 768;
export const SCHEMA_VERSION = 2;            // 1 = legacy v0.7
export const CHUNKER_VERSION = 'layout-v1';

export type FragmentStatus = 'current' | 'superseded' | 'historical';

export interface FragmentV08 {
  // A. Identity & version
  //
  // `id` MUST be deterministic: derived from source identity + structural
  // anchor + chunk index (e.g. `wiki_<title>_<section>_c0`) — never a random
  // UUID. This is the idempotency invariant direct mode (docs/direct-mode.md)
  // rests on: a bee retries a whole ingest batch on any failure and double
  // delivery is harmless because the queen upserts by id.
  id: string;
  schema_version: number;
  node_id: string;
  node_pubkey: string;

  // B. Content
  text: string;
  lang: string;
  title?: string;
  content_hash: string;

  // C. Provenance (source-agnostic)
  source: string;
  source_type: string;
  url: string;
  license?: string;
  identifiers?: Record<string, string>;
  retrieved_at: string;

  // D. Structure / chunking
  section_path?: string[];
  chunk_index?: number;
  chunk_count?: number;

  // E. Embedding (bee-side)
  vector: string;                  // base64(Float16Array)
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

  // G2. Extensible metadata (signed, since it sits inside the hashed payload).
  // Domain-specific deployments attach structured metadata here (document
  // anchors, validity windows, …) without forking the schema. Core HIVE
  // stores and returns it verbatim and never interprets it.
  meta?: Record<string, unknown>;

  // H. Integrity (signed)
  confidence: number;
  hash: string;
  signature: string;
}

/** Fields the producer supplies; the builder fills the rest + signs. */
export type FragmentV08Input = Omit<
  FragmentV08,
  'schema_version' | 'content_hash' | 'vector' | 'embedding_model' | 'embedding_dim'
  | 'status' | 'supersedes' | 'superseded_by' | 'hash' | 'signature'
>;

export const DEFAULT_TTL: Record<string, number> = {
  wikipedia: 7 * 24 * 3600,
  rss: 24 * 3600,
  arxiv: 30 * 24 * 3600,
  pubmed: 90 * 24 * 3600,
  commoncrawl: 30 * 24 * 3600,
  'personal-memory': 365 * 24 * 3600,   // personal data (Claude/notes/…) is immutable history
};
