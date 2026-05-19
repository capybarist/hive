import { XMLParser } from 'fast-xml-parser';
import { fetchPapers } from './arxiv_client.js';
import { validateDOI } from './crossref_validator.js';
import { chunkText } from './text_chunker.js';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── v0.6 design note ────────────────────────────────────────────────────────
// Fetch tools (wikipedia_fetch, rss_fetch, arxiv_search, web_fetch) now call
// `onFragment` internally with VERBATIM content from the source — they do not
// return raw article text to the LLM. The tool's return value is a small
// summary ("indexed N sections of X"). The agent's LLM stops being the path
// that generates fragment.text, which means:
//   1. zero hallucination (text comes byte-for-byte from the source API)
//   2. ed25519 signatures actually prove "this is what the source said",
//      not just "node X said this"
//   3. ~10× throughput: one LLM call decides 5-50 fragments instead of one
//      LLM call per fragment
// The legacy `index_fragment` tool remains for cases where the LLM wants to
// index custom text (rare), but the SYSTEM_PROMPT no longer instructs the
// agent to use it after every fetch.

export type FragInput = {
  id: string;
  text: string;
  source: string;
  doi: string | null;
  confidence: number;
  title?: string;
};

export type OnFragment = (frag: FragInput) => Promise<void>;

// ── Tool definitions for the LLM (function-calling schema) ─────────────────
// `as const` would over-narrow; we want the literal 'object' on `type` so
// the array satisfies ToolDef[] from llm_provider.ts. Done via the helper.
type _TDLiteral = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; default?: unknown; nullable?: boolean }>;
    required: string[];
  };
};

export const TOOL_DECLARATIONS: _TDLiteral[] = [
  {
    name: 'arxiv_search',
    description: 'Search arXiv for papers on a topic. Each paper found is indexed automatically (verbatim abstract). Returns count + titles, NOT the abstracts themselves — the LLM does not need to read them.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "vector databases similarity search")' },
        limit: { type: 'number', description: 'Max papers to index (1-10)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'crossref_validate',
    description: 'Validate that a DOI exists in CrossRef. Returns true/false.',
    parameters: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI to validate (e.g. "10.1038/s41586-021-03380-7")' },
      },
      required: ['doi'],
    },
  },
  {
    name: 'wikipedia_fetch',
    description: 'Fetch a Wikipedia article and AUTO-INDEX every section verbatim. Returns the count of sections indexed and their titles, NOT the text. The LLM does not need to call index_fragment after this — it is already done.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Wikipedia article title, e.g. "Astrophysics" or "Black hole"' },
      },
      required: ['title'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a non-Wikipedia URL and AUTO-INDEX the content (chunked into ~200-token overlapping pieces, verbatim). Returns the number of chunks indexed, NOT the text. Do NOT use for Wikipedia — use wikipedia_fetch instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        confidence: { type: 'number', description: 'Confidence score 0-1 for fragments from this source', default: 0.7 },
      },
      required: ['url'],
    },
  },
  {
    name: 'rss_fetch',
    description: 'Fetch and AUTO-INDEX articles from an RSS or Atom feed (verbatim content). Returns count + titles, NOT the article text. Use for news sites, blogs, and any source with an RSS feed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RSS or Atom feed URL' },
        limit: { type: 'number', description: 'Max articles to index (default 15)', default: 15 },
      },
      required: ['url'],
    },
  },
  {
    name: 'index_fragment',
    description: 'Index ONE custom fragment. RARELY needed — the fetch tools auto-index. Use only if you have computed/derived text not coming from a fetch tool.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique ID for this fragment' },
        text: { type: 'string', description: 'Fragment text content (verbatim from source)' },
        source: { type: 'string', description: 'Source identifier (arXiv ID, URL, etc.)' },
        doi: { type: 'string', description: 'DOI if available', nullable: true },
        confidence: { type: 'number', description: 'Confidence score 0-1' },
        title: { type: 'string', description: 'Paper or article title' },
      },
      required: ['id', 'text', 'source', 'confidence'],
    },
  },
  {
    name: 'finish',
    description: 'Signal that the extraction session is complete. Provide a summary.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished in this session' },
        fragments_count: { type: 'number', description: 'Number of fragments indexed' },
      },
      required: ['summary', 'fragments_count'],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function hostnameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

// Tracks titles seen in this session to prevent duplicate indexing of the same
// article from different sources (e.g. RSS feed URL vs direct article URL).
const _seenTitles = new Set<string>();
export function resetSeenTitles() { _seenTitles.clear(); }

function maybeSkipTitle(title: string | undefined): boolean {
  if (!title) return false;
  const norm = title.trim().toLowerCase();
  if (!norm) return false;
  if (_seenTitles.has(norm)) return true;
  _seenTitles.add(norm);
  return false;
}

// ── Tool executor ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: {
    embedderUrl: string;
    onFragment?: OnFragment;
  },
): Promise<ToolResult> {
  const emit = options.onFragment ?? (async () => {});

  switch (name) {
    // ─── arxiv_search: auto-indexes each paper's full abstract ───────────────
    case 'arxiv_search': {
      try {
        const papers = await fetchPapers(args.query as string, (args.limit as number) ?? 5);
        const indexedTitles: string[] = [];
        for (const p of papers) {
          if (maybeSkipTitle(p.title)) continue;
          const id = `${p.arxiv_id}_c0`;
          await emit({
            id,
            text: p.abstract,            // verbatim — full abstract from arXiv API
            source: p.source,            // e.g. "arXiv:2405.12345"
            doi: p.doi ?? null,
            confidence: 0.7,
            title: p.title,
          });
          indexedTitles.push(p.title);
        }
        return {
          ok: true,
          data: {
            query: args.query,
            indexed_count: indexedTitles.length,
            titles: indexedTitles,
          },
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    case 'crossref_validate': {
      const valid = await validateDOI(args.doi as string);
      return { ok: true, data: { doi: args.doi, valid } };
    }

    // ─── wikipedia_fetch: auto-indexes each section verbatim ─────────────────
    case 'wikipedia_fetch': {
      try {
        const title = (args.title as string).trim();
        const encoded = encodeURIComponent(title.replace(/ /g, '_'));
        const res = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/mobile-sections/${encoded}`,
          {
            headers: { 'User-Agent': 'HIVE/0.6 (research crawler; mailto:capy@capybaralabs.tech)' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) return { ok: false, error: `Wikipedia API: HTTP ${res.status} for "${title}"` };
        const data = await res.json() as any;

        const clean = (html: string) =>
          html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const SKIP_SECTIONS = new Set([
          'references', 'see also', 'notes', 'external links',
          'further reading', 'bibliography', 'footnotes',
        ]);

        const articleSlug = slugify(title);
        const articleUrl = `https://en.wikipedia.org/wiki/${encoded}`;
        const indexed: string[] = [];

        // Lead / introduction
        const leadText = clean(data.lead?.sections?.[0]?.text ?? '').slice(0, 1200);
        if (leadText.length > 80) {
          await emit({
            id: `wiki_${articleSlug}_intro`,
            text: leadText,
            source: articleUrl,
            doi: null,
            confidence: 0.9,
            title: `${title} — Introduction`,
          });
          indexed.push('Introduction');
        }

        // Body sections
        for (const s of (data.remaining?.sections ?? [])) {
          const sTitle = clean(s.line ?? '');
          if (!sTitle || SKIP_SECTIONS.has(sTitle.toLowerCase())) continue;
          const content = clean(s.text ?? '').slice(0, 1000);
          if (content.length < 100) continue;
          const slug = slugify(sTitle);
          await emit({
            id: `wiki_${articleSlug}_${slug}`,
            text: content,
            source: articleUrl,
            doi: null,
            confidence: 0.9,
            title: `${title} — ${sTitle}`,
          });
          indexed.push(sTitle);
        }

        return {
          ok: true,
          data: {
            article: title,
            indexed_count: indexed.length,
            section_titles: indexed,
          },
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    // ─── web_fetch: chunk + auto-index verbatim ──────────────────────────────
    case 'web_fetch': {
      try {
        const url = args.url as string;
        const confidence = (args.confidence as number) ?? 0.7;

        const res = await fetch(url, {
          headers: { 'User-Agent': 'HIVE/0.6 (research crawler; mailto:capy@capybaralabs.tech)' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const html = await res.text();

        const stripHtml = (s: string) =>
          s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const text = stripHtml(html).slice(0, 30_000);

        // Recover a page title from <title>...</title>
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? stripHtml(titleMatch[1]).slice(0, 200) : undefined;

        if (maybeSkipTitle(pageTitle)) {
          return { ok: true, data: { url, indexed_count: 0, skipped: 'duplicate page title' } };
        }

        const chunks = chunkText(text, 200, 40);
        const host = hostnameFromUrl(url);
        const slug = slugify(pageTitle ?? url.replace(/^https?:\/\//, ''));
        for (const c of chunks) {
          await emit({
            id: `web_${host}_${slug}_c${c.index}`,
            text: c.text,                                // verbatim chunk
            source: url,
            doi: null,
            confidence,
            title: pageTitle,
          });
        }
        return {
          ok: true,
          data: {
            url,
            indexed_count: chunks.length,
            title: pageTitle ?? null,
          },
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    // ─── rss_fetch: auto-index each article verbatim ─────────────────────────
    case 'rss_fetch': {
      try {
        const url = args.url as string;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'HIVE/0.6 (knowledge crawler; mailto:capy@capybaralabs.tech)' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const xml = await res.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsed = parser.parse(xml);
        const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
        const rawItems = channel?.item ?? channel?.entry ?? [];
        const items: any[] = Array.isArray(rawItems) ? rawItems : [rawItems];
        const limit = Math.min((args.limit as number) ?? 15, 15);

        const feedHost = hostnameFromUrl(url);
        const indexedTitles: string[] = [];

        for (const item of items.slice(0, limit)) {
          // Prefer content:encoded (full article) over description (teaser)
          const fullContent = item['content:encoded'] ?? item.content?.['#text'] ?? item.content ?? '';
          const description = typeof item.description === 'string'
            ? item.description
            : item.description?.['#text'] ?? item.summary?.['#text'] ?? item.summary ?? '';
          const bodyText = (fullContent || description)
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          const title = (typeof item.title === 'string'
            ? item.title
            : item.title?.['#text'] ?? item.title?.['_'] ?? '').trim();

          if (!title || bodyText.length < 80) continue;
          if (maybeSkipTitle(title)) continue;

          const link = item.link?.['@_href']
            ?? (typeof item.link === 'string' ? item.link : '')
            ?? item.id
            ?? url;

          await emit({
            id: `rss_${feedHost}_${slugify(title)}`,
            text: bodyText,                              // verbatim article body
            source: link,
            doi: null,
            confidence: 0.85,
            title,
          });
          indexedTitles.push(title);
        }

        return {
          ok: true,
          data: {
            feed_url: url,
            indexed_count: indexedTitles.length,
            titles: indexedTitles,
          },
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    // ─── index_fragment: legacy/manual path for the rare custom-text case ───
    case 'index_fragment': {
      const title = (args.title as string | undefined)?.trim().toLowerCase() ?? '';
      if (title && _seenTitles.has(title)) {
        return { ok: true, data: { indexed: false, id: args.id, skipped: 'duplicate title' } };
      }
      if (title) _seenTitles.add(title);

      const rawDoi = args.doi as string | null | undefined;
      const doi = (rawDoi && rawDoi !== 'null' && rawDoi !== 'undefined' && rawDoi.startsWith('10.'))
        ? rawDoi
        : null;
      await emit({
        id: args.id as string,
        text: args.text as string,
        source: args.source as string,
        doi,
        confidence: args.confidence as number,
        title: args.title as string | undefined,
      });
      return { ok: true, data: { indexed: true, id: args.id } };
    }

    case 'finish':
      return { ok: true, data: args };

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
