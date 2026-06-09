/** Shared location of the local Claude Code data. */
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Root of Claude Code transcripts + per-project memory. Override with
 * HIVE_CLAUDE_PROJECTS_DIR (required in Docker: bind-mount ~/.claude/projects).
 */
export function claudeProjectsDir(): string {
  return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}
