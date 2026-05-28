// HIVE v0.8 — all-Node embedder (multilingual-e5-base, ONNX int8).
// Used by the BEE to embed passages (stored signed in its Hypercore) and by
// the QUEEN to embed queries. e5 REQUIRES "passage: " / "query: " prefixes.
import { pipeline, env } from '@huggingface/transformers';
import { EMBEDDING_MODEL_ONNX, EMBEDDING_DTYPE, EMBEDDING_DIM } from './schema.js';

env.allowLocalModels = false;

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>;

let _extractor: Extractor | null = null;
let _loading: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = (pipeline('feature-extraction', EMBEDDING_MODEL_ONNX, { dtype: EMBEDDING_DTYPE }) as Promise<unknown>)
    .then((e) => { _extractor = e as Extractor; return _extractor; });
  return _loading;
}

/** Pre-load the model (call at startup so the first request isn't slow). */
export async function warmup(): Promise<void> { await getExtractor(); }

async function embed(text: string, kind: 'passage' | 'query'): Promise<Float32Array> {
  const ex = await getExtractor();
  const out = await ex(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
  if (out.data.length !== EMBEDDING_DIM) {
    throw new Error(`embed: expected dim ${EMBEDDING_DIM}, got ${out.data.length}`);
  }
  return out.data;
}

export const embedPassage = (text: string) => embed(text, 'passage');
export const embedQuery = (text: string) => embed(text, 'query');
