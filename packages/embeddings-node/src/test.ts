// v0.8 core data-path test: codec + content_hash + chunker + embed + LanceDB.
// Run: RUST_LOG=error tsx src/test.ts
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { encodeVector, decodeVector } from './vector_codec.js';
import { contentHash, normalizeForHash } from './content_hash.js';
import { chunkDocument } from './chunker.js';
import { embedPassage, embedQuery } from './embedder.js';
import { LanceVectorIndex } from './lance_index.js';
import { EMBEDDING_DIM } from './schema.js';
import type { IndexRecord } from './vector_index.js';

const DIR = './data/v08-test';
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
let pass = 0, fail = 0;
const ok = (c: boolean, msg: string) => { if (c) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } };

console.log('\n[1] vector_codec fp16 round-trip');
{
  const v = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i) * 0.5);
  const dec = decodeVector(encodeVector(v), EMBEDDING_DIM);
  ok(dec.length === EMBEDDING_DIM, `dim preserved (${dec.length})`);
  let maxErr = 0; for (let i = 0; i < v.length; i++) maxErr = Math.max(maxErr, Math.abs(v[i] - dec[i]));
  ok(maxErr < 0.001, `fp16 max abs error ${maxErr.toExponential(2)} < 1e-3`);
  const b64 = encodeVector(v);
  ok(b64.length < 2200, `base64 size ${b64.length}B (~2KB target)`);
}

console.log('\n[2] content_hash determinism');
{
  const a = 'Photosynthesis  converts\n\nlight   energy.';
  const b = 'Photosynthesis converts light energy.';
  ok(contentHash(a) === contentHash(b), 'whitespace variants hash identically (corroboration)');
  ok(normalizeForHash('  á́  ') !== '', 'NFC + trim applied');
  ok(contentHash('X') !== contentHash('x'), 'case preserved (no lowercasing)');
}

console.log('\n[3] chunker determinism');
{
  const secs = [{ heading_path: ['Intro'], text: 'A'.repeat(50) + '. ' + 'B'.repeat(2000) + '. short tail.' }];
  const c1 = chunkDocument(secs);
  const c2 = chunkDocument(secs);
  ok(JSON.stringify(c1) === JSON.stringify(c2), 'same input → identical chunks');
  ok(c1.every((c, i) => c.chunk_index === i && c.chunk_count === c1.length), 'chunk_index/count set');
  ok(c1.every((c) => c.section_path[0] === 'Intro'), 'section_path carried');
}

console.log('\n[4] end-to-end: chunk → embed → fp16 → LanceDB → query');
const docs = [
  { id: 'photo', lang: 'en', source_type: 'wikipedia', text: 'Photosynthesis is the process by which green plants convert light energy into chemical energy stored as glucose.' },
  { id: 'mito',  lang: 'en', source_type: 'wikipedia', text: 'The mitochondrion is the organelle that generates most of the cell’s ATP through respiration.' },
  { id: 'cocido', lang: 'es', source_type: 'wikipedia', text: 'El cocido madrileño es un guiso tradicional de Madrid elaborado con garbanzos, carnes y verduras.' },
  { id: 'rag', lang: 'en', source_type: 'arxiv', text: 'Retrieval augmented generation augments a language model with documents fetched from an external index.' },
];
const idx = new LanceVectorIndex(DIR);
await idx.ready();
const records: IndexRecord[] = [];
for (const d of docs) {
  const vec = await embedPassage(d.text);
  const decoded = decodeVector(encodeVector(vec), EMBEDDING_DIM); // exercise the fp16 path
  records.push({ id: d.id, vector: Array.from(decoded), text: d.text, title: d.id, url: `https://x/${d.id}`,
    source: 'wikipedia-en', source_type: d.source_type, lang: d.lang, node_id: 'node_test', content_hash: contentHash(d.text), status: 'current' });
}
const added = await idx.upsertBatch(records);
ok(added === 4, `upserted 4 (got ${added})`);
ok(await idx.upsertBatch(records) === 0, 'dedup: re-upsert adds 0');

const qPhoto = Array.from(await embedQuery('What is photosynthesis?'));
const hits = await idx.search(qPhoto, 4);
console.log('   ranking:', hits.map((h) => `${h.id}:${h.score.toFixed(3)}`).join('  '));
ok(hits[0].id === 'photo', `top hit is photosynthesis (got ${hits[0].id})`);
ok(hits[0].score > hits[3].score, 'scores descend');

const qEs = Array.from(await embedQuery('¿Qué es la fotosíntesis?'));
const hitsEs = await idx.search(qEs, 4);
const photoRank = hitsEs.findIndex((h) => h.id === 'photo');
const cocidoRank = hitsEs.findIndex((h) => h.id === 'cocido');
ok(photoRank < cocidoRank, `cross-lingual: ES query ranks EN photosynthesis (rank ${photoRank}) above cocido (rank ${cocidoRank})`);

const enOnly = await idx.search(qPhoto, 4, { lang: 'en' });
ok(enOnly.every((h) => h.lang === 'en'), 'filter lang=en returns only en');
const arxivOnly = await idx.search(qPhoto, 4, { source_type: 'arxiv' });
ok(arxivOnly.every((h) => h.source_type === 'arxiv') && arxivOnly.length === 1, 'filter source_type=arxiv returns only arxiv');

const byNode = await idx.countByNode(['node_test', 'nope']);
ok(byNode.node_test === 4 && byNode.nope === 0, 'countByNode correct');
await idx.close();

console.log(`\n[result] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
