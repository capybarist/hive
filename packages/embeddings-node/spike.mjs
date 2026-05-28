// v0.8 Phase-1 spike: validate multilingual-e5-base in ONNX int8 via
// transformers.js. Checks: model loads, dim=768, cosine sanity, multilingual
// match (es↔en), int8 RAM + latency. Run: node spike.mjs
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false; // force HF hub download for the spike

const CANDIDATES = [
  'Xenova/multilingual-e5-base',
  'intfloat/multilingual-e5-base',
];
const DTYPE = process.env.DTYPE || 'q8'; // int8

const mb = () => Math.round(process.memoryUsage().rss / 1048576);
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

let extractor = null, modelId = null;
for (const id of CANDIDATES) {
  try {
    console.log(`\n[load] trying ${id} (dtype=${DTYPE}) …`);
    const t0 = Date.now();
    extractor = await pipeline('feature-extraction', id, { dtype: DTYPE });
    modelId = id;
    console.log(`[load] OK ${id} in ${((Date.now() - t0) / 1000).toFixed(1)}s — RSS ${mb()} MB`);
    break;
  } catch (e) {
    console.warn(`[load] ${id} failed: ${e?.message ?? e}`);
  }
}
if (!extractor) { console.error('ALL CANDIDATES FAILED'); process.exit(1); }

// e5 requires prefixes
const embed = async (text, kind /* 'passage'|'query' */) => {
  const out = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
  return out.data; // Float32Array
};

const passages = {
  photosynthesis: 'Photosynthesis is the process by which plants convert light energy into chemical energy stored in glucose.',
  mitochondria: 'The mitochondrion is the organelle that produces ATP through cellular respiration.',
  cocido: 'El cocido madrileño es un guiso tradicional de Madrid a base de garbanzos, carnes y verduras.',
};

console.log('\n[embed] warming up + timing …');
const t1 = Date.now();
const vPhoto = await embed(passages.photosynthesis, 'passage');
const perEmbedMs = Date.now() - t1;
console.log(`[embed] dim=${vPhoto.length}  first-embed=${perEmbedMs}ms  RSS=${mb()} MB`);

const vMito = await embed(passages.mitochondria, 'passage');
const vCocido = await embed(passages.cocido, 'passage');

// Queries (e5 'query:' prefix)
const qPhotoEn = await embed('What is photosynthesis?', 'query');
const qPhotoEs = await embed('¿Qué es la fotosíntesis?', 'query');

console.log('\n[cosine] relevance sanity (higher = closer):');
console.log(`  EN query "what is photosynthesis?"  vs photosynthesis passage : ${cos(qPhotoEn, vPhoto).toFixed(3)}`);
console.log(`  EN query "what is photosynthesis?"  vs mitochondria  passage : ${cos(qPhotoEn, vMito).toFixed(3)}  (should be lower)`);
console.log(`  EN query "what is photosynthesis?"  vs cocido        passage : ${cos(qPhotoEn, vCocido).toFixed(3)}  (should be lowest)`);
console.log('\n[cosine] CROSS-LINGUAL (the v0.7 gap we want fixed):');
console.log(`  ES query "¿qué es la fotosíntesis?" vs EN photosynthesis pass : ${cos(qPhotoEs, vPhoto).toFixed(3)}  (want HIGH — proves multilingual)`);
console.log(`  ES query "¿qué es la fotosíntesis?" vs cocido passage        : ${cos(qPhotoEs, vCocido).toFixed(3)}  (should be lower)`);

// Storage estimate
const bytesFp32 = vPhoto.length * 4;
const bytesFp16 = vPhoto.length * 2;
console.log('\n[storage] per-vector:');
console.log(`  fp32 raw=${bytesFp32}B  fp16 raw=${bytesFp16}B  fp16 base64≈${Math.ceil(bytesFp16 / 3) * 4}B`);
console.log(`  → 500k fragments fp16 ≈ ${(500000 * bytesFp16 / 1073741824).toFixed(2)} GB extra in Hypercore`);

console.log(`\n[result] model=${modelId} dtype=${DTYPE} dim=${vPhoto.length} peakRSS=${mb()}MB`);
console.log('[result] SPIKE OK — review cosines above (relevance ordering + cross-lingual match).');
