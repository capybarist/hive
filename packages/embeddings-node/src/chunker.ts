// HIVE v0.8 — deterministic layout-based chunker.
// DETERMINISM IS THE CONTRACT: two bees running the same CHUNKER_VERSION over
// the same input MUST produce byte-identical chunks, so their content_hashes
// match and corroboration works. No randomness, no model, fixed thresholds.
import { CHUNKER_VERSION } from './schema.js';

export interface Section { heading_path: string[]; text: string; }
export interface Chunk { section_path: string[]; text: string; chunk_index: number; chunk_count: number; }

// Tuned for e5 (handles ~512 tokens well). Char-based for determinism.
const MAX_CHARS = 1800;     // hard cap per chunk
const MIN_CHARS = 200;      // below this, don't emit a standalone chunk (merge handled by caller granularity)
const OVERLAP_SENTENCES = 1; // carry the last sentence into the next chunk for context continuity

// Deterministic sentence split: end punctuation (.!?) + closing quote/paren,
// followed by whitespace. Keeps the delimiter with the sentence.
function splitSentences(text: string): string[] {
  const norm = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!norm) return [];
  const parts = norm.match(/[^.!?]+(?:[.!?]+["')\]]*|\s*$)/g);
  return (parts ?? [norm]).map((s) => s.trim()).filter(Boolean);
}

/** Chunk one section's text deterministically. */
function chunkSection(sectionPath: string[], text: string): Chunk[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const raw: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (candidate.length > MAX_CHARS && buf) {
      raw.push(buf);
      // overlap: start the next buffer with the last OVERLAP_SENTENCES of the previous chunk
      const prev = buf.split(' ');
      void prev; // (sentence-level overlap below)
      const tail = lastSentences(buf, OVERLAP_SENTENCES);
      buf = tail ? `${tail} ${s}` : s;
    } else {
      buf = candidate;
    }
  }
  if (buf) raw.push(buf);

  // Drop a trailing tiny fragment by merging into the previous chunk.
  if (raw.length > 1 && raw[raw.length - 1].length < MIN_CHARS) {
    raw[raw.length - 2] = `${raw[raw.length - 2]} ${raw[raw.length - 1]}`;
    raw.pop();
  }

  return raw.map((t, i) => ({ section_path: sectionPath, text: t, chunk_index: i, chunk_count: raw.length }));
}

function lastSentences(text: string, n: number): string {
  const s = splitSentences(text);
  return s.slice(Math.max(0, s.length - n)).join(' ');
}

/** Chunk a whole document (ordered sections) into deterministic fragments. */
export function chunkDocument(sections: Section[]): Chunk[] {
  const out: Chunk[] = [];
  for (const sec of sections) {
    for (const c of chunkSection(sec.heading_path, sec.text)) out.push(c);
  }
  return out;
}

export { CHUNKER_VERSION };
