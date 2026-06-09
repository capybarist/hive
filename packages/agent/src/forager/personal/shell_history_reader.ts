/**
 * Shell history → personal-memory fragments.
 *
 * Reads ~/.bash_history and ~/.zsh_history (override HIVE_SHELL_HISTORY with a
 * comma-separated list of files). zsh's `: <ts>:<dur>;<cmd>` lines are unwrapped
 * to the bare command. One fragment per history file (the whole command list as
 * text; the chunker splits). OFF by default — history can contain secrets typed
 * on the command line; opt in deliberately.
 */
import type { VerbatimFragment } from '../source.js';
import type { PersonalMemoryReader } from './reader.js';
import { buildPersonalUrl, parsePersonalUrl } from './reader.js';
import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const ID = 'shell-history';

function historyFiles(): string[] {
  const env = process.env.HIVE_SHELL_HISTORY?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return [join(homedir(), '.bash_history'), join(homedir(), '.zsh_history')];
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
/** Strip the zsh extended-history prefix `: 1700000000:0;` if present. */
function cleanLine(line: string): string {
  const m = line.match(/^:\s*\d+:\d+;(.*)$/);
  return (m ? m[1]! : line).trim();
}

export const shellHistoryReader: PersonalMemoryReader = {
  id: ID,
  label: 'Shell history',
  help: 'Your shell command history (~/.bash_history, ~/.zsh_history) — may contain secrets',

  async seed(limit: number): Promise<string[]> {
    const urls: string[] = [];
    for (const f of historyFiles()) {
      try { await fsp.access(f); urls.push(buildPersonalUrl(ID, f)); } catch { /* absent */ }
      if (urls.length >= limit) break;
    }
    return urls;
  },

  async fetch(url: string): Promise<VerbatimFragment[]> {
    const parsed = parsePersonalUrl(url);
    if (!parsed) return [];
    let raw: string;
    try { raw = await fsp.readFile(parsed.path, 'utf-8'); } catch { return []; }
    const commands = raw.split('\n').map(cleanLine).filter((l) => l.length > 0);
    if (commands.length === 0) return [];
    const text = commands.join('\n');
    return [{
      id: `shell_${shortHash(parsed.path)}`,
      text,
      source: buildPersonalUrl(ID, parsed.path),
      title: `Shell history — ${basename(parsed.path)}`,
      doi: null,
      confidence: 0.6,   // low-signal, noisy
    }];
  },
};
