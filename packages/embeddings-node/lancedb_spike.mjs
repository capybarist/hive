// v0.8 Phase-2 spike: validate LanceDB as the Qdrant replacement.
// Checks: create/persist a table with a 768-d vector + v0.8 payload, ANN
// search ordering with REAL e5 vectors, metadata filters (lang/source_type),
// reopen persistence, and bulk insert/query/disk/RAM at scale.
// Run: node lancedb_spike.mjs
import * as lancedb from '@lancedb/lancedb';
import { pipeline, env } from '@huggingface/transformers';
import { rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

env.allowLocalModels = false;
const DIR = './data/lancedb-spike';
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });

// ── real e5 vectors for the functional test ──
console.log(`[e5] loading multilingual-e5-base q8 …`);
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-base', { dtype: 'q8' });
const embed = async (text, kind) => Array.from((await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true })).data);
const DIM = 768;

const docs = [
  { id: 'a', lang: 'en', source_type: 'wikipedia', text: 'Photosynthesis converts light energy into chemical energy in plants.' },
  { id: 'b', lang: 'en', source_type: 'wikipedia', text: 'The mitochondrion produces ATP through cellular respiration.' },
  { id: 'c', lang: 'es', source_type: 'wikipedia', text: 'El cocido madrileño es un guiso tradicional de Madrid con garbanzos.' },
  { id: 'd', lang: 'en', source_type: 'arxiv', text: 'Retrieval-augmented generation combines a retriever with a generative model.' },
];
const rows = [];
for (const d of docs) {
  rows.push({ id: d.id, vector: await embed(d.text, 'passage'), text: d.text, lang: d.lang, source_type: d.source_type,
    node_id: 'node_test', content_hash: 'h_' + d.id });
}

console.log('[lancedb] connect + createTable …');
const db = await lancedb.connect(DIR);
const table = await db.createTable('fragments', rows);
console.log(`[lancedb] inserted ${rows.length} rows. table count = ${await table.countRows()}`);

// ── functional: ANN search ordering ──
const q = await embed('What is photosynthesis?', 'query');
const res = await table.search(q).limit(4).toArray();
console.log('\n[search] "What is photosynthesis?" (no filter):');
for (const r of res) console.log(`  ${r.id} dist=${r._distance.toFixed(4)} lang=${r.lang} :: ${r.text.slice(0, 50)}`);

// ── functional: metadata filter ──
const resEn = await table.search(q).where("lang = 'en'").limit(4).toArray();
console.log('\n[search] same query, filter lang=en:');
for (const r of resEn) console.log(`  ${r.id} dist=${r._distance.toFixed(4)} lang=${r.lang}`);

const resArxiv = await table.search(q).where("source_type = 'arxiv'").limit(4).toArray();
console.log('\n[search] same query, filter source_type=arxiv:');
for (const r of resArxiv) console.log(`  ${r.id} dist=${r._distance.toFixed(4)} src=${r.source_type}`);

// ── persistence: reopen ──
const db2 = await lancedb.connect(DIR);
const t2 = await db2.openTable('fragments');
console.log(`\n[persist] reopened table, count = ${await t2.countRows()} (should be ${rows.length})`);

// ── scale: bulk synthetic insert ──
const N = Number(process.env.N || 50000);
console.log(`\n[scale] inserting ${N} synthetic 768-d rows …`);
const t0 = Date.now();
const BATCH = 1000;
for (let i = 0; i < N; i += BATCH) {
  const batch = [];
  for (let j = 0; j < BATCH && i + j < N; j++) {
    const v = new Array(DIM);
    for (let k = 0; k < DIM; k++) v[k] = Math.random() * 2 - 1;
    batch.push({ id: `s${i + j}`, vector: v, text: `synthetic ${i + j}`, lang: 'en', source_type: 'wikipedia', node_id: 'node_bulk', content_hash: `s${i + j}` });
  }
  await table.add(batch);
}
const insMs = Date.now() - t0;
console.log(`[scale] inserted ${N} in ${(insMs / 1000).toFixed(1)}s (${Math.round(N / (insMs / 1000))}/s). count=${await table.countRows()} RSS=${mb()}MB`);

const tq = Date.now();
const big = await table.search(q).limit(10).toArray();
console.log(`[scale] flat ANN query over ${N} rows: ${Date.now() - tq}ms (top dist=${big[0]._distance.toFixed(4)})`);

let disk = '?';
try { disk = execSync(`du -sh ${DIR}`).toString().split('\t')[0]; } catch {}
console.log(`\n[result] LanceDB: dim=${DIM} rows=${await table.countRows()} disk=${disk} peakRSS=${mb()}MB`);
console.log('[result] SPIKE OK — review ANN ordering + filters above.');
