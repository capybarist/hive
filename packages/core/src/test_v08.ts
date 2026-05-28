// v0.8 signing test: the embedding vector is part of the signed payload.
// Run: npx tsx src/test_v08.ts
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from './node_identity.js';
import { buildSignedFragmentV08, verifyFragmentV08 } from './fragment_v08.js';
import { contentHash } from './content_hash.js';
import type { FragmentV08Input } from './schema_v08.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), 'hive-v08-')));

const input: FragmentV08Input = {
  id: 'wiki_photosynthesis_intro_c0',
  node_id: id.nodeId,
  node_pubkey: id.publicKeyHex,
  text: 'Photosynthesis converts light energy into chemical energy in plants.',
  lang: 'en',
  title: 'Photosynthesis — Introduction',
  source: 'wikipedia-en',
  source_type: 'wikipedia',
  url: 'https://en.wikipedia.org/wiki/Photosynthesis',
  identifiers: { },
  retrieved_at: new Date().toISOString(),
  section_path: ['Introduction'],
  chunk_index: 0,
  chunk_count: 1,
  extracted_at: new Date().toISOString(),
  ttl_seconds: 7 * 24 * 3600,
  confidence: 0.9,
};
const dummyVector = Buffer.from(new Uint8Array(1536)).toString('base64'); // 768 fp16

console.log('\n[v0.8 signing]');
const frag = buildSignedFragmentV08(input, dummyVector, id);
ok(frag.schema_version === 2, 'schema_version = 2');
ok(frag.embedding_model === 'intfloat/multilingual-e5-base', 'embedding_model set');
ok(frag.vector === dummyVector, 'vector stored inline');
ok(frag.node_pubkey === id.publicKeyHex, 'node_pubkey set');
ok(!!frag.hash && !!frag.signature, 'hash + signature present');
ok(verifyFragmentV08(frag, id.publicKeyHex), 'signature verifies (vector included)');

console.log('\n[tamper detection]');
ok(!verifyFragmentV08({ ...frag, vector: Buffer.from(new Uint8Array(1536).fill(1)).toString('base64') }, id.publicKeyHex),
  'tampering the VECTOR breaks verification');
ok(!verifyFragmentV08({ ...frag, text: 'Mitochondria produce ATP.' }, id.publicKeyHex),
  'tampering the TEXT breaks verification');
ok(!verifyFragmentV08(frag, 'deadbeef'.repeat(20)), 'wrong pubkey fails');

console.log('\n[content_hash]');
ok(contentHash('Photosynthesis  converts\n\nlight.') === contentHash('Photosynthesis converts light.'),
  'whitespace-invariant (corroboration)');
ok(frag.content_hash === contentHash(input.text), 'fragment content_hash matches text');

console.log(`\n[result] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
