// v1.5 score-by-corroboration test: count + dedupe + ordering, over a real
// LanceDB index with synthetic vectors (no embedding model needed).
// Run: RUST_LOG=error tsx src/test_corroboration.ts
import { rmSync, existsSync } from 'node:fs';
import { LanceVectorIndex } from './lance_index.js';
import { EMBEDDING_DIM } from './schema.js';
import { contentHash } from './content_hash.js';
import { corroborationEnabled, corroborationPool, corroborationScore, dedupeAndAnnotate, sortByCorroboration } from './corroboration.js';
import type { IndexRecord, SearchHit } from './vector_index.js';

const DIR = './data/corroboration-test';
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
let pass = 0, fail = 0;
const ok = (c: boolean, msg: string) => { if (c) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } };

// Unit vector at angle θ from e0 in the (e0, e1) plane → cosine to e0 = cos θ.
const vec = (cos: number): number[] => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = cos; v[1] = Math.sqrt(1 - cos * cos);
  return v;
};
const QUERY = vec(1);

const SHARED = 'Photosynthesis converts light energy into chemical energy.';
const rec = (id: string, node: string, text: string, cos: number): IndexRecord => ({
  id, vector: vec(cos), text, title: '', url: `https://x/${id}`, source: 'wikipedia-en',
  source_type: 'wikipedia', lang: 'en', node_id: node, content_hash: contentHash(text), status: 'current',
});

console.log('\n[1] flag + pool');
{
  delete process.env.HIVE_CORROBORATION;
  ok(!corroborationEnabled(), 'off by default');
  process.env.HIVE_CORROBORATION = 'on';
  ok(corroborationEnabled(), 'HIVE_CORROBORATION=on enables');
  ok(corroborationPool(8) === 40 && corroborationPool(60) === 60, 'pool defaults to 40, never below k');
  ok(Math.abs(corroborationScore(0.9, 3) - 0.9 * Math.log(4)) < 1e-12, 'score = cos × ln(1 + n)');
}

console.log('\n[2] LanceDB corroborationCounts');
const idx = new LanceVectorIndex(DIR);
await idx.ready();
await idx.upsertBatch([
  // Same text signed by three distinct bees (one of them twice, under two ids).
  rec('a1', 'bee-A', SHARED, 0.84),
  rec('b1', 'bee-B', SHARED.replace(' ', '  '), 0.84),   // whitespace variant → same hash
  rec('c1', 'bee-C', SHARED, 0.84),
  rec('a2', 'bee-A', SHARED, 0.84),
  // A single-signer passage slightly closer to the query.
  rec('solo', 'bee-A', 'Chlorophyll absorbs mostly blue and red light.', 0.88),
  rec('far', 'bee-B', 'The cocido is a stew from Madrid.', 0.30),
]);
{
  const counts = await idx.corroborationCounts([contentHash(SHARED), contentHash('Chlorophyll absorbs mostly blue and red light.'), 'missing']);
  ok(counts.get(contentHash(SHARED)) === 3, `shared text: 3 distinct bees (got ${counts.get(contentHash(SHARED))})`);
  ok(counts.get(contentHash('Chlorophyll absorbs mostly blue and red light.')) === 1, 'solo text: 1 bee');
  ok(!counts.has('missing'), 'unknown hash absent');
  ok((await idx.corroborationCounts([])).size === 0, 'empty input → empty map');
  ok((await idx.corroborationCounts(["x' OR '1'='1"])).size === 0, 'hash value is escaped');
}

console.log('\n[3] search → dedupe → boost');
{
  const hits = await idx.search(QUERY, 40);
  ok(hits.every((h) => typeof h.content_hash === 'string' && h.content_hash.length > 0), 'search returns content_hash');
  const counts = await idx.corroborationCounts(hits.map((h) => h.content_hash ?? ''));
  const deduped = dedupeAndAnnotate(hits, counts);
  ok(deduped.length === 3, `4 copies of one text collapse to 1 (6 hits → ${deduped.length})`);
  const shared = deduped.find((h) => h.content_hash === contentHash(SHARED))!;
  ok(shared.corroboration_count === 3, 'survivor carries corroboration_count = 3');
  ok(Math.abs(shared.score - 0.84) < 1e-3, '`score` stays the raw cosine (gate calibration)');
  ok(deduped[0].id === 'solo', 'before the boost, cosine order: solo first');
  const ranked = sortByCorroboration(deduped);
  ok(ranked[0].content_hash === contentHash(SHARED), 'after the boost: 3-bee text (0.84×ln4) beats 1-bee text (0.88×ln2)');
  ok(ranked[ranked.length - 1].id === 'far', 'far passage stays last');
}

console.log('\n[4] pure dedupe edge cases');
{
  const h = (id: string, node: string, hash: string | undefined, score: number): SearchHit => ({
    id, score, text: id, title: '', url: '', source: '', source_type: '', lang: '', node_id: node, ...(hash !== undefined ? { content_hash: hash } : {}),
  });
  const out = dedupeAndAnnotate([h('x1', 'A', 'H', 0.80), h('x2', 'B', 'H', 0.85), h('n1', 'A', undefined, 0.7), h('n2', 'A', '', 0.6)], new Map());
  ok(out.length === 3, 'missing/empty content_hash never merges');
  ok(out[0].id === 'x2' && out[0].corroboration_count === 2, 'keeps best-scoring copy; in-pool signers are a floor when the index lags');
  ok(out[1].corroboration_count === 1 && out[2].corroboration_count === 1, 'unhashed hits count as one signer');
}

await idx.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
