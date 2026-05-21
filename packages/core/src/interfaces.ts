export type FragmentId = string;
export type FragmentStatus = 'current' | 'superseded' | 'historical';

export interface Fragment {
  id: FragmentId;
  text: string;
  source: string;
  doi: string | null;
  confidence: number;
  vector_id?: string;
  title?: string;
  arxiv_id?: string;
  extracted_at: string;
  node_id: string;
  status: FragmentStatus;
  supersedes: FragmentId[];
  superseded_by: FragmentId | null;
  hash: string;
  signature: string;
}

export type FragmentInput = Omit<Fragment, 'status' | 'supersedes' | 'superseded_by' | 'hash' | 'signature'>;

export interface QueryFilter {
  source?: string;
  status?: FragmentStatus;
  limit?: number;
}

export interface IKnowledgeGraph {
  ready(): Promise<void>;
  save(input: FragmentInput): Promise<Fragment>;
  get(id: FragmentId): Promise<Fragment | null>;
  query(filter: QueryFilter): AsyncIterable<Fragment>;
  supersede(oldId: FragmentId, newInput: FragmentInput): Promise<Fragment>;
  history(id: FragmentId): Promise<Fragment[]>;
  verify(fragment: Fragment): Promise<boolean>;
  close(): Promise<void>;
}

// ── Embedder payload ────────────────────────────────────────────────────────
// What we send to the HNSW/Qdrant `POST /add` endpoint. The signature and
// hash travel with every fragment so downstream consumers (queries, peers
// syncing via HTTP) can verify the source-of-truth without going back to
// Hypercore. Academic-only fields (doi, arxiv_id) are intentionally omitted
// when null so payloads from Wikipedia/RSS aren't polluted with arXiv noise.
export interface EmbedderPayload {
  source: string;
  confidence: number;
  node_id: string;
  extracted_at: string;
  title: string | null;
  status: FragmentStatus;
  hash: string;
  signature: string;
  doi?: string;
  doi_valid?: boolean;
  arxiv_id?: string;
}

export function buildEmbedderPayload(frag: Fragment): EmbedderPayload {
  const out: EmbedderPayload = {
    source: frag.source,
    confidence: frag.confidence,
    node_id: frag.node_id,
    extracted_at: frag.extracted_at,
    title: frag.title ?? null,
    status: frag.status,
    hash: frag.hash,
    signature: frag.signature,
  };
  if (frag.doi) {
    out.doi = frag.doi;
    out.doi_valid = true;
  }
  if (frag.arxiv_id) out.arxiv_id = frag.arxiv_id;
  return out;
}
