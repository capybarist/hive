/**
 * PersonalMemoryReader — one source of the operator's own data, behind the
 * umbrella {@link PersonalMemorySource}. Each reader knows how to enumerate and
 * parse ONE kind of local artefact (Claude transcripts, Claude memory files,
 * Obsidian notes, ChatGPT export, …). The umbrella registers them, exposes them
 * as a `multiselect` scope ("what to include"), and dispatches by URL.
 *
 * All personal data is local-file-only and single-author — no corroboration,
 * and a bee declaring `personal-memory` MUST run private (see the umbrella).
 */
import type { VerbatimFragment } from '../source.js';

export const PERSONAL_SCHEME = 'personal://';

/** `personal://<readerId>/<path>` — `path` is percent-encoded. */
export function buildPersonalUrl(readerId: string, path: string, anchor?: string): string {
  const base = `${PERSONAL_SCHEME}${readerId}/${encodeURIComponent(path)}`;
  return anchor ? `${base}#${anchor}` : base;
}

export function parsePersonalUrl(url: string): { readerId: string; path: string } | null {
  if (!url.startsWith(PERSONAL_SCHEME)) return null;
  const rest = url.slice(PERSONAL_SCHEME.length).split('#')[0]!;
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  try {
    return { readerId: rest.slice(0, slash), path: decodeURIComponent(rest.slice(slash + 1)) };
  } catch {
    return null;
  }
}

export interface PersonalMemoryReader {
  /** Stable id — used in the multiselect scope and the personal:// namespace. */
  id: string;
  /** Label for the "what to include" checklist in the Settings UI. */
  label: string;
  /** Short hint (where it reads from) shown under the checkbox. */
  help: string;
  /** Enumerate this reader's document URLs (personal://<id>/…), up to `limit`. */
  seed(limit: number): Promise<string[]>;
  /** Parse one of this reader's URLs into verbatim fragments. */
  fetch(url: string): Promise<VerbatimFragment[]>;
}
