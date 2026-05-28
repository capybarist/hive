// HIVE v0.8 — build + verify signed fragments with the embedding vector
// INLINE in the signed payload. The vector is produced upstream (bee-side,
// by @hive/embeddings-node) and passed in here; core owns the signing so the
// vector is hashed + signed transitively (hashPayload over the whole payload).
import { hashPayload, signPayload, verifySignature, type NodeIdentity } from './node_identity.js';
import { contentHash } from './content_hash.js';
import {
  EMBEDDING_MODEL, EMBEDDING_DIM, SCHEMA_VERSION,
  type FragmentV08, type FragmentV08Input,
} from './schema_v08.js';

/**
 * Build a signed v0.8 fragment. `vectorB64` is the base64(Float16Array) the
 * bee computed with the network-standard model. The hash covers the entire
 * payload (text + metadata + vector), so a tampered or mismatched vector
 * breaks verification — the bee can't disown a bad vector.
 */
export function buildSignedFragmentV08(
  input: FragmentV08Input,
  vectorB64: string,
  identity: NodeIdentity,
  opts: { embeddingModel?: string; embeddingDim?: number } = {},
): FragmentV08 {
  const partial = {
    ...input,
    schema_version: SCHEMA_VERSION,
    node_pubkey: identity.publicKeyHex,
    content_hash: contentHash(input.text),
    vector: vectorB64,
    embedding_model: opts.embeddingModel ?? EMBEDDING_MODEL,
    embedding_dim: opts.embeddingDim ?? EMBEDDING_DIM,
    status: 'current' as const,
    supersedes: [] as string[],
    superseded_by: null,
  };
  const hash = hashPayload(partial);
  const signature = signPayload({ id: partial.id, hash }, identity.privateKeyHex);
  return { ...partial, hash, signature };
}

/** Verify integrity (hash covers the vector) + ed25519 signature against a pubkey. */
export function verifyFragmentV08(frag: FragmentV08, publicKeyHex: string): boolean {
  const { hash, signature, ...rest } = frag;
  if (hashPayload(rest) !== hash) return false;
  return verifySignature({ id: frag.id, hash }, signature, publicKeyHex);
}
