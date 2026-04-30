export type FragmentId = string;
export type FragmentStatus = 'current' | 'superseded' | 'historical';

export interface Fragment {
  id: FragmentId;
  text: string;
  source: string;
  doi: string | null;
  confidence: number;
  vector_id?: string;
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
  save(input: FragmentInput): Promise<FragmentId>;
  get(id: FragmentId): Promise<Fragment | null>;
  query(filter: QueryFilter): AsyncIterable<Fragment>;
  supersede(oldId: FragmentId, newInput: FragmentInput): Promise<FragmentId>;
  history(id: FragmentId): Promise<Fragment[]>;
  verify(fragment: Fragment): Promise<boolean>;
  close(): Promise<void>;
}
