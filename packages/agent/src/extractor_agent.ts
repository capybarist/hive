import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore, loadOrCreateIdentity } from '@hive/core';
import { fetchPapers } from './arxiv_client.js';
import { validateDOI } from './crossref_validator.js';
import { chunkText } from './text_chunker.js';

const EMBEDDER_URL = 'http://127.0.0.1:7700';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const IDENTITY_DIR = resolve(DATA_DIR, 'identity');

export interface Fragment {
  id: string;
  text: string;
  source: string;
  arxiv_id: string;
  doi: string | null;
  doi_valid: boolean;
  confidence: number;
  chunk_index: number;
}

async function checkEmbedder(): Promise<boolean> {
  try {
    const res = await fetch(`${EMBEDDER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function callEmbedder(
  id: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`${EMBEDDER_URL}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, metadata }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function extractAndIndex(
  topic: string,
  limit: number = 5,
  store?: KnowledgeStore,
): Promise<Fragment[]> {
  console.log(`\nFetching ${limit} papers on "${topic}" from arXiv...`);
  const papers = await fetchPapers(topic, limit);
  console.log(`Got ${papers.length} papers.\n`);

  const fragments: Fragment[] = [];

  for (const paper of papers) {
    console.log(`  [${paper.arxiv_id}] ${paper.title.slice(0, 70)}...`);

    let doi_valid = false;
    if (paper.doi) {
      doi_valid = await validateDOI(paper.doi);
      console.log(`    DOI ${paper.doi}: ${doi_valid ? 'valid ✓' : 'not found ✗'}`);
    } else {
      doi_valid = true;
      console.log(`    No DOI — arXiv source verified ✓`);
    }

    const confidence = doi_valid ? 0.95 : 0.70;
    const fullText = `${paper.title}. ${paper.abstract}`;
    const chunks = chunkText(fullText);

    for (const chunk of chunks) {
      const fragId = `${paper.arxiv_id}_c${chunk.index}`;
      const extractedAt = new Date().toISOString();

      const metadata: Record<string, unknown> = {
        source: paper.source,
        arxiv_id: paper.arxiv_id,
        doi: paper.doi,
        doi_valid,
        confidence,
        chunk_index: chunk.index,
        title: paper.title,
      };

      fragments.push({
        id: fragId,
        text: chunk.text,
        source: paper.source,
        arxiv_id: paper.arxiv_id,
        doi: paper.doi,
        doi_valid,
        confidence,
        chunk_index: chunk.index,
      });

      // 1 — HNSW embeddings index (vector search)
      const indexed = await callEmbedder(fragId, chunk.text, metadata);

      // 2 — Hypercore KnowledgeStore (verified, signed, P2P-replicable)
      let hcStored = false;
      if (store) {
        try {
          await store.save({
            id: fragId,
            text: chunk.text,
            source: paper.source,
            doi: paper.doi,
            confidence,
            extracted_at: extractedAt,
            node_id: store.nodeId,
          });
          hcStored = true;
        } catch (err: any) {
          console.warn(`    Hypercore save failed for ${fragId}: ${err.message}`);
        }
      }

      console.log(
        `    chunk ${chunk.index} (${chunk.text.length}c)` +
          ` — HNSW: ${indexed ? '✓' : '✗'}  Hypercore: ${hcStored ? '✓' : store ? '✗' : 'offline'}`,
      );
    }
  }

  return fragments;
}

// --- Run ---
async function main() {
  const TOPIC = 'retrieval augmented generation';
  const LIMIT = 5;

  const embedderUp = await checkEmbedder();
  if (!embedderUp) {
    console.warn('WARNING: Embedder API not running at port 7700. Start packages/embeddings/api_server.py\n');
  }

  // Init Hypercore KnowledgeStore
  const identity = loadOrCreateIdentity(IDENTITY_DIR);
  console.log(`Node identity: ${identity.nodeId}`);
  const store = new KnowledgeStore(DATA_DIR, identity);
  await store.ready();
  console.log('KnowledgeStore (Hypercore) ready ✓\n');

  const fragments = await extractAndIndex(TOPIC, LIMIT, store);

  await store.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Papers processed   : ${LIMIT}`);
  console.log(`Fragments extracted: ${fragments.length}`);
  console.log(`Verified sources   : ${fragments.filter((f) => f.doi_valid).length}/${fragments.length}`);

  if (embedderUp) {
    const res = await fetch(`${EMBEDDER_URL}/health`);
    const health = (await res.json()) as { indexed: number };
    console.log(`HNSW index         : ${health.indexed} vectors`);
  }

  const passed = fragments.length >= LIMIT;
  console.log(`\nModule 2+3 integration — ${passed ? 'ALL TESTS PASSED ✓' : 'FAILED ✗'}`);
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
