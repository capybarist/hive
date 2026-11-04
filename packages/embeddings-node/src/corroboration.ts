// HIVE v1.5 — score-by-corroboration (ROADMAP §3, issue #2).
//
// WHY: with a shared chunker_version, two bees that read the same source
// produce byte-identical chunks, hence the same content_hash (schema v2). Until
// now the queen ranked those copies by cosine only, so the strongest signal a
// network of independent bees has — "several of us signed exactly this text" —
// was thrown away, and the duplicates crowded each other out of the top-k.
//
// WHAT: at query time, for each candidate's content_hash, count the DISTINCT
// node_ids that signed it anywhere in the index; collapse identical texts into
// a single result (the best-scoring copy); and rank by
//     corroboration_score = cos_sim × ln(1 + corroboration_count)
// `score` stays the raw e5 cosine, because the retrieval gate's RELEVANT_SCORE
// threshold is calibrated on it.
//
// The chunker_version condition: corroboration only means something between
// bees that chunk identically, and that is exactly what a content_hash match
// encodes — the hash is over the chunk's normalized text, so a match IS an
// identical chunk. Bees on another chunker produce different boundaries and
// simply don't match; there is nothing to exclude after the fact.
//
// OPT-IN (HIVE_CORROBORATION=on): off, /api/query is unchanged byte for byte.
import type { SearchHit } from './vector_index.js';

const TRUTHY = new Set(['on', '1', 'true', 'yes']);
export function corroborationEnabled(): boolean {
  return TRUTHY.has((process.env.HIVE_CORROBORATION ?? '').trim().toLowerCase());
}

/** Candidates fetched before dedup + re-scoring. Both shrink/reorder the list,
 *  so recall must be wider than k for the boost to have anything to promote. */
export function corroborationPool(k: number): number {
  const fromEnv = Number(process.env.HIVE_CORROBORATION_POOL);
  return Math.max(Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 40, k);
}

export function corroborationScore(cos: number, count: number): number {
  return cos * Math.log(1 + Math.max(1, count));
}

/**
 * Dedupe identical texts (same content_hash) down to the best-scoring copy and
 * annotate each survivor with its corroboration count and score. Survivors keep
 * the position of their first copy (callers sort afterwards if they want the boost).
 * A hit with no content_hash is its own group, counted as one signer.
 */
export function dedupeAndAnnotate<T extends SearchHit>(hits: T[], counts: Map<string, number>): T[] {
  const best = new Map<string, T>();
  const signers = new Map<string, Set<string>>();
  hits.forEach((h, i) => {
    const key = h.content_hash ? `h:${h.content_hash}` : `i:${i}`;
    let set = signers.get(key);
    if (!set) signers.set(key, (set = new Set()));
    set.add(h.node_id);
    const prev = best.get(key);
    if (!prev || h.score > prev.score) best.set(key, h);
  });
  return [...best.entries()].map(([key, h]) => {
    // The index count covers every copy; the pool's own signers are a floor in
    // case the index lags behind what search returned.
    const count = Math.max(1, signers.get(key)!.size, h.content_hash ? counts.get(h.content_hash) ?? 0 : 0);
    return { ...h, corroboration_count: count, corroboration_score: corroborationScore(h.score, count) };
  });
}

/** Stable sort by corroboration_score, highest first. */
export function sortByCorroboration<T extends SearchHit>(hits: T[]): T[] {
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.corroboration_score ?? 0) - (a.h.corroboration_score ?? 0) || a.i - b.i)
    .map((x) => x.h);
}
