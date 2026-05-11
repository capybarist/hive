import { XMLParser } from 'fast-xml-parser';

export interface Paper {
  arxiv_id: string;
  title: string;
  abstract: string;
  doi: string | null;
  authors: string[];
  published: string;
  source: string;
}

const ARXIV_API = 'https://export.arxiv.org/api/query';

const DEFAULT_CATEGORIES = ['cs.*', 'physics.*', 'math.*', 'q-bio.*', 'q-fin.*', 'stat.*', 'econ.*'];

export async function fetchPapers(
  topic: string,
  limit: number = 10,
  categories: string[] = DEFAULT_CATEGORIES,
): Promise<Paper[]> {
  // Jitter to spread load across multiple BEEs
  await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));

  const catFilter = categories.map((c) => `cat:${c}`).join('+OR+');
  const topicQuery = topic.includes(' ') ? `all:"${topic}"` : `all:${topic}`;
  const url =
    `${ARXIV_API}?search_query=(${encodeURIComponent(topicQuery)})+AND+(${catFilter})` +
    `&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;

  let res: Response | null = null;
  // Max 2 attempts with short delays — extraction budgets are tight (2-8 min).
  // 4 attempts × (10+20+30+40)s delays could exhaust the full budget before any indexing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) break;
    } catch (e: any) {
      console.warn(`arXiv fetch failed: ${e.message}, attempt ${attempt}/2`);
    }
    if (attempt < 2 && (!res || res.status === 429 || res.status === 503)) {
      const wait = 5_000;
      console.warn(`arXiv rate limit (${res?.status ?? 'timeout'}), retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    } else if (res && !res.ok && res.status !== 429 && res.status !== 503) {
      throw new Error(`arXiv API error: ${res.status}`);
    }
  }
  if (!res || !res.ok) throw new Error(`arXiv unavailable (${res?.status ?? 'timeout'}) — skipping this topic`);

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);

  const entries = parsed.feed?.entry;
  if (!entries) return [];

  const items: any[] = Array.isArray(entries) ? entries : [entries];

  return items.map((entry: any) => {
    const rawId: string = entry.id ?? '';
    const arxiv_id = rawId.split('/abs/').pop() ?? rawId;

    let doi: string | null = entry['arxiv:doi'] ?? null;
    if (!doi) {
      const links: any[] = Array.isArray(entry.link) ? entry.link : [entry.link].filter(Boolean);
      const doiLink = links.find((l: any) => l?.['@_title'] === 'doi');
      if (doiLink) doi = doiLink['@_href']?.replace('http://dx.doi.org/', '') ?? null;
    }

    const authors: string[] = Array.isArray(entry.author)
      ? entry.author.map((a: any) => a.name ?? '')
      : [entry.author?.name ?? ''];

    return {
      arxiv_id,
      title: (entry.title ?? '').replace(/\s+/g, ' ').trim(),
      abstract: (entry.summary ?? '').replace(/\s+/g, ' ').trim(),
      doi,
      authors,
      published: entry.published ?? '',
      source: `arXiv:${arxiv_id}`,
    };
  });
}
