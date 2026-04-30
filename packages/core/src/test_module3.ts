import { rm } from 'node:fs/promises';
import { KnowledgeStore } from './knowledge_store.js';
import { loadOrCreateIdentity } from './node_identity.js';

const TEST_DATA_DIR = './tmp_test_m3';
const IDENTITY_DIR = `${TEST_DATA_DIR}/identity`;

async function run() {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });

  const identity = loadOrCreateIdentity(IDENTITY_DIR);
  const store = new KnowledgeStore(TEST_DATA_DIR, identity);
  await store.ready();

  console.log('\n--- Module 3: KnowledgeStore (Hypercore + Hyperbee + Autobase) ---\n');

  // 1. Save 20 fragments
  console.log('Saving 20 fragments...');
  const topics = ['machine learning', 'distributed systems', 'cryptography', 'RAG', 'embeddings'];
  const ids: string[] = [];

  for (let i = 0; i < 20; i++) {
    const topic = topics[i % topics.length];
    const id = await store.save({
      id: `frag_test_${String(i).padStart(3, '0')}`,
      text: `Fragment ${i} about ${topic}. This is test content for module 3 validation.`,
      source: `arXiv:2604.${10000 + i}`,
      doi: i % 3 === 0 ? `10.1234/test.${i}` : null,
      confidence: 0.9 + (i % 10) * 0.01,
      extracted_at: new Date(Date.now() - i * 60_000).toISOString(),
      node_id: identity.nodeId,
    });
    ids.push(id);
  }
  console.log(`Saved ${ids.length} fragments.\n`);

  // 2. Retrieve by ID
  console.log('Retrieving fragments by ID...');
  for (const id of [ids[0], ids[9], ids[19]]) {
    const f = await store.get(id);
    if (!f) throw new Error(`Fragment ${id} not found`);
    console.log(`  [${f.id}] status=${f.status} hash=${f.hash.slice(0, 12)}...`);
  }

  // 3. Verify signatures and hashes
  console.log('\nVerifying signatures and hashes...');
  let passed = 0;
  for (const id of ids) {
    const f = await store.get(id);
    if (!f) throw new Error(`Missing fragment ${id}`);
    const ok = await store.verify(f);
    if (!ok) throw new Error(`Verification FAILED for ${id}`);
    passed++;
  }
  console.log(`  PASS: all ${passed}/20 fragments verified.\n`);

  // 4. Query by source
  console.log('Querying by source (arXiv:2604.10000)...');
  const bySource: string[] = [];
  for await (const f of store.query({ source: 'arXiv:2604.10000' })) {
    bySource.push(f.id);
  }
  console.log(`  Found ${bySource.length} fragment(s) for source arXiv:2604.10000.`);

  // 5. Supersede
  console.log('\nSimulating supersede...');
  const oldId = ids[0];
  const newId = await store.supersede(oldId, {
    id: `frag_test_000_v2`,
    text: `Updated fragment 0 about machine learning (v2 — corrected content).`,
    source: `arXiv:2604.10000`,
    doi: null,
    confidence: 0.97,
    extracted_at: new Date().toISOString(),
    node_id: identity.nodeId,
  });

  const oldFrag = await store.get(oldId);
  const newFrag = await store.get(newId);
  if (oldFrag?.status !== 'superseded') throw new Error('Old fragment not marked superseded');
  if (oldFrag?.superseded_by !== newId) throw new Error('superseded_by not set correctly');
  if (newFrag?.status !== 'current') throw new Error('New fragment not current');
  if (!newFrag?.supersedes.includes(oldId)) throw new Error('supersedes not set correctly');

  console.log(`  Old fragment [${oldId}] → status: ${oldFrag.status}, superseded_by: ${oldFrag.superseded_by}`);
  console.log(`  New fragment [${newId}] → status: ${newFrag.status}, supersedes: [${newFrag.supersedes}]`);

  // 6. History
  const hist = await store.history(oldId);
  console.log(`\nHistory for ${oldId}: ${hist.length} historical record(s).`);

  // 7. Verify supersede integrity
  const newOk = await store.verify(newFrag!);
  if (!newOk) throw new Error('New fragment signature invalid after supersede');
  console.log('  New fragment signature: VALID ✓');

  await store.close();
  await rm(TEST_DATA_DIR, { recursive: true, force: true });

  console.log('\nModule 3 — ALL TESTS PASSED ✓');
}

run().catch((err) => {
  console.error('\nModule 3 — FAILED:', err);
  process.exit(1);
});
