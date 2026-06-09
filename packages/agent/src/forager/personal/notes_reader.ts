/**
 * Markdown notes (Obsidian vault / any notes folder) → personal-memory fragments.
 *
 * Points at a local notes directory (HIVE_NOTES_DIR) and indexes every `.md`/
 * `.markdown` file, recursively. One fragment per file (the chunker splits long
 * ones). Plain, deterministic, format-agnostic — works for Obsidian, Logseq,
 * Bear exports, or a loose folder of notes. Unset env ⇒ reader is inert.
 */
import type { VerbatimFragment } from '../source.js';
import type { PersonalMemoryReader } from './reader.js';
import { buildPersonalUrl, parsePersonalUrl } from './reader.js';
import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const ID = 'notes';

function notesDir(): string | null {
  const d = process.env.HIVE_NOTES_DIR?.trim();
  return d && d.length ? d : null;
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export const notesReader: PersonalMemoryReader = {
  id: ID,
  label: 'Markdown notes',
  help: 'A local notes folder (Obsidian/etc.) — set HIVE_NOTES_DIR',

  async seed(limit: number): Promise<string[]> {
    const root = notesDir();
    if (!root) return [];
    let entries: string[];
    try {
      entries = (await fsp.readdir(root, { recursive: true }) as string[])
        .filter((f) => /\.(md|markdown)$/i.test(f)).sort();
    } catch {
      return [];
    }
    return entries.slice(0, limit).map((rel) => buildPersonalUrl(ID, rel));
  },

  async fetch(url: string): Promise<VerbatimFragment[]> {
    const parsed = parsePersonalUrl(url);
    const root = notesDir();
    if (!parsed || !root) return [];
    const file = join(root, parsed.path);
    let text: string;
    try { text = (await fsp.readFile(file, 'utf-8')).trim(); } catch { return []; }
    if (text.length < 16) return [];
    return [{
      id: `note_${shortHash(parsed.path)}`,
      text,
      source: buildPersonalUrl(ID, parsed.path),
      title: `Note — ${basename(parsed.path)}`,
      doi: null,
      confidence: 0.9,
    }];
  },
};
