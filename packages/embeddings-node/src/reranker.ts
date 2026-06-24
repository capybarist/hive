// HIVE — cross-encoder re-ranker (second-stage retrieval).
//
// WHY: the e5 bi-encoder (first stage) embeds the query and each passage
// INDEPENDENTLY, so on a homogeneous corpus (e.g. one body of legislation) its
// cosine scores compress into a narrow band — the passage that actually ANSWERS
// the question often fails to separate from merely on-topic ones, and lexical
// near-misses ("...shall enter into force only if no objection...") can outrank
// the real answer. A cross-encoder reads (query, passage) TOGETHER in one model
// pass and scores their true relevance, restoring discrimination. It runs only
// over the top-N candidates e5 already recalled, so it is a cheap, LOCAL,
// no-API precision stage on top of e5's recall.
//
// Default model: BAAI bge-reranker-base (multilingual, matches e5), ONNX int8.
// Measured on the AI Act corpus: "is the AI Act in force?" lifts Article 113
// (entry into force) from cosine-rank 4 to rank 1 by a wide margin, and
// "GDPR fines" lifts Art. 83(4)/(5) (the actual amounts) to ranks 1-2 — both
// were buried under near-duplicate-register provisions before. Weaker rerankers
// (ms-marco-MiniLM, jina-tiny, mxbai-xsmall) do NOT fix these — model matters.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers';

env.allowLocalModels = false;

const MODEL = process.env.HIVE_RERANK_MODEL?.trim() || 'Xenova/bge-reranker-base';
const DTYPE = (process.env.HIVE_RERANK_DTYPE?.trim() || 'q8') as 'q8' | 'fp16' | 'fp32';

// OPT-IN: reranking is OFF unless HIVE_RERANK is explicitly turned on. HIVE is
// generic infra (Wikipedia, arXiv, PubMed, … not only law) and many nodes are
// small; loading a ~300-500MB cross-encoder into every queen's RAM by default
// would change the resource profile for everyone (and the queen has OOM history)
// for a gain that is largest on HOMOGENEOUS corpora like a single legal act.
// So the capability ships here but each operator opts in (acquis sets it on).
const TRUTHY = new Set(['on', '1', 'true', 'yes']);
export function rerankerEnabled(): boolean {
  return TRUTHY.has((process.env.HIVE_RERANK ?? '').trim().toLowerCase());
}

/** How many bi-encoder candidates to re-score before truncating to k. The
 *  precision stage can only promote what recall already surfaced, so the pool
 *  must be wide enough to contain the true answer (cosine-rank can be ~4-8). */
export function rerankPool(k: number): number {
  const fromEnv = Number(process.env.HIVE_RERANK_POOL);
  return Math.max(Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 40, k);
}

type Tokenizer = (texts: string[], opts: { text_pair: string[]; padding: boolean; truncation: boolean }) => unknown;
type SeqModel = (inputs: unknown) => Promise<{ logits: { data: Float32Array; dims: number[] } }>;

let _tok: Tokenizer | null = null;
let _model: SeqModel | null = null;
let _loading: Promise<void> | null = null;

async function load(): Promise<void> {
  if (_model && _tok) return;
  if (!_loading) {
    _loading = (async () => {
      _tok = (await AutoTokenizer.from_pretrained(MODEL)) as unknown as Tokenizer;
      _model = (await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: DTYPE })) as unknown as SeqModel;
    })();
  }
  await _loading;
}

/** Pre-load the reranker (call at queen boot so the first query isn't slow). */
export async function warmupReranker(): Promise<void> { if (rerankerEnabled()) await load(); }

/** Relevance score per passage (higher = more relevant), aligned to `passages`.
 *  One batched forward pass; the model reads each (query, passage) pair jointly.
 *  bge-reranker emits a single relevance logit per pair — we order by it raw
 *  (sigmoid is monotonic, so it would not change the order). */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];
  await load();
  const inputs = _tok!(new Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true });
  const { logits } = await _model!(inputs);
  const cols = logits.dims[1] ?? 1;
  const out: number[] = [];
  for (let i = 0; i < passages.length; i++) out.push(logits.data[i * cols]!);
  return out;
}
