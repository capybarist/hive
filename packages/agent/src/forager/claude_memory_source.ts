/**
 * ClaudeMemorySource — personal Claude conversations as a ForagerSource.
 *
 * The first "personal memory" connector (roadmap #2, v1 = Claude only). It reads
 * Claude Code conversation transcripts from the LOCAL filesystem and emits the
 * verbatim user prompts + assistant answers as fragments, so they become
 * queryable through the queen / MCP ("what did I conclude about X last week?").
 *
 * Transcript layout (Claude Code): `<projectsDir>/<project>/<sessionId>.jsonl`,
 * one JSON event per line. We index only `type:'user'` and `type:'assistant'`
 * events and, within them, only `text` content — `thinking`, `tool_use` and
 * `tool_result` blocks are internal noise and are skipped.
 *
 * PRIVACY — read this before deploying:
 *   This source ingests your personal conversations. A bee declaring it MUST run
 *   on a PRIVATE queen / private topic (never the public commons), or you will
 *   publish your chat history to the network. The connector only ever READS
 *   local files; it does not decide swarm visibility — the bee manifest does
 *   (see v0.9.3 privacy gate + v0.9.4 private topics). There is no corroboration
 *   model here (personal data is single-author by definition).
 *
 * Config:
 *   HIVE_CLAUDE_PROJECTS_DIR  override the transcript root
 *                             (default: ~/.claude/projects). In Docker you must
 *                             bind-mount your host ~/.claude/projects in and set
 *                             this; npx/local installs see it directly.
 *
 * Determinism: a turn's fragment id is `claude_<sessionId>_m<seq>` (seq = its
 * order among indexed turns in the session). Existing turns keep their ids as a
 * live session grows; only new turns add new fragments. Re-fetch is idempotent.
 */
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';
import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const URL_SCHEME = 'claude-session://';
/** Turns shorter than this (after trim) are skipped as noise ("ok", "yes"). */
const MIN_TURN_CHARS = 16;

function projectsDir(): string {
  return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

/** `claude-session://<project>/<sessionId>` ⇄ {project, sessionId}. */
function buildSessionUrl(project: string, sessionId: string): string {
  return `${URL_SCHEME}${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}`;
}
function parseSessionUrl(url: string): { project: string; sessionId: string } | null {
  if (!url.startsWith(URL_SCHEME)) return null;
  const rest = url.slice(URL_SCHEME.length).split('#')[0]!;
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  try {
    return {
      project: decodeURIComponent(rest.slice(0, slash)),
      sessionId: decodeURIComponent(rest.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * Pull readable text out of a Claude message `content` (string, or an array of
 * blocks). Keeps `text` blocks only; drops thinking / tool_use / tool_result /
 * images. Joins multiple text blocks with blank lines.
 */
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

let warnedPrivacy = false;

export class ClaudeMemorySource implements ForagerSource {
  readonly id = 'claude-memory';
  readonly displayName = 'Claude conversations';

  describe() {
    return {
      id: 'claude-memory',
      displayName: this.displayName,
      icon: '🧠',
      kind: 'search' as const,
      sourceType: 'claude-memory',
      defaultLanguages: ['en'],
      seedLimit: 20,
      // Personal source: no operator-facing scope field. A bee either indexes
      // its local Claude transcripts or it doesn't. (Project filtering can be a
      // later scope field; v1 indexes every session under the projects dir.)
      scope: null,
    };
  }

  owns(url: string): boolean {
    return url.startsWith(URL_SCHEME);
  }

  normalize(url: string): string {
    // Drop the per-turn #anchor; the session file is the fetch unit.
    return url.split('#')[0]!;
  }

  /** Not partitionable in v1 — one personal corpus. */
  partitions(): string[] {
    return ['*'];
  }
  isInPartition(): boolean {
    return true;
  }

  /**
   * Enumerate local Claude session transcripts as `claude-session://…` URLs.
   * Deterministic order (project, then sessionId) so the bee progresses through
   * the corpus across cycles instead of re-seeding the same files.
   */
  async seed(opts: SeedOptions): Promise<string[]> {
    if (!warnedPrivacy) {
      warnedPrivacy = true;
      console.warn(
        `[claude-memory] indexing PERSONAL conversations from ${projectsDir()} — ` +
        `this bee MUST run on a private queen/topic (never the public commons).`,
      );
    }
    const root = projectsDir();
    let projects: string[];
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      projects = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err) {
      console.warn(`[claude-memory] cannot read ${root}: ${(err as Error)?.message ?? err}`);
      return [];
    }
    const urls: string[] = [];
    for (const project of projects) {
      let files: string[];
      try {
        files = (await fsp.readdir(join(root, project)))
          .filter((f) => f.endsWith('.jsonl'))
          .sort();
      } catch {
        continue;
      }
      for (const f of files) urls.push(buildSessionUrl(project, basename(f, '.jsonl')));
    }
    const limit = opts.limit ?? this.describe().seedLimit ?? 20;
    return urls.slice(0, limit);
  }

  /**
   * Parse one session transcript into per-turn verbatim fragments (user prompts
   * + assistant text answers). Internal `thinking`/tool blocks are skipped.
   */
  async fetch(url: string): Promise<FetchResult> {
    const parsed = parseSessionUrl(url);
    if (!parsed) throw new Error(`ClaudeMemorySource: not a claude-session URL: ${url}`);
    const { project, sessionId } = parsed;
    const file = join(projectsDir(), project, `${sessionId}.jsonl`);

    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      console.warn(`[claude-memory] cannot read session ${sessionId}: ${(err as Error)?.message ?? err}`);
      return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
    }

    const fragments: VerbatimFragment[] = [];
    let seq = 0;
    const shortId = sessionId.slice(0, 8);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const type = ev.type;
      if (type !== 'user' && type !== 'assistant') continue;
      const msg = ev.message;
      if (!msg || typeof msg !== 'object') continue;
      const text = extractText((msg as Record<string, unknown>).content);
      if (text.length < MIN_TURN_CHARS) continue;
      const role = type === 'user' ? 'You' : 'Claude';
      fragments.push({
        id: `claude_${sessionId}_m${seq}`,
        text,
        source: `${buildSessionUrl(project, sessionId)}#m${seq}`,
        title: `Claude conversation ${shortId} — ${role}`,
        doi: null,
        confidence: 0.9,
      });
      seq++;
    }
    // Conversations are immutable history; re-fetch only to pick up appended
    // turns in a still-open session. A long TTL keeps churn low.
    return { fragments, outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
  }
}

export const claudeMemorySource = new ClaudeMemorySource();
