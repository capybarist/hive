import { XMLParser } from 'fast-xml-parser';
import { fetchPapers } from './arxiv_client.js';
import { validateDOI } from './crossref_validator.js';
import { chunkText } from './text_chunker.js';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── Tool definitions for Gemini function calling ───────────────────────────
export const TOOL_DECLARATIONS = [
  {
    name: 'arxiv_search',
    description: 'Search arXiv for papers on a topic. Returns titles, abstracts, and DOIs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "vector databases similarity search")' },
        limit: { type: 'number', description: 'Max papers to return (1-10)', default: 5 },
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
    description: 'Fetch a Wikipedia article split into sections. Returns all sections with titles and content — index each section as a separate fragment. PREFERRED over web_fetch for any Wikipedia page.',
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
    description: 'Fetch the text content of a non-Wikipedia URL (HTML pages, abstracts, blog posts). Do NOT use for Wikipedia — use wikipedia_fetch instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'chunk_text',
    description: 'Split a long text into overlapping chunks suitable for indexing.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to split' },
        max_tokens: { type: 'number', description: 'Max tokens per chunk', default: 200 },
      },
      required: ['text'],
    },
  },
  {
    name: 'index_fragment',
    description: 'Index a knowledge fragment into HIVE (stores in Hypercore + HNSW).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique ID for this fragment' },
        text: { type: 'string', description: 'Fragment text content' },
        source: { type: 'string', description: 'Source identifier (arXiv ID, URL, etc.)' },
        doi: { type: 'string', description: 'DOI if available', nullable: true },
        confidence: { type: 'number', description: 'Confidence score 0-1' },
        title: { type: 'string', description: 'Paper or article title' },
      },
      required: ['id', 'text', 'source', 'confidence'],
    },
  },
  {
    name: 'rss_fetch',
    description: 'Fetch and parse an RSS or Atom feed. Returns list of recent articles with title, description, link and date. Use this for news sites, blogs, and any source with an RSS feed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RSS or Atom feed URL' },
        limit: { type: 'number', description: 'Max articles to return (default 15)', default: 15 },
      },
      required: ['url'],
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

// ── Tool executor ────────────────────────────────────────────────────────────
// Tracks titles seen in this session to prevent duplicate indexing of the same
// article from different sources (e.g. RSS feed URL vs direct article URL).
const _seenTitles = new Set<string>();

export function resetSeenTitles() { _seenTitles.clear(); }

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: {
    embedderUrl: string;
    onFragment?: (frag: { id: string; text: string; source: string; doi: string | null; confidence: number; title?: string }) => Promise<void>;
  },
): Promise<ToolResult> {
  switch (name) {
    case 'arxiv_search': {
      try {
        const papers = await fetchPapers(args.query as string, (args.limit as number) ?? 5);
        return { ok: true, data: papers.map(p => ({ arxiv_id: p.arxiv_id, title: p.title, abstract: p.abstract.slice(0, 2000), doi: p.doi, source: p.source })) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    case 'crossref_validate': {
      const valid = await validateDOI(args.doi as string);
      return { ok: true, data: { doi: args.doi, valid } };
    }

    case 'wikipedia_fetch': {
      try {
        const title = (args.title as string).trim();
        const encoded = encodeURIComponent(title.replace(/ /g, '_'));
        const res = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/mobile-sections/${encoded}`,
          {
            headers: { 'User-Agent': 'HIVE/0.1 (research crawler; mailto:capy@capybaralabs.tech)' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) return { ok: false, error: `Wikipedia API: HTTP ${res.status} for "${title}"` };
        const data = await res.json() as any;

        const clean = (html: string) =>
          html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const SKIP_SECTIONS = new Set(['references', 'see also', 'notes', 'external links', 'further reading', 'bibliography', 'footnotes']);

        const sections: { title: string; slug: string; content: string }[] = [];

        // Lead / introduction
        const leadText = clean(data.lead?.sections?.[0]?.text ?? '').slice(0, 1200);
        if (leadText.length > 80) {
          sections.push({ title: 'Introduction', slug: 'intro', content: leadText });
        }

        // Body sections
        for (const s of (data.remaining?.sections ?? [])) {
          const sTitle = clean(s.line ?? '');
          if (!sTitle || SKIP_SECTIONS.has(sTitle.toLowerCase())) continue;
          const content = clean(s.text ?? '').slice(0, 1000);
          if (content.length < 100) continue;
          const slug = sTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          sections.push({ title: sTitle, slug, content });
        }

        return { ok: true, data: { article: title, section_count: sections.length, sections } };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    case 'web_fetch': {
      try {
        const res = await fetch(args.url as string, {
          headers: { 'User-Agent': 'HIVE/0.1 (research crawler; mailto:capy@capybaralabs.tech)' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const html = await res.text();
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        return { ok: true, data: { url: args.url, text } };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    case 'chunk_text': {
      const chunks = chunkText(args.text as string, (args.max_tokens as number) ?? 200);
      return { ok: true, data: chunks };
    }

    case 'rss_fetch': {
      try {
        const res = await fetch(args.url as string, {
          headers: { 'User-Agent': 'HIVE/0.1 (knowledge crawler; mailto:capy@capybaralabs.tech)' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const xml = await res.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsed = parser.parse(xml);
        const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
        const rawItems = channel?.item ?? channel?.entry ?? [];
        const items: any[] = Array.isArray(rawItems) ? rawItems : [rawItems];
        const limit = (args.limit as number) ?? 15;
        const articles = items.slice(0, Math.min(limit, 15)).map((item: any) => {
          // Prefer content:encoded (full article) over description (teaser)
          const fullContent = item['content:encoded'] ?? item.content?.['#text'] ?? item.content ?? '';
          const description = typeof item.description === 'string' ? item.description : item.description?.['#text'] ?? item.summary?.['#text'] ?? item.summary ?? '';
          const bodyText = (fullContent || description).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          return {
            title: (typeof item.title === 'string' ? item.title : item.title?.['#text'] ?? item.title?.['_'] ?? '').trim(),
            content: bodyText.slice(0, 1500),
            link: item.link?.['@_href'] ?? (typeof item.link === 'string' ? item.link : '') ?? item.id ?? '',
            pubDate: item.pubDate ?? item.updated ?? item.published ?? '',
          };
        }).filter(a => a.title);
        return { ok: true, data: { feed_url: args.url, count: articles.length, articles } };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    case 'index_fragment': {
      const title = (args.title as string | undefined)?.trim().toLowerCase() ?? '';
      // Skip if we already indexed the same title this session (different source, same article)
      if (title && _seenTitles.has(title)) {
        return { ok: true, data: { indexed: false, id: args.id, skipped: 'duplicate title' } };
      }
      if (title) _seenTitles.add(title);

      if (options.onFragment) {
        const rawDoi = args.doi as string | null | undefined;
        const doi = (rawDoi && rawDoi !== 'null' && rawDoi !== 'undefined' && rawDoi.startsWith('10.'))
          ? rawDoi : null;
        await options.onFragment({
          id: args.id as string,
          text: args.text as string,
          source: args.source as string,
          doi,
          confidence: args.confidence as number,
          title: args.title as string | undefined,
        });
      }
      return { ok: true, data: { indexed: true, id: args.id } };
    }

    case 'finish':
      return { ok: true, data: args };

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
