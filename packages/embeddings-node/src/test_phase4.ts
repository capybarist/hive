// v0.8 Phase 4 e2e: bee builds a signed fragment with INLINE vector via
// @hive/core; the queen module validates it (model match + signature),
// decodes the fp16 vector, upserts to LanceDB; query embeds, searches, and
// applies the recalibrated gate. Run: RUST_LOG=error npx tsx src/test_phase4.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity, buildSignedFragmentV08, EMBEDDING_MODEL, EMBEDDING_DIM, type FragmentV08Input } from '@hive/core';
import { embedPassage, warmup } from './embedder.js';
import { encodeVector } from './vector_codec.js';
import { QueenIndex } from './queen_index.js';
import { RELEVANT_SCORE } from './retrieval_gate.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

const idDir = mkdtempSync(join(tmpdir(), 'hive-v08-id-'));
const indexDir = mkdtempSync(join(tmpdir(), 'hive-v08-idx-'));
const id = loadOrCreateIdentity(idDir);

await warmup();

// ── Build v0.8 fragments end-to-end (real e5 vectors, real signing) ──
async function buildFragment(partial: Partial<FragmentV08Input> & { id: string; text: string; lang: string; source_type: string; url: string }) {
  const vec = await embedPassage(partial.text);
  const vectorB64 = encodeVector(vec);
  const input: FragmentV08Input = {
    id: partial.id,
    node_id: id.nodeId,
    node_pubkey: id.publicKeyHex,
    text: partial.text,
    lang: partial.lang,
    title: partial.id,
    source: 'wikipedia-en',
    source_type: partial.source_type,
    url: partial.url,
    retrieved_at: new Date().toISOString(),
    extracted_at: new Date().toISOString(),
    confidence: 0.9,
  };
  return buildSignedFragmentV08(input, vectorB64, id);
}

const fragments = await Promise.all([
  buildFragment({ id: 'photo', lang: 'en', source_type: 'wikipedia', url: 'https://x/photo',
    text: 'Photosynthesis is the process by which green plants convert light energy into chemical energy stored as glucose.' }),
  buildFragment({ id: 'mito', lang: 'en', source_type: 'wikipedia', url: 'https://x/mito',
    text: 'The mitochondrion is the organelle that generates most of the cell ATP through respiration.' }),
  buildFragment({ id: 'cocido', lang: 'es', source_type: 'wikipedia', url: 'https://x/cocido',
    text: 'El cocido madrileño es un guiso tradicional de Madrid elaborado con garbanzos, carnes y verduras.' }),
  buildFragment({ id: 'rag', lang: 'en', source_type: 'arxiv', url: 'https://x/rag',
    text: 'Retrieval augmented generation combines a retriever with a generative language model to ground answers.' }),
]);

console.log('\n[bee → queen ingest]');
const q = new QueenIndex(indexDir);
await q.ready();
const res = await q.upsertFragments(fragments, { pubkeyByNode: { [id.nodeId]: id.publicKeyHex } });
ok(res.added === 4 && res.skipped === 0, `upserted 4, skipped 0 (got added=${res.added} skipped=${res.skipped})`);
ok(await q.count() === 4, 'queen index size = 4');

// Model-mismatch fragment → must be dropped without indexing.
const bad = { ...fragments[0], id: 'bad', embedding_model: 'unknown/other-model' };
const resBad = await q.upsertFragments([bad as any]);
ok(resBad.added === 0 && resBad.skipped === 1, 'model-mismatch fragment skipped');

// Tampered fragment (vector mutated post-sign) with pubkey supplied → bad signature → skipped.
const tampered = { ...fragments[0], id: 'tampered', vector: encodeVector(new Array(EMBEDDING_DIM).fill(0.1)) };
const resTamp = await q.upsertFragments([tampered as any], { pubkeyByNode: { [id.nodeId]: id.publicKeyHex } });
ok(resTamp.added === 0 && resTamp.skipped === 1, 'tampered fragment rejected by signature check');

// ── Query: embed (queen-side) → search → recalibrated gate ──
console.log('\n[query: ranking + gate]');
const qPhoto = await q.query('What is photosynthesis?');
console.log('   ranking:', qPhoto.hits.map((h) => `${h.id}:${h.score.toFixed(3)}${h.relevant ? '✓' : '·'}`).join('  '));
ok(qPhoto.hits[0].id === 'photo', `top hit photo (got ${qPhoto.hits[0].id})`);
ok(qPhoto.hits[0].relevant, 'top hit flagged relevant');
ok(qPhoto.has_hive_data, 'has_hive_data = true');
const photoHit = qPhoto.hits.find((h) => h.id === 'photo')!;
const cocidoHit = qPhoto.hits.find((h) => h.id === 'cocido')!;
ok(photoHit.score >= RELEVANT_SCORE, `photo score ${photoHit.score.toFixed(3)} >= threshold ${RELEVANT_SCORE}`);
ok(!cocidoHit.relevant, `cocido NOT relevant (score ${cocidoHit.score.toFixed(3)}) — gate filters topical-noise`);

console.log('\n[cross-lingual]');
const qEs = await q.query('¿Qué es la fotosíntesis?');
const photoEs = qEs.hits.find((h) => h.id === 'photo')!;
ok(photoEs !== undefined, 'cross-lingual: EN photosynthesis returned for ES query');
ok(qEs.has_hive_data || photoEs.score >= 0.78, `cross-lingual photo score ${photoEs.score.toFixed(3)} — close to threshold (expected, ES↔EN compresses)`);

console.log('\n[unrelated query → no false "verified"]');
const qNone = await q.query('Guido Fanti Italian politician');
ok(!qNone.has_hive_data, `unrelated query: has_hive_data=false (gate works)`);

console.log(`\n[result] ${pass} passed, ${fail} failed`);
rmSync(idDir, { recursive: true, force: true });
rmSync(indexDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
