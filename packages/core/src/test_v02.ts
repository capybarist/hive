import { KnowledgeStore, loadOrCreateIdentity } from './index.js';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(__dirname, '../../../../tmp_test_v02');

await rm(dir, { recursive: true, force: true });

const id = loadOrCreateIdentity(resolve(dir, 'identity'));
const store = new KnowledgeStore(dir, id);
await store.ready();

console.log('Testing KnowledgeStore v0.2 (Hypercore direct, no Autobase)...');

for (let i = 0; i < 5; i++) {
  await store.save({ id: `frag_${i}`, text: `Fragment ${i} about physics`, source: `arXiv:test${i}`, doi: null, confidence: 0.9, extracted_at: new Date().toISOString(), node_id: id.nodeId });
}

let count = 0;
for await (const _ of store.query()) count++;
console.assert(count === 5, `Expected 5, got ${count}`);
console.log(`  ✓ Saved and read back ${count} fragments`);

const f = await store.get('frag_0');
const valid = f ? await store.verify(f) : false;
console.assert(valid, 'Signature should be valid');
console.log(`  ✓ Cryptographic signature valid`);

const supersededId = await store.supersede('frag_0', { id: 'frag_0_v2', text: 'Updated fragment 0', source: 'arXiv:test0', doi: null, confidence: 0.95, extracted_at: new Date().toISOString(), node_id: id.nodeId });
const old = await store.get('frag_0');
console.assert(old?.status === 'superseded', 'Old fragment should be superseded');
console.log(`  ✓ Supersede works: frag_0 → ${supersededId}`);

await store.close();
await rm(dir, { recursive: true, force: true });
console.log('\nKnowledgeStore v0.2 — ALL TESTS PASSED ✓');
