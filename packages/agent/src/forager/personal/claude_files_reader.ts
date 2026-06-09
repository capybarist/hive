/**
 * Claude memory files → personal-memory fragments.
 *
 * Reads the CURATED per-project memory markdown that Claude maintains at
 * `<projectsDir>/<project>/memory/*.md` (MEMORY.md + the distilled fact files).
 * These are higher signal-per-byte than raw transcripts — already summarised
 * knowledge — so they make excellent personal-memory fragments. One fragment
 * per file; the downstream chunker splits long ones. id `claudemd_<hash>`.
 */
import type { VerbatimFragment } from '../source.js';
import type { PersonalMemoryReader } from './reader.js';
import { buildPersonalUrl, parsePersonalUrl } from './reader.js';
import { claudeProjectsDir } from './claude_paths.js';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ID = 'claude-memory-files';

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export const claudeFilesReader: PersonalMemoryReader = {
  id: ID,
  label: 'Claude memory files',
  help: 'Curated per-project memory markdown (~/.claude/projects/**/memory/*.md)',

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
      const memDir = join(root, project, 'memory');
      let files: string[];
      try {
        files = (await fsp.readdir(memDir)).filter((f) => f.endsWith('.md')).sort();
      } catch { continue; }
      for (const f of files) urls.push(buildPersonalUrl(ID, `${project}/memory/${f}`));
      if (urls.length >= limit) break;
    }
    return urls.slice(0, limit);
  },

  async fetch(url: string): Promise<VerbatimFragment[]> {
    const parsed = parsePersonalUrl(url);
    if (!parsed) return [];
    const file = join(claudeProjectsDir(), parsed.path);
    let text: string;
    try { text = (await fsp.readFile(file, 'utf-8')).trim(); } catch { return []; }
    if (text.length < 16) return [];
    const name = parsed.path.split('/').pop() ?? parsed.path;
    return [{
      id: `claudemd_${shortHash(parsed.path)}`,
      text,
      source: buildPersonalUrl(ID, parsed.path),
      title: `Claude memory — ${name}`,
      doi: null,
      confidence: 0.95,   // curated/distilled → slightly higher than raw transcripts
    }];
  },
};
