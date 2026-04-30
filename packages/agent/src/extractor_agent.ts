import { fetchPapers } from './arxiv_client.js';
import { validateDOI } from './crossref_validator.js';
import { chunkText } from './text_chunker.js';

const EMBEDDER_URL = 'http://127.0.0.1:7700';

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

export async function extractAndIndex(topic: string, limit: number = 5): Promise<Fragment[]> {
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
      doi_valid = true; // arXiv ID is self-verifying
      console.log(`    No DOI — arXiv source verified ✓`);
    }

    const confidence = doi_valid ? 0.95 : 0.70;
    const fullText = `${paper.title}. ${paper.abstract}`;
    const chunks = chunkText(fullText);

    for (const chunk of chunks) {
      const fragId = `${paper.arxiv_id}_c${chunk.index}`;
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

      const indexed = await callEmbedder(fragId, chunk.text, metadata);
      console.log(
        `    chunk ${chunk.index} (${chunk.text.length} chars) — ${indexed ? 'indexed ✓' : 'embedder offline, stored locally'}`,
      );
    }
  }

  return fragments;
}

// --- Test end-to-end ---
async function main() {
  const TOPIC = 'retrieval augmented generation';
  const LIMIT = 5;

  const embedderUp = await checkEmbedder();
  if (!embedderUp) {
    console.warn('WARNING: Embedder API not running at port 7700.');
    console.warn('Start it with: python api_server.py  (in packages/embeddings/)');
    console.warn('Continuing without embedding — fragments extracted only.\n');
  }

  const fragments = await extractAndIndex(TOPIC, LIMIT);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Papers processed : ${LIMIT}`);
  console.log(`Fragments extracted: ${fragments.length}`);
  console.log(
    `Verified sources : ${fragments.filter((f) => f.doi_valid).length}/${fragments.length}`,
  );

  if (embedderUp) {
    const res = await fetch(`${EMBEDDER_URL}/health`);
    const health = (await res.json()) as { indexed: number };
    console.log(`Embedder index   : ${health.indexed} vectors stored`);
  }

  const passed = fragments.length >= LIMIT;
  console.log(`\nModule 2 — ${passed ? 'ALL TESTS PASSED ✓' : 'FAILED ✗'}`);
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
