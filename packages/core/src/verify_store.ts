import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore, loadOrCreateIdentity } from './index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');

console.log('DATA_DIR:', DATA_DIR);

const identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
console.log('Node:', identity.nodeId);

const store = new KnowledgeStore(DATA_DIR, identity);
await store.ready();

let count = 0;
for await (const f of store.query({ status: 'current', limit: 100 })) count++;
console.log('Fragments in Hypercore:', count);

if (count > 0) {
  const sample = await store.get('2604.26768v1_c0');
  if (sample) {
    const ok = await store.verify(sample);
    console.log('Sample:', sample.id);
    console.log('  source:', sample.source);
    console.log('  confidence:', sample.confidence);
    console.log('  hash:', sample.hash.slice(0, 16) + '...');
    console.log('  signature valid:', ok);
  }
}

await store.close();
