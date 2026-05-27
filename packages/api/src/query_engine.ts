const EMBEDDER = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Minimum score to show a fragment in the UI at all
const SHOW_THRESHOLD = 0.05;

// v0.7.7 — Retrieval gating. Two changes from v0.7.6:
//   1. RELEVANT_SCORE 0.30 → 0.45. The 0.30 was the noise floor of MiniLM
//      on a diverse HNSW, not a relevance signal. In Qdrant @ ~500k
//      mixed-language fragments, a Spanish query like "cocido madrileño"
//      scored 0.46-0.48 on completely unrelated articles (List of
//      regional anthems, Raquel Torres Cerdán, Verbano-Cusio-Ossola) —
//      above 0.30 AND above 0.45. So we need score + a second filter.
//   2. The OR between score and keyword in v0.7.6 was the dominant
//      false-positive source: ANY meaningful word appearing in ANY
//      fragment flipped `has_hive_data` to true and lit the "In HIVE ·
//      N sources" badge. Now the fragment must clear the score AND
//      mention at least one meaningful query token (word-boundary,
//      so "madrid" does not match "madridista"). When the query has
//      no meaningful tokens (rare; all words stop-listed), we fall
//      back to score-only.
const RELEVANT_SCORE = 0.45;

// Stop words filtered out before keyword matching (Spanish + English)
const STOP_WORDS = new Set([
  'que', 'sabe', 'como', 'para', 'sobre', 'cual', 'cuál', 'qué', 'cómo',
  'dime', 'dame', 'habla', 'sabes', 'conoces', 'tienes', 'tiene', 'hay',
  'what', 'know', 'about', 'tell', 'does', 'have', 'with', 'from', 'this',
  'that', 'which', 'when', 'where', 'find', 'show', 'give', 'more',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// v0.7.7.1 — count DISTINCT meaningful tokens that appear in the haystack.
// v0.7.7's `some()` was still too loose: for a 5-token query like
// "Latest advances in retrieval augmented generation", one token match
// ("retrieval" appearing in an article about expertise/memory retrieval)
// was enough to flip the fragment to relevant. We now require a majority
// of tokens — `ceil(N/2)` — to appear before we call it a match. For
// short queries (N=1 or 2) the threshold is still 1, so single-word and
// two-word queries behave like v0.7.7.
function countTokenHits(haystack: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    if (new RegExp(`\\b${escapeRegex(w)}`, 'i').test(haystack)) n++;
  }
  return n;
}

function meetsKeywordGate(haystack: string, words: string[]): boolean {
  if (words.length === 0) return true;
  const required = Math.ceil(words.length / 2);
  return countTokenHits(haystack, words) >= required;
}

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
    // v0.7.5.3 — bumped to 6 s. Under heavy /add_batch load the embedder's
    // /health response is GIL-blocked and exceeds 2 s. We were returning
    // embedder_online=false on a perfectly working embedder, which
    // short-circuited /api/query — so users saw "no fragments" while the
    // batched ingest was streaming /add_batch 200s through the same socket.
    const res = await fetch(`${EMBEDDER}/health`, { signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function queryByText(
  question: string,
  topK = 5,
  filters?: Record<string, unknown>,
): Promise<QueryResult> {
  // v0.7.5.3 — skip the pre-check entirely and let /search be the source of
  // truth. If the embedder is genuinely down the /search call below fails
  // and we return empty; the extra round-trip to /health bought us nothing
  // except a way to wrongly say "offline" when /health timed out under load.
  const res = await fetch(`${EMBEDDER}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: question, top_k: topK, ...(filters ? { filters } : {}) }),
    // v0.7.6.3 — bumped 15s → 45s. During the queen's catch-up replay
    // after a restart, /add_batch monopolises the Python GIL and /search
    // queues behind it. The previous 15s ate queries that would have
    // succeeded in 20-30s. 45s is the demo-safe ceiling: if /search
    // doesn't return by then the embedder is genuinely stuck and
    // returning empty is the right answer.
    signal: AbortSignal.timeout(45000),
  }).catch(() => null);

  if (!res || !res.ok) return { fragments: [], has_hive_data: false, embedder_online: false };

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

  const markedFragments = fragments.map(f => {
    // text always contains the title by indexing convention
    // ("Title. Abstract..."), but we concat both just in case the bee
    // stored them separately.
    const haystack = ((f.title ?? '') + ' ' + f.text).toLowerCase();
    return {
      ...f,
      relevant: f.score >= RELEVANT_SCORE && meetsKeywordGate(haystack, meaningful),
    };
  });

  const has_hive_data = markedFragments.some(f => f.relevant);

  // v0.7.7 — When nothing real matched, return zero fragments so the UI
  // doesn't render misleading source chips below an "answering from
  // general knowledge" response. The LLM client already builds a clean
  // "no verified data" prompt when has_hive_data is false; we just need
  // the API response to match.
  const filteredFragments = has_hive_data
    ? markedFragments.filter(f => f.relevant)
    : [];

  return { fragments: filteredFragments, has_hive_data, embedder_online: true };
}

export async function getEmbedderStatus(): Promise<{ indexed: number; model: string } | null> {
  try {
    // v0.7.6.3 — bumped 2s → 20s. The 2s timeout was originally fine because
    // /health responds in <50ms when the embedder is idle. Under the catch-up
    // replay /add_batch holds the GIL and /health queues behind it. With 2s
    // we wrongly reported the embedder offline (UI badge + indexed=0 in
    // /api/status). 20s lets /health win a GIL window before giving up.
    const res = await fetch(`${EMBEDDER}/health`, { signal: AbortSignal.timeout(20000) });
    return res.ok ? ((await res.json()) as any) : null;
  } catch {
    return null;
  }
}
