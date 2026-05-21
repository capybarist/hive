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

/**
 * Optional callback fired by tools that discover new article titles worth
 * crawling later (e.g. wikipedia_fetch extracts internal /wiki/ links).
 * Implementation in the agent layer typically pushes them onto a CrawlQueue
 * for processing in the next cycle.
 */
export type OnCrawlEnqueue = (titles: string[]) => void;

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
    name: 'wikipedia_search',
    description: 'Find Wikipedia articles related to a query — returns a list of candidate article titles to feed back into wikipedia_fetch. Use this FIRST when a topic is broad (e.g. "biodiversity") so you can explore multiple sub-articles instead of just the meta-article. Does NOT index anything by itself.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "biodiversity hotspots" or "stellar evolution"' },
        limit: { type: 'number', description: 'Max related titles to return (1-15)', default: 10 },
      },
      required: ['query'],
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

// Decode the HTML entities that survive after `<tag>` stripping. Wikipedia's
// parse API returns bracketed citation markers like `&#91; 10 &#93;` and other
// numeric refs we want to render as their actual characters so the indexed
// text reads naturally. Covers numeric entities (decimal + hex) plus a small
// named-entity table — enough for clean news/wiki text without pulling in a
// full HTML parser dep.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const num = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10FFFF) {
        try { return String.fromCodePoint(num); } catch { return full; }
      }
      return full;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? full;
  });
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
    onCrawlEnqueue?: OnCrawlEnqueue;
  },
): Promise<ToolResult> {
  const emit = options.onFragment ?? (async () => {});
  const enqueueCrawl = options.onCrawlEnqueue ?? (() => {});

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

    // ─── wikipedia_search: discover related articles for a query ─────────────
    // Returns candidate titles only — does not index. The agent calls this
    // first to enumerate sub-topics, then calls wikipedia_fetch on each title
    // to actually index. This lets one topic produce 5-10 articles' worth of
    // content instead of just the meta-article.
    case 'wikipedia_search': {
      try {
        const query = (args.query as string).trim();
        const limit = Math.min((args.limit as number) ?? 10, 15);
        const encoded = encodeURIComponent(query);
        const res = await fetch(
          `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=${limit}&format=json&origin=*`,
          {
            headers: { 'User-Agent': 'HIVE/0.6 (research crawler; mailto:capy@capybaralabs.tech)' },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) return { ok: false, error: `Wikipedia search API: HTTP ${res.status}` };
        const data = await res.json() as any;
        const results = (data?.query?.search ?? []) as Array<{ title: string; snippet?: string }>;
        const titles = results.map(r => r.title).slice(0, limit);
        return {
          ok: true,
          data: {
            query,
            count: titles.length,
            titles,
          },
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    // ─── wikipedia_fetch: auto-indexes each section verbatim ─────────────────
    // Uses the MediaWiki Action API (?action=parse) — the REST v1
    // mobile-sections endpoint was decommissioned in 2026 (phab T328036).
    case 'wikipedia_fetch': {
      try {
        const title = (args.title as string).trim();
        const encodedQs = encodeURIComponent(title);
        const res = await fetch(
          `https://en.wikipedia.org/w/api.php?action=parse&page=${encodedQs}&prop=sections%7Ctext&format=json&redirects=1&formatversion=2`,
          {
            headers: { 'User-Agent': 'HIVE/0.6 (research crawler; mailto:capy@capybaralabs.tech)' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) return { ok: false, error: `Wikipedia API: HTTP ${res.status} for "${title}"` };
        const data = await res.json() as any;
        if (data.error) return { ok: false, error: `Wikipedia API: ${data.error.code} ${data.error.info}` };

        const parse = data.parse;
        if (!parse?.text) return { ok: false, error: `No content for "${title}"` };
        // formatversion=2 returns text as string directly; v1 wrapped it in {"*": ...}
        const fullHtml: string = typeof parse.text === 'string' ? parse.text : (parse.text['*'] ?? '');
        const sections: Array<{ line: string; anchor: string; index: string }> = parse.sections ?? [];
        const resolvedTitle: string = parse.title ?? title;

        const clean = (html: string) =>
          decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

        // Extract Wikipedia internal article titles from the raw HTML BEFORE
        // we strip tags (the forager's source of new URLs). Matches:
        //   <a href="/wiki/Some_Title" ...>  → "Some Title"
        const extractLinks = (html: string): string[] => {
          const out = new Set<string>();
          const re = /href="\/wiki\/([^"#:?]+)"/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(html)) !== null) {
            const raw = decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
            if (!raw || raw.length > 120) continue;
            if (/^(File|Image|Template|Category|Help|Portal|Special|Wikipedia|Talk|User|Draft):/i.test(raw)) continue;
            out.add(raw);
          }
          return [...out];
        };

        const SKIP_SECTIONS = new Set([
          'references', 'see also', 'notes', 'external links',
          'further reading', 'bibliography', 'footnotes',
        ]);

        const articleSlug = slugify(resolvedTitle);
        const articleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, '_'))}`;
        const indexed: string[] = [];
        const linkAccumulator = new Set<string>();
        for (const t of extractLinks(fullHtml)) linkAccumulator.add(t);

        // Split the HTML into hierarchical sections (H2 then H3) and emit
        // a fragment per leaf. Sections longer than CHUNK_THRESHOLD chars
        // are further split via text_chunker so we never silently truncate
        // a long "History" or "Background" section.
        //
        // Section IDs are deterministic: wiki_<article>_<slug>[_cN].
        // Re-fetching the same article produces the same ids, so dedup +
        // TTL + supersede all work correctly.
        const CHUNK_THRESHOLD = 1500;     // chars
        const CHUNK_MAX_TOKENS = 350;     // ~1400 chars
        const CHUNK_OVERLAP = 50;         // ~200 chars
        const MIN_FRAGMENT_LEN = 100;

        const emitSection = async (
          slugPath: string,
          headingPath: string,
          rawText: string,
        ) => {
          if (rawText.length < MIN_FRAGMENT_LEN) return;
          if (rawText.length <= CHUNK_THRESHOLD) {
            await emit({
              id: `wiki_${articleSlug}_${slugPath}`,
              text: rawText,
              source: articleUrl,
              doi: null,
              confidence: 0.9,
              title: `${resolvedTitle} — ${headingPath}`,
            });
            indexed.push(headingPath);
            return;
          }
          for (const chunk of chunkText(rawText, CHUNK_MAX_TOKENS, CHUNK_OVERLAP)) {
            await emit({
              id: `wiki_${articleSlug}_${slugPath}_c${chunk.index}`,
              text: chunk.text,
              source: articleUrl,
              doi: null,
              confidence: 0.9,
              title: `${resolvedTitle} — ${headingPath} (part ${chunk.index + 1})`,
            });
            indexed.push(`${headingPath} (part ${chunk.index + 1})`);
          }
        };

        // ── Lead / intro ────────────────────────────────────────────────────
        const h2Split = fullHtml.split(/<h2[^>]*>/);
        const leadHtml = h2Split[0] ?? '';
        const leadText = clean(leadHtml);
        await emitSection('intro', 'Introduction', leadText);

        // ── Top-level sections (H2), each split further by H3 ───────────────
        const topLevel = sections.filter((s: any) => s.toclevel === 1);
        for (let i = 0; i < h2Split.length - 1; i++) {
          const sectionHtml = h2Split[i + 1];
          const sectionMeta = topLevel[i];
          if (!sectionMeta) continue;
          const sTitle = clean(sectionMeta.line ?? '');
          if (!sTitle || SKIP_SECTIONS.has(sTitle.toLowerCase())) continue;
          const sSlug = slugify(sTitle);

          // Within this H2 section, peel off H3 subsections.
          const h3Split = sectionHtml.split(/<h3[^>]*>/);
          const sectionLead = clean(h3Split[0] ?? '');
          await emitSection(sSlug, sTitle, sectionLead);

          for (let j = 1; j < h3Split.length; j++) {
            const subHtml = h3Split[j];
            // Subheading appears at the start of the chunk before its first
            // closing tag; recover it from the cleaned text up to first period
            // OR fall back to the chunk's first 60 chars.
            const subClean = clean(subHtml);
            const headingGuess = subClean.split(/[.,;]/)[0]?.slice(0, 60).trim() || `subsection-${j}`;
            const subSlug = slugify(headingGuess) || `sub${j}`;
            await emitSection(`${sSlug}_${subSlug}`, `${sTitle} → ${headingGuess}`, subClean);
          }
        }

        // Feed links into the crawl queue (drop the article we just fetched).
        linkAccumulator.delete(resolvedTitle);
        linkAccumulator.delete(title);
        const linksFound = [...linkAccumulator];
        enqueueCrawl(linksFound);

        return {
          ok: true,
          data: {
            article: resolvedTitle,
            indexed_count: indexed.length,
            section_titles: indexed,
            links_discovered: linksFound.length,
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
          decodeHtmlEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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
          const bodyText = decodeHtmlEntities(
            (fullContent || description).replace(/<[^>]+>/g, ''),
          ).replace(/\s+/g, ' ').trim();

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
