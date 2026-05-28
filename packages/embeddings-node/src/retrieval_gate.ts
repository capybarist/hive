// HIVE v0.8 — retrieval gate, recalibrated for multilingual-e5-base.
// The v0.7.7 gate (RELEVANT_SCORE = 0.45) was calibrated for MiniLM-L6-v2
// where cosine noise sits ~0.20-0.25. With e5 cosine compresses to 0.70-0.91
// (noise floor ~0.71, topical-but-off ~0.82, relevant ~0.90+) so the
// threshold moves up. The GATE LOGIC stays: score AND majority-keyword match,
// word-boundary, punctuation-stripped tokens. The LLM grounded-verdict
// (v0.7.7.4) remains the final word for the "Verified by HIVE" badge.

export const RELEVANT_SCORE = 0.82;

// Stop-words: short + question framing in ES/EN. Tokens shorter than 4 chars
// or in this list are dropped before matching.
const STOP_WORDS = new Set<string>([
  'que','sabe','como','para','sobre','cual','qué','cómo','dime','dame',
  'habla','sabes','conoces','tienes','tiene','hay',
  'what','know','about','tell','does','have','with','from','this','that',
  'which','when','where','find','show','give','more',
]);

function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Extract the meaningful query tokens (punctuation stripped, stop-words out). */
export function meaningfulTokens(question: string): string[] {
  return question.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/** Majority-token keyword gate. For N meaningful tokens, ceil(N/2) must
 *  appear in the haystack with word-boundary anchor on the start side. */
export function meetsKeywordGate(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const required = Math.ceil(tokens.length / 2);
  let n = 0;
  for (const t of tokens) {
    if (new RegExp(`\\b${escapeRegex(t)}`, 'i').test(haystack)) n++;
    if (n >= required) return true;
  }
  return false;
}

/** Mark a hit as relevant: score above threshold AND keyword majority. */
export function isRelevant(score: number, haystack: string, tokens: string[]): boolean {
  return score >= RELEVANT_SCORE && meetsKeywordGate(haystack, tokens);
}
