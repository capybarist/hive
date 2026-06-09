/**
 * PersonalMemorySource — the operator's own data as a single, opt-in connector.
 *
 * Roadmap #2. Rather than one source per provider, this is an UMBRELLA: it holds
 * a set of {@link PersonalMemoryReader}s (Claude transcripts, Claude memory
 * files, …, later Gemini/ChatGPT/Obsidian/shell) and exposes them as ONE entry
 * with a `multiselect` scope — so the operator sees a single "Personal memory"
 * source and ticks exactly what to ingest. Adding a provider = one small reader
 * module appended to `READERS` (or, later, an external one via HIVE_FORAGER_PLUGINS).
 *
 * URL namespace: `personal://<readerId>/<path>` — `seed` fans out to the enabled
 * readers, `fetch` dispatches back to the owning reader.
 *
 * PRIVACY — this ingests personal data. A bee declaring `personal-memory` MUST
 * run on a private queen/topic (never the public commons). The connector only
 * reads local files and logs a one-time warning; swarm visibility is the bee
 * manifest's responsibility (v0.9.3 privacy gate + v0.9.4 private topics). There
 * is no corroboration model — personal data is single-author by definition.
 */
import type {
  FetchResult,
  ForagerSource,
  SeedOptions,
  VerbatimFragment,
} from './source.js';
import type { PersonalMemoryReader } from './personal/reader.js';
import { PERSONAL_SCHEME, parsePersonalUrl } from './personal/reader.js';
import { claudeConversationsReader } from './personal/claude_conversations_reader.js';
import { claudeFilesReader } from './personal/claude_files_reader.js';

/** Registered readers. Order = display order in the multiselect. */
const READERS: PersonalMemoryReader[] = [
  claudeConversationsReader,
  claudeFilesReader,
  // Coming next: gemini, chatgpt-export, obsidian-notes, shell-history, cursor.
];
const BY_ID = new Map<string, PersonalMemoryReader>(READERS.map((r) => [r.id, r]));

const TTL_SECONDS = 365 * 24 * 3600;   // personal data is immutable history
let warnedPrivacy = false;

/** Which readers are enabled for this bee — `scope.include`, or all by default. */
function enabledReaders(scope?: Record<string, unknown>): PersonalMemoryReader[] {
  const include = scope?.include;
  if (Array.isArray(include) && include.length > 0) {
    const want = new Set(include.filter((x): x is string => typeof x === 'string'));
    return READERS.filter((r) => want.has(r.id));
  }
  return READERS; // none chosen ⇒ everything (a personal queen wants it all)
}

export class PersonalMemorySource implements ForagerSource {
  readonly id = 'personal-memory';
  readonly displayName = 'Personal memory';

  describe() {
    return {
      id: 'personal-memory',
      displayName: this.displayName,
      icon: '🧠',
      kind: 'search' as const,
      sourceType: 'personal-memory',
      defaultLanguages: ['en'],
      seedLimit: 30,
      scope: {
        field: 'include',
        label: 'What to include',
        placeholder: '',
        input: 'multiselect' as const,
        help: 'Pick which of your local sources to index. Runs PRIVATE only — never put this on a public queen.',
        options: READERS.map((r) => ({ value: r.id, label: r.label, help: r.help })),
        defaultSelected: READERS.map((r) => r.id),
      },
    };
  }

  owns(url: string): boolean {
    const p = parsePersonalUrl(url);
    return !!p && BY_ID.has(p.readerId);
  }

  normalize(url: string): string {
    return url.split('#')[0]!;
  }

  partitions(): string[] {
    return ['*'];
  }
  isInPartition(): boolean {
    return true;
  }

  async seed(opts: SeedOptions): Promise<string[]> {
    const readers = enabledReaders(opts.scope);
    if (!warnedPrivacy) {
      warnedPrivacy = true;
      console.warn(
        `[personal-memory] indexing PERSONAL data (${readers.map((r) => r.id).join(', ') || 'none'}) — ` +
        `this bee MUST run on a private queen/topic, never the public commons.`,
      );
    }
    if (readers.length === 0) return [];
    const limit = opts.limit ?? this.describe().seedLimit ?? 30;
    const per = Math.max(1, Math.ceil(limit / readers.length));
    const urls: string[] = [];
    for (const r of readers) {
      try {
        urls.push(...(await r.seed(per)));
      } catch (err) {
        console.warn(`[personal-memory] reader ${r.id} seed failed: ${(err as Error)?.message ?? err}`);
      }
    }
    return urls.slice(0, limit);
  }

  async fetch(url: string): Promise<FetchResult> {
    const p = parsePersonalUrl(url);
    const reader = p ? BY_ID.get(p.readerId) : undefined;
    if (!reader) throw new Error(`PersonalMemorySource: no reader for ${url}`);
    const fragments: VerbatimFragment[] = await reader.fetch(url);
    return { fragments, outboundLinks: [], refreshPolicy: { ttlSeconds: TTL_SECONDS } };
  }
}

export const personalMemorySource = new PersonalMemorySource();
export { PERSONAL_SCHEME };
