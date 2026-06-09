/**
 * Claude Code conversation transcripts → personal-memory fragments.
 *
 * Reads `<projectsDir>/<project>/<sessionId>.jsonl` (one JSON event per line),
 * keeps `type:'user'|'assistant'` events and, within them, only `text` content
 * — `thinking`/`tool_use`/`tool_result` blocks are internal noise and skipped.
 * One fragment per turn; id `claude_<sessionId>_m<seq>` (deterministic; a live
 * session only appends new turns).
 */
import type { VerbatimFragment } from '../source.js';
import type { PersonalMemoryReader } from './reader.js';
import { buildPersonalUrl, parsePersonalUrl } from './reader.js';
import { claudeProjectsDir } from './claude_paths.js';
import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';

const ID = 'claude-conversations';
const MIN_TURN_CHARS = 16;

/** Pull readable text out of a Claude message `content` (string or block array). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n\n').trim();
}

export const claudeConversationsReader: PersonalMemoryReader = {
  id: ID,
  label: 'Claude conversations',
  help: 'Your Claude Code session transcripts (~/.claude/projects/**/*.jsonl)',

  async seed(limit: number): Promise<string[]> {
    const root = claudeProjectsDir();
    let projects: string[];
    try {
      projects = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
    const urls: string[] = [];
    for (const project of projects) {
      let files: string[];
      try {
        files = (await fsp.readdir(join(root, project))).filter((f) => f.endsWith('.jsonl')).sort();
      } catch { continue; }
      for (const f of files) urls.push(buildPersonalUrl(ID, `${project}/${basename(f, '.jsonl')}`));
      if (urls.length >= limit) break;
    }
    return urls.slice(0, limit);
  },

  async fetch(url: string): Promise<VerbatimFragment[]> {
    const parsed = parsePersonalUrl(url);
    if (!parsed) return [];
    const slash = parsed.path.indexOf('/');
    if (slash < 0) return [];
    const project = parsed.path.slice(0, slash);
    const sessionId = parsed.path.slice(slash + 1);
    const file = join(claudeProjectsDir(), project, `${sessionId}.jsonl`);

    let raw: string;
    try { raw = await fsp.readFile(file, 'utf-8'); } catch { return []; }

    const fragments: VerbatimFragment[] = [];
    let seq = 0;
    const shortId = sessionId.slice(0, 8);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (ev.type !== 'user' && ev.type !== 'assistant') continue;
      const msg = ev.message;
      if (!msg || typeof msg !== 'object') continue;
      const text = extractText((msg as Record<string, unknown>).content);
      if (text.length < MIN_TURN_CHARS) continue;
      const role = ev.type === 'user' ? 'You' : 'Claude';
      fragments.push({
        id: `claude_${sessionId}_m${seq}`,
        text,
        source: buildPersonalUrl(ID, `${project}/${sessionId}`, `m${seq}`),
        title: `Claude conversation ${shortId} — ${role}`,
        doi: null,
        confidence: 0.9,
      });
      seq++;
    }
    return fragments;
  },
};
