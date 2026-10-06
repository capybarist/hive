// HIVE — lexical (BM25) candidate stage for hybrid retrieval.
//
// WHY: e5 recalls by meaning, and on a homogeneous corpus that is exactly where
// it fails — on the Acquis legal index, 11 of 12 failing golden questions never
// had the answering provision among e5's top 40 candidates ("credit scoring" vs
// Annex III point 5(b), which literally says "credit score"), so no reranker
// could promote it. A word-overlap ranking recalls those, and the two lists are
// fused (RRF, in queen_index.ts) before the cross-encoder picks the final order.
//
// In-memory and OPT-IN (HIVE_HYBRID=on), like the reranker: postings for a
// ~10k-fragment corpus are a few MB, but HIVE also serves far larger corpora
// whose operators should choose that cost. Built lazily from the index on the
// first query and rebuilt after writes; nothing is persisted.

const TRUTHY = new Set(['on', '1', 'true', 'yes']);
export function hybridEnabled(): boolean {
  return TRUTHY.has((process.env.HIVE_HYBRID ?? '').trim().toLowerCase());
}

/** Lexical candidates fused with the vector candidates (HIVE_HYBRID_LEXICAL_K). */
export function lexicalK(): number {
  const v = Number(process.env.HIVE_HYBRID_LEXICAL_K);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20;
}

// Function words that carry no retrieval signal. Short on purpose: legal text
// gives weight to words a generic list would drop ("shall", "may", "within").
const STOP = new Set(('a an and are as at be been by can do does for from has have how i if in into is it its ' +
  'me my of on or our so that the their them then there these this those to us was we what when where which ' +
  'who why will with you your').split(' '));

/** Light suffix stripping, applied identically to documents and queries — it
 *  only has to be consistent, not linguistically complete: "labelled",
 *  "labels" and "label" meet; "notification"/"notify" do not (e5 covers those). */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ied') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  // "labelled" → "labell" → "label"; "processed" → "process".
  if (w.length > 4 && w.at(-1) === w.at(-2) && !'sl'.includes(w.at(-1)!)) w = w.slice(0, -1);
  if (w.endsWith('ll') && w.length > 5) w = w.slice(0, -1);
  // "score"/"scoring", "device"/"devices" meet on the same stem.
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Okapi BM25 over (id, text) documents.
 *
 *  Postings are packed into typed arrays once built: a Map of [doc, tf] tuple
 *  arrays costs ~60 bytes per posting in V8, which on a 10k-fragment legal
 *  corpus (~1M postings) is tens of MB the queen cannot spare; packed it is
 *  6 bytes per posting. */
export class Bm25 {
  private postings = new Map<string, { docs: Uint32Array; tfs: Uint16Array }>();
  private ids: string[] = [];
  private lengths: Uint32Array;
  private avgLen = 0;

  constructor(docs: Iterable<{ id: string; text: string }>, private k1 = 1.2, private b = 0.75) {
    const building = new Map<string, number[]>();   // term → doc, tf, doc, tf, … (packed SMIs)
    const lengths: number[] = [];
    let total = 0;
    for (const { id, text } of docs) {
      const doc = this.ids.length;
      const toks = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let list = building.get(t);
        if (!list) building.set(t, (list = []));
        list.push(doc, Math.min(n, 0xffff));
      }
      this.ids.push(id);
      lengths.push(toks.length);
      total += toks.length;
    }
    for (const [t, flat] of building) {
      const docs = new Uint32Array(flat.length / 2), tfs = new Uint16Array(flat.length / 2);
      for (let i = 0; i < docs.length; i++) { docs[i] = flat[2 * i]!; tfs[i] = flat[2 * i + 1]!; }
      this.postings.set(t, { docs, tfs });
    }
    this.lengths = Uint32Array.from(lengths);
    this.avgLen = this.ids.length ? total / this.ids.length : 0;
  }

  get size(): number { return this.ids.length; }

  /** Ids by descending BM25 score; only documents sharing a term with the query. */
  search(query: string, limit: number): Array<{ id: string; score: number }> {
    const n = this.ids.length;
    const scores = new Map<number, number>();
    for (const t of new Set(tokenize(query))) {
      const list = this.postings.get(t);
      if (!list) continue;
      const df = list.docs.length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < df; i++) {
        const doc = list.docs[i]!, tf = list.tfs[i]!;
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * this.lengths[doc]! / this.avgLen));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
      }
    }
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([doc, score]) => ({ id: this.ids[doc]!, score }));
  }
}

/** Reciprocal-rank fusion: rank lists from incomparable scorers (cosine, BM25)
 *  merge by position alone. k = 60 is the constant from the original paper. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + i + 1)));
  return fused;
}
