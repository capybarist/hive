const EMBEDDER = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Minimum score to include a fragment in the UI result list
const SHOW_THRESHOLD = 0.05;
// A query is considered "in HIVE" if at least MIN_RELEVANT_COUNT fragments
// score above RELEVANT_SCORE. This is more robust than a single top-score
// cutoff — an irrelevant query rarely gets multiple fragments above 0.09,
// while a genuinely on-topic query gets several.
const RELEVANT_SCORE = 0.09;
const MIN_RELEVANT_COUNT = 3;

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

  const has_hive_data = fragments.filter(f => f.score >= RELEVANT_SCORE).length >= MIN_RELEVANT_COUNT;
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
