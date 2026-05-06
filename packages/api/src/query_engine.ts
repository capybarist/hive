const EMBEDDER = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Minimum score to show a fragment in the UI at all
const SHOW_THRESHOLD = 0.05;

// "In HIVE" if the TOP fragment scores above this threshold.
// Using top-1 (not count) because a small homogeneous HNSW can easily
// have 2+ fragments scoring 20-25% for any unrelated query.
// A genuinely relevant top result scores 35-65%; noise tops out at 25-30%.
const RELEVANT_SCORE = 0.35;
const MIN_RELEVANT_COUNT = 1;

// Stop words filtered out before keyword matching (Spanish + English)
const STOP_WORDS = new Set([
  'que', 'sabe', 'como', 'para', 'sobre', 'cual', 'cuál', 'qué', 'cómo',
  'dime', 'dame', 'habla', 'sabes', 'conoces', 'tienes', 'tiene', 'hay',
  'what', 'know', 'about', 'tell', 'does', 'have', 'with', 'from', 'this',
  'that', 'which', 'when', 'where', 'find', 'show', 'give', 'more',
]);

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
  relevant?: boolean; // true if this fragment actually contributed to the answer
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

  // Mark each fragment as relevant or not
  const meaningful = question.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  const markedFragments = fragments.map(f => ({
    ...f,
    relevant: f.score >= RELEVANT_SCORE ||
      (meaningful.length > 0 && meaningful.some(w => (f.title ?? '').toLowerCase().includes(w))),
  }));

  // "In HIVE" if any fragment is marked relevant
  const has_hive_data = markedFragments.some(f => f.relevant);

  // Only return fragments that are relevant — suppress noise from the response
  const filteredFragments = has_hive_data
    ? markedFragments.filter(f => f.relevant)
    : markedFragments.slice(0, 3); // show a few for context even in hybrid mode

  return { fragments: filteredFragments, has_hive_data, embedder_online: true };
}

export async function getEmbedderStatus(): Promise<{ indexed: number; model: string } | null> {
  try {
    const res = await fetch(`${EMBEDDER}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as any) : null;
  } catch {
    return null;
  }
}
