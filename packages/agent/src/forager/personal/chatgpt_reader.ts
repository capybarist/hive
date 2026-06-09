/**
 * ChatGPT data export → personal-memory fragments.
 *
 * Points at the `conversations.json` from a ChatGPT "Export data" download
 * (HIVE_CHATGPT_EXPORT). That file is an array of conversations; each has a
 * `mapping` of message nodes (a tree). We keep user/assistant text turns and
 * emit one fragment per turn, ordered by message create_time when present.
 *
 * NOTE: built defensively but NOT yet validated against a real export (none was
 * available at authoring). Returns [] on a missing/malformed file rather than
 * throwing. Unset env ⇒ inert.
 */
import type { VerbatimFragment } from '../source.js';
import type { PersonalMemoryReader } from './reader.js';
import { buildPersonalUrl, parsePersonalUrl } from './reader.js';
import { promises as fsp } from 'node:fs';

const ID = 'chatgpt';
const MIN_TURN_CHARS = 16;

function exportFile(): string | null {
  const f = process.env.HIVE_CHATGPT_EXPORT?.trim();
  return f && f.length ? f : null;
}

async function loadConversations(): Promise<any[]> {
  const f = exportFile();
  if (!f) return [];
  try {
    const parsed = JSON.parse(await fsp.readFile(f, 'utf-8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.conversations) ? parsed.conversations : []);
  } catch {
    return [];
  }
}

function convId(conv: any, idx: number): string {
  return String(conv?.conversation_id ?? conv?.id ?? `idx${idx}`);
}

/** Extract ordered user/assistant text turns from one conversation's mapping. */
function turnsOf(conv: any): { role: string; text: string }[] {
  const mapping = conv?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  const nodes = Object.values(mapping as Record<string, any>)
    .map((n) => n?.message)
    .filter((m) => m && typeof m === 'object');
  nodes.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  const out: { role: string; text: string }[] = [];
  for (const m of nodes) {
    const role = m?.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const c = m?.content;
    if (c?.content_type && c.content_type !== 'text') continue;
    const parts = Array.isArray(c?.parts) ? c.parts.filter((p: unknown) => typeof p === 'string') : [];
    const text = parts.join('\n\n').trim();
    if (text.length >= MIN_TURN_CHARS) out.push({ role: role === 'user' ? 'You' : 'ChatGPT', text });
  }
  return out;
}

export const chatgptReader: PersonalMemoryReader = {
  id: ID,
  label: 'ChatGPT export',
  help: 'A ChatGPT data export conversations.json — set HIVE_CHATGPT_EXPORT',

  async seed(limit: number): Promise<string[]> {
    const convs = await loadConversations();
    return convs.slice(0, limit).map((c, i) => buildPersonalUrl(ID, convId(c, i)));
  },

  async fetch(url: string): Promise<VerbatimFragment[]> {
    const parsed = parsePersonalUrl(url);
    if (!parsed) return [];
    const convs = await loadConversations();
    const idx = convs.findIndex((c, i) => convId(c, i) === parsed.path);
    if (idx < 0) return [];
    const conv = convs[idx];
    const short = parsed.path.slice(0, 8);
    return turnsOf(conv).map((t, seq) => ({
      id: `chatgpt_${parsed.path}_m${seq}`,
      text: t.text,
      source: buildPersonalUrl(ID, parsed.path, `m${seq}`),
      title: `ChatGPT ${short} — ${t.role}`,
      doi: null,
      confidence: 0.85,
    }));
  },
};
