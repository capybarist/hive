const EMBEDDER = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Minimum score to show a fragment in the UI at all
const SHOW_THRESHOLD = 0.05;

// "In HIVE" mode requires at least MIN_RELEVANT_COUNT fragments above RELEVANT_SCORE.
// 0.35 is intentionally high: in a small homogeneous HNSW (e.g. only gaming news),
// unrelated queries can score 25-32% just because there's nothing better.
// A genuinely on-topic query scores 40-65% against relevant content.
const RELEVANT_SCORE = 0.35;
const MIN_RELEVANT_COUNT = 2;

export interface SearchResult {
  id: string;
  text: string;
  source: string;
  score: number;
  confidence: number;
  doi: string | null;
  doi_valid: boolean;
  title?: string;
  arxiv_id?: string;
  node_id?: string;
}

export interface QueryResult {
  fragments: SearchResult[];
  has_hive_data: boolean;
  embedder_online: boolean;
}

export async function isEmbedderOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${EMBEDDER}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function queryByText(question: string, topK = 5): Promise<QueryResult> {
  const online = await isEmbedderOnline();
  if (!online) return { fragments: [], has_hive_data: false, embedder_online: false };

  const res = await fetch(`${EMBEDDER}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: question, top_k: topK }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return { fragments: [], has_hive_data: false, embedder_online: true };

  const data = (await res.json()) as { results: any[]; count: number };

  const fragments: SearchResult[] = data.results
    .filter((r) => r.score > SHOW_THRESHOLD)
    .map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source ?? r.arxiv_id ?? 'unknown',
      score: r.score,
      confidence: r.confidence ?? 0.8,
      doi: r.doi ?? null,
      doi_valid: r.doi_valid ?? false,
      title: r.title,
      arxiv_id: r.arxiv_id,
      node_id: r.node_id,
    }));

  // Primary relevance: enough fragments score above threshold
  let has_hive_data = fragments.filter(f => f.score >= RELEVANT_SCORE).length >= MIN_RELEVANT_COUNT;

  // Fallback: exact keyword match in title/text overrides semantic threshold.
  // Semantic embeddings poorly handle rare proper nouns (e.g. "PathMoG", acronyms).
  if (!has_hive_data && fragments.length > 0) {
    const queryLower = question.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);
    has_hive_data = fragments.some(f => {
      const haystack = ((f.title ?? '') + ' ' + f.text).toLowerCase();
      return queryWords.every(w => haystack.includes(w));
    });
  }

  return { fragments, has_hive_data, embedder_online: true };
}

export async function getEmbedderStatus(): Promise<{ indexed: number; model: string } | null> {
  try {
    const res = await fetch(`${EMBEDDER}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as any) : null;
  } catch {
    return null;
  }
}
