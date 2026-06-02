/**
 * CommonCrawlSource — Common Crawl CDX + WARC adapter for ForagerSource.
 *
 * Uses the Common Crawl CDX index API to discover URLs by domain within a
 * given snapshot, then fetches individual WARC records via HTTP range
 * requests to retrieve the full HTML body. HTML is stripped to plain text
 * before chunking into VerbatimFragment units.
 *
 * Interface mapping:
 *   seed({ query })  → CDX query for declared domains (or query-as-domain)
 *                      → returns list of original page URLs cached for fetch
 *   fetch(url)       → CDX lookup to get (filename, offset, length)
 *                      → range-GET the WARC record from data.commoncrawl.org
 *                      → gunzip → parse WARC headers → strip HTML → chunk
 *
 * Scope params (from BeeManifest.declared_sources[].scope):
 *   {
 *     domains:  string[]   — domains to crawl, e.g. ["pubmed.ncbi.nlm.nih.gov"]
 *     snapshot: string     — CC snapshot id, e.g. "CC-MAIN-2025-08"
 *   }
 *
 * Two-reproducibility guarantee: any two BEEs using the same snapshot +
 * same domains reach the same URL set independently, satisfying HIVE's
 * "can two BEEs in different jurisdictions reach the same content?" rule.
 */

import { createGunzip } from 'node:zlib';
import { chunkText } from '../text_chunker.js';
import type { FetchResult, ForagerSource, SeedOptions, VerbatimFragment } from './source.js';

const CDX_API = 'https://index.commoncrawl.org';
const CC_DATA = 'https://data.commoncrawl.org';
const DEFAULT_SNAPSHOT = 'CC-MAIN-2025-08';
const USER_AGENT = 'HIVE/0.7 (research crawler; mailto:capy@capybaralabs.tech)';

const CHUNK_THRESHOLD = 1500;
const CHUNK_MAX_TOKENS = 350;
const CHUNK_OVERLAP = 50;
const MIN_FRAGMENT_LEN = 100;
// CC pages can be very large; cap to avoid embedding runaway chunks
const MAX_TEXT_CHARS = 50_000;

interface CdxEntry {
  filename: string;  // WARC path, e.g. crawl-data/CC-MAIN-2025-08/segments/.../warc/...
  offset: number;
  length: number;
  url: string;       // original crawled URL
  mime: string;
  status: number;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\//i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    return (last || u.hostname).replace(/[-_]/g, ' ').replace(/\.[a-z]+$/i, '');
  } catch {
    return url.slice(0, 60);
  }
}

// Minimal HTML→text: strip tags, decode common entities, collapse whitespace.
// Not a full parser — good enough for news/encyclopaedia/academic pages.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function decompressGzip(data: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (c: Buffer) => chunks.push(c));
    gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    gunzip.on('error', reject);
    gunzip.end(data);
  });
}

// Parse a raw WARC record string: skip WARC headers, skip HTTP response
// headers, return the body (the HTML). Returns '' if the record is not
// a usable HTTP response record.
function parseWarcBody(warc: string): string {
  // Find end of WARC headers (blank line)
  const warcEnd = warc.indexOf('\r\n\r\n');
  if (warcEnd === -1) return '';

  // Check this is a WARC-Type: response (not request/metadata)
  const warcHeaders = warc.slice(0, warcEnd);
  if (!warcHeaders.includes('WARC-Type: response')) return '';

  const afterWarcHeaders = warc.slice(warcEnd + 4);

  // Skip HTTP response headers (ends at blank line)
  const httpEnd = afterWarcHeaders.indexOf('\r\n\r\n');
  if (httpEnd === -1) return afterWarcHeaders; // no HTTP headers? return as-is

  return afterWarcHeaders.slice(httpEnd + 4).replace(/\r\n\r\n$/, '').trim();
}

export class CommonCrawlSource implements ForagerSource {
  readonly id: string;
  readonly displayName = 'Common Crawl';
  readonly licence = 'public-domain';

  private snapshot: string;
  private domains: string[];
  // Per-instance CDX cache: original_url → CdxEntry (populated by seed)
  private cdxCache: Map<string, CdxEntry> = new Map();

  constructor(opts: { snapshot?: string; domains?: string[] } = {}) {
    this.snapshot = (opts.snapshot ?? process.env.HIVE_CC_SNAPSHOT ?? DEFAULT_SNAPSHOT).trim();
    this.domains = opts.domains ?? (process.env.HIVE_CC_DOMAINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.id = `common-crawl-${this.snapshot}`;
  }

  describe() {
    // Canonical family id 'common-crawl' (what manifests/UI use), distinct from
    // the per-instance snapshot-suffixed `this.id`.
    return {
      id: 'common-crawl',
      displayName: this.displayName,
      icon: '🌐',
      kind: 'search' as const,
      sourceType: 'commoncrawl',
      defaultLanguages: ['en'],
      seedLimit: 10,
      scope: {
        field: 'domains',
        label: 'Domains (one per line, optional)',
        placeholder: 'example.com',
        input: 'lines' as const,
        help: 'Leave empty to sample the full Common Crawl index',
        rotates: true,
      },
    };
  }

  normalize(url: string): string {
    try {
      const u = new URL(url);
      u.hash = '';
      // Strip common tracking params
      for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref', 'fbclid', 'gclid']) {
        u.searchParams.delete(p);
      }
      return u.toString().replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  owns(url: string): boolean {
    if (this.domains.length === 0) return false;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      return this.domains.some(d => hostname === d.replace(/^www\./, '') || hostname.endsWith('.' + d.replace(/^www\./, '')));
    } catch {
      return false;
    }
  }

  /**
   * v0.7.6 — partitions for Common Crawl.
   *
   * If scope.domains is set (the usual case for a curated CC bee), every
   * domain becomes its own partition. 5 bees on a 5-domain scope can pick
   * one domain each, and each partition is fully inside scope.
   *
   * Without explicit domains, partitions are TLD groups — a rough split
   * for generalist deployments. This is a fallback; running CC without
   * an explicit domain list is discouraged because the result set is huge.
   */
  partitions(scope?: Record<string, unknown>): string[] {
    const domains = (scope?.domains ?? this.domains) as string[] | undefined;
    if (Array.isArray(domains) && domains.length > 0) {
      return domains.map(d => d.replace(/^www\./, ''));
    }
    // No scope.domains → no partitionable axis. Single bucket.
    return ['*'];
  }

  isInPartition(url: string, _scope: Record<string, unknown> | undefined, partition: string): boolean {
    if (partition === '*') return true;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const p = partition.replace(/^www\./, '');
      return hostname === p || hostname.endsWith('.' + p);
    } catch {
      return false;
    }
  }

  async seed(opts: SeedOptions): Promise<string[]> {
    // If domains declared in scope, query those; else treat opts.query as domain hint
    const targets = this.domains.length > 0 ? this.domains : [opts.query];
    const limit = opts.limit ?? 20;
    const perDomain = Math.max(2, Math.floor(limit / Math.min(targets.length, 5)));

    const urls: string[] = [];
    for (const domain of targets.slice(0, 5)) {
      try {
        const entries = await this.queryCdx(domain, perDomain);
        for (const e of entries) {
          const norm = this.normalize(e.url);
          this.cdxCache.set(norm, e);
          urls.push(norm);
        }
        console.log(`  [cc-seed] ${domain} → ${entries.length} URLs from ${this.snapshot}`);
      } catch (err: any) {
        console.warn(`  [cc-seed] CDX query failed for "${domain}": ${err.message ?? err}`);
      }
    }
    return urls;
  }

  async fetch(url: string): Promise<FetchResult> {
    const norm = this.normalize(url);
    let entry = this.cdxCache.get(norm);

    // Cache miss — re-query CDX for this specific URL
    if (!entry) {
      try {
        const hostname = new URL(norm).hostname.replace(/^www\./, '');
        const entries = await this.queryCdx(hostname, 50);
        for (const e of entries) this.cdxCache.set(this.normalize(e.url), e);
        entry = this.cdxCache.get(norm);
      } catch (err: any) {
        console.warn(`  [cc-fetch] CDX re-query failed for ${norm}: ${err.message ?? err}`);
      }
    }

    if (!entry) {
      return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
    }

    let html = '';
    try {
      html = await this.fetchWarcRecord(entry);
    } catch (err: any) {
      console.warn(`  [cc-fetch] WARC fetch failed for ${norm}: ${err.message ?? err}`);
      return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
    }

    const text = stripHtml(html).slice(0, MAX_TEXT_CHARS);
    if (text.length < MIN_FRAGMENT_LEN) {
      return { fragments: [], outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
    }

    const baseId = `cc_${slugify(norm)}`;
    const title = titleFromUrl(norm);
    const fragments: VerbatimFragment[] = [];

    if (text.length > CHUNK_THRESHOLD) {
      const chunks = chunkText(text, CHUNK_MAX_TOKENS, CHUNK_OVERLAP);
      chunks.forEach((chunk, i) => {
        if (chunk.length >= MIN_FRAGMENT_LEN) {
          fragments.push({ id: `${baseId}_c${i}`, text: chunk, source: norm, title, doi: null, confidence: 0.65 });
        }
      });
    } else {
      fragments.push({ id: baseId, text, source: norm, title, doi: null, confidence: 0.65 });
    }

    // CC pages don't emit outbound links in this implementation —
    // the CDX index is the discovery frontier (seed → more URLs).
    return { fragments, outboundLinks: [], refreshPolicy: { ttlSeconds: 30 * 24 * 3600 } };
  }

  // Query the CDX API for a domain within this snapshot.
  // Returns WARC-backed entries sorted by timestamp (newest first).
  private async queryCdx(domain: string, limit: number): Promise<CdxEntry[]> {
    const cleanDomain = domain.replace(/^www\./, '');
    const params = new URLSearchParams({
      url: `*.${cleanDomain}/*`,
      output: 'json',
      limit: String(Math.min(limit, 100)),
      filter: 'statuscode:200',
      fl: 'url,filename,offset,length,mime,status',
    });

    const resp = await fetch(
      `${CDX_API}/${this.snapshot}-index?${params}`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`CDX ${resp.status}: ${body.slice(0, 200)}`);
    }

    const text = await resp.text();
    const entries: CdxEntry[] = [];

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (!obj.filename || obj.offset === undefined || obj.length === undefined) continue;
        // Only HTML pages — skip CSS, JS, images, etc.
        const mime = String(obj.mime ?? '');
        if (mime && !mime.includes('html') && !mime.includes('text/plain')) continue;
        entries.push({
          filename: obj.filename,
          offset: Number(obj.offset),
          length: Number(obj.length),
          url: obj.url,
          mime,
          status: Number(obj.status ?? 200),
        });
      } catch { /* skip malformed JSON */ }
    }

    return entries;
  }

  // Fetch a single WARC record using an HTTP range request.
  // CC WARC records are independently gzip-compressed within the archive.
  private async fetchWarcRecord(entry: CdxEntry): Promise<string> {
    const end = entry.offset + entry.length - 1;
    const resp = await fetch(
      `${CC_DATA}/${entry.filename}`,
      {
        headers: { 'Range': `bytes=${entry.offset}-${end}`, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      },
    );

    // 206 Partial Content on range request; 200 if server doesn't support ranges
    if (resp.status !== 206 && !resp.ok) {
      throw new Error(`WARC GET ${resp.status}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const warcText = await decompressGzip(buffer).catch(() => buffer.toString('utf-8'));
    return parseWarcBody(warcText);
  }
}

// Default singleton — reads snapshot/domains from env vars if set.
// Extractor creates scoped instances at runtime from manifest declared_sources.
export const commonCrawlSource = new CommonCrawlSource();
