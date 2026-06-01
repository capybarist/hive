// HIVE v0.8 — autonomous extractor (bee-side).
//
// For each verbatim source unit the agent receives, this loop:
//   1. Runs the deterministic v0.8 chunker over the text (one Section).
//   2. Embeds each chunk with the network-standard e5-base ONNX model.
//   3. Builds + signs the v0.8 fragment via @hive/core (vector inline).
//   4. Appends to the local Hyperbee.
// The queen reads those fragments via Hyperswarm/Hypercore replication and
// upserts the (already vectorized) payload into its LanceDB. There is no
// HTTP embedder anymore.
import {
  KnowledgeStore, loadOrCreateIdentity,
  buildSignedFragmentV08, DEFAULT_TTL,
  type FragmentV08, type FragmentV08Input, type NodeIdentity,
  type BeeManifest, type DeclaredSource,
} from '@hive/core';
import { chunkDocument, embedPassage, encodeVector, warmup as warmupEmbedder } from '@hive/embeddings-node';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, type BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { CrawlQueue } from './crawl_queue.js';
import { wikipediaSource } from './forager/wikipedia_source.js';
import { arxivSource } from './forager/arxiv_source.js';
import { pubmedSource } from './forager/pubmed_source.js';
import { rssSource } from './forager/rss_source.js';
import { CommonCrawlSource } from './forager/common_crawl_source.js';
import type { VerbatimFragment } from './forager/source.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');

export type { BudgetConfig } from './budget_controller.js';

export interface ExtractionResult {
  fragmentsIndexed: number;
  /** Items that an adapter emitted but the bee already had a fresh-TTL copy of. */
  skippedFresh: number;
  /** Per-VerbatimFragment build/save errors during this cycle. */
  errors: number;
  /** Cumulative total of locally-signed fragments after the cycle (for dashboards). */
  totalLocal: number;
  summary: string;
  budget: ReturnType<BudgetController['summary']>;
}

// ── Per-source metadata helpers ─────────────────────────────────────────────
// VerbatimFragment is intentionally source-agnostic; the v0.8 schema needs
// source_type + lang + identifiers, so we derive them from the adapter id +
// the per-fragment hints (arxiv_id, doi). One place that knows the mapping.

function sourceTypeFor(adapterId: string): string {
  if (adapterId.startsWith('wikipedia')) return 'wikipedia';
  if (adapterId === 'arxiv') return 'arxiv';
  if (adapterId === 'pubmed') return 'pubmed';
  if (adapterId === 'rss') return 'rss';
  if (adapterId.startsWith('common-crawl')) return 'commoncrawl';
  return 'custom';
}

function langFor(adapterId: string): string {
  const m = adapterId.match(/-([a-z]{2})$/);
  if (m) return m[1]!;
  if (adapterId === 'arxiv') return 'en';
  return 'en';
}

function ttlSecondsFor(sourceType: string): number {
  return DEFAULT_TTL[sourceType] ?? 3 * 24 * 3600;
}

function identifiersFor(vf: VerbatimFragment): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (vf.doi) out.doi = vf.doi;
  if (vf.arxiv_id) out.arxiv = vf.arxiv_id;
  return Object.keys(out).length ? out : undefined;
}

// ── Verbatim → v0.8 fragments (chunk → embed → sign → save) ──────────────────
// The single place where v0.8 fragments are produced. Returns the count of
// chunks indexed (each chunk = one signed FragmentV08 in the Hypercore).
async function buildAndSaveV08(
  vf: VerbatimFragment,
  adapterId: string,
  store: KnowledgeStore,
  identity: NodeIdentity,
  partition: string | undefined,
  onIndexed?: (frag: { id: string; title?: string; source: string }) => void,
): Promise<number> {
  const sourceType = sourceTypeFor(adapterId);
  const lang = langFor(adapterId);
  const ttlSec = ttlSecondsFor(sourceType);
  const retrievedAt = new Date().toISOString();

  // The v0.8 chunker treats vf.text as one section. For short sections it
  // emits a single chunk; for long ones, multiple — same content_hash on
  // matching input across all bees that run the same CHUNKER_VERSION.
  const sections = [{ heading_path: vf.title ? [vf.title] : [], text: vf.text }];
  const chunks = chunkDocument(sections);
  if (chunks.length === 0) return 0;

  let saved = 0;
  for (const ch of chunks) {
    const chunkId = chunks.length > 1 ? `${vf.id}_c${ch.chunk_index}` : vf.id;
    const vec = await embedPassage(ch.text);
    const vecB64 = encodeVector(vec);
    const input: FragmentV08Input = {
      id: chunkId,
      node_id: identity.nodeId,
      node_pubkey: identity.publicKeyHex,
      text: ch.text,
      lang,
      title: vf.title,
      source: adapterId,
      source_type: sourceType,
      url: vf.source,                       // VerbatimFragment.source carries the URL
      identifiers: identifiersFor(vf),
      retrieved_at: retrievedAt,
      section_path: ch.section_path,
      chunk_index: ch.chunk_index,
      chunk_count: ch.chunk_count,
      extracted_at: new Date().toISOString(),
      ttl_seconds: ttlSec,
      partition,
      confidence: vf.confidence,
    };
    const signed = buildSignedFragmentV08(input, vecB64, identity);
    await store.save(signed);
    saved++;
    onIndexed?.({ id: signed.id, title: signed.title, source: signed.source });
  }
  return saved;
}

// Cross-cycle freshness check: does an unchanged-content fresh fragment for
// this verbatim unit already live in our Hypercore? If so, skip the (costly)
// embed pass entirely. Checks vf.id and the first-chunk id since the agent
// may have chunked the section last time.
async function isFresh(
  store: KnowledgeStore,
  vf: VerbatimFragment,
  ttlSec: number,
): Promise<boolean> {
  const candidates = [vf.id, `${vf.id}_c0`];
  for (const id of candidates) {
    const existing = await store.get(id).catch(() => null);
    if (existing) {
      const ageMs = Date.now() - new Date(existing.extracted_at).getTime();
      if (ageMs < ttlSec * 1000) return true;
    }
  }
  return false;
}

export async function runAutonomousExtraction(
  objective: string,
  budgetConfig: Partial<BudgetConfig> = {},
  existingStore?: KnowledgeStore,
  onIndexed?: (frag: { id: string; title?: string; source: string }) => void,
  // Kept in the signature for backwards-compat with api_server.ts callers;
  // v0.8 has no LLM in the extractor loop, so we always report ok.
  onLLMHealth?: (ok: boolean) => void,
): Promise<ExtractionResult> {
  onLLMHealth?.(true);

  const budget = new BudgetController({ ...DEFAULT_BUDGET, ...budgetConfig });

  let store: KnowledgeStore;
  let ownStore = false;
  let identity: NodeIdentity;
  if (existingStore) {
    store = existingStore;
    // No public identity getter on the store — reconstitute from the same
    // identity dir the api_server used. The api_server has already loaded it
    // so this is a cached read.
    identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
  } else {
    identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
    store = new KnowledgeStore(DATA_DIR, identity);
    await store.ready();
    ownStore = true;
  }

  // Warm the e5 ONNX model once per cycle. After the first cycle the pipeline
  // stays loaded so subsequent calls are no-ops.
  await warmupEmbedder();

  let fragmentsIndexed = 0;
  let skippedFresh = 0;
  let errors = 0;
  let finalSummary = '';

  // ── Manifest-driven source selection (v0.7.5+) ───────────────────────────
  let manifest: BeeManifest | null = null;
  try { manifest = await store.getLocalManifest(); } catch { /* first boot */ }

  const declaredSources: DeclaredSource[] = manifest?.declared_sources?.length
    ? manifest.declared_sources
    : [{ id: 'wikipedia-en', policy: 'drift-ok' }];

  const wikiDecl  = declaredSources.find(s => s.id === 'wikipedia-en');
  const arxivDecl = declaredSources.find(s => s.id === 'arxiv');
  const pubmedDecl = declaredSources.find(s => s.id === 'pubmed');
  const rssDecl   = declaredSources.find(s => s.id === 'rss');
  const ccDecl    = declaredSources.find(s => s.id === 'common-crawl' || s.id.startsWith('common-crawl-'));

  console.log(`[manifest] Active sources: ${declaredSources.map(s => s.id).join(', ')} (from ${manifest ? 'published manifest' : 'defaults'})`);

  const ccSource = ccDecl ? new CommonCrawlSource({
    snapshot: (ccDecl.scope?.snapshot as string | undefined) ?? undefined,
    domains:  Array.isArray(ccDecl.scope?.domains) ? ccDecl.scope!.domains as string[] : [],
  }) : null;

  const crawlQueue = new CrawlQueue({ dataDir: DATA_DIR });
  await crawlQueue.load();
  const BATCH_PER_CYCLE = 5;
  const batchTitles = wikiDecl ? crawlQueue.dequeueBatch(BATCH_PER_CYCLE) : [];

  const onVerbatim = async (vf: VerbatimFragment, adapterId: string, partition?: string) => {
    const sourceType = sourceTypeFor(adapterId);
    if (await isFresh(store, vf, ttlSecondsFor(sourceType))) {
      console.log(`  [skip-fresh] ${vf.id}`);
      skippedFresh++;
      return;
    }
    try {
      const n = await buildAndSaveV08(vf, adapterId, store, identity, partition, onIndexed);
      budget.recordFragments(n);
      fragmentsIndexed += n;
      if (n > 0) console.log(`  [+] Indexed: ${vf.id} → ${n} chunk${n === 1 ? '' : 's'}`);
    } catch (e: any) {
      console.warn(`[v0.8] Build/save failed for ${vf.id}: ${e?.message ?? e}`);
      errors++;
    }
  };

  console.log(`\n🤖 Autonomous extractor starting (v0.8 — chunk → embed → sign → append)`);
  console.log(`   Budget: ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min`);

  // ── Wikipedia (BFS crawler) ──────────────────────────────────────────────
  if (wikiDecl) {
    const partLabel = wikiDecl.partition ?? null;
    const partAsTopic = partLabel ? partLabel.replace(/^Category:/i, '') : null;
    const scopeCat = typeof wikiDecl.scope?.category_tree === 'string'
      ? (wikiDecl.scope.category_tree as string).replace(/^Category:/i, '')
      : null;
    const quoted = objective.match(/"([^"]+)"/);
    const seedQuery = partAsTopic ?? scopeCat ?? (quoted ? quoted[1] : objective.slice(0, 60));
    if (partLabel) console.log(`   [wiki] Partition claimed: ${partLabel}`);

    if (batchTitles.length === 0) {
      console.log(`   [wiki] Queue empty — seeding via wikipediaSource.seed("${seedQuery}")`);
      let seedTitles: string[] = [];
      try {
        const seedUrls = await wikipediaSource.seed({ query: seedQuery, limit: 10 });
        seedTitles = seedUrls.map((u) => wikipediaSource.titleFromUrl(u)).filter((t): t is string => t !== null);
        const added = crawlQueue.enqueueMany(seedTitles);
        console.log(`   [wiki] Seeded queue with ${added}/${seedTitles.length} new titles`);
      } catch (e: any) {
        console.warn(`   [wiki] Seed search failed: ${e.message ?? e}`);
      }
      batchTitles.push(...crawlQueue.dequeueBatch(BATCH_PER_CYCLE));
      if (batchTitles.length === 0 && seedTitles.length > 0) {
        const bootstrap = seedTitles[0]!;
        console.log(`   [wiki] All seed titles visited — bootstrap re-fetch of "${bootstrap}"`);
        batchTitles.push(bootstrap);
      }
    }

    console.log(`   [wiki] Crawl batch: ${batchTitles.length} titles | queue: ${crawlQueue.size()} | visited: ${crawlQueue.visitedSize()}`);

    for (const title of batchTitles) {
      const check = budget.exhausted();
      if (check.yes) {
        console.log(`[budget] Exhausted: ${check.reason}`);
        finalSummary = `Budget exhausted (${check.reason}). Indexed ${fragmentsIndexed} fragments.`;
        break;
      }
      try {
        const url = wikipediaSource.urlFromTitle(title);
        const result = await wikipediaSource.fetch(url);
        for (const vf of result.fragments) await onVerbatim(vf, wikipediaSource.id, wikiDecl.partition);
        let outboundUrls = result.outboundLinks;
        if (wikiDecl.policy === 'exclusive' && wikiDecl.partition) {
          const before = outboundUrls.length;
          outboundUrls = outboundUrls.filter(u =>
            wikipediaSource.isInPartition!(u, wikiDecl.scope, wikiDecl.partition!));
          if (before - outboundUrls.length > 0) {
            console.log(`  [wiki] dropped ${before - outboundUrls.length}/${before} out-of-partition links`);
          }
        }
        const outboundTitles = outboundUrls
          .map((u) => wikipediaSource.titleFromUrl(u))
          .filter((t): t is string => t !== null);
        const added = crawlQueue.enqueueMany(outboundTitles);
        if (added > 0) console.log(`  [queue] +${added} new titles (size now ${crawlQueue.size()})`);
        crawlQueue.markVisited(title);
        console.log(`  [wiki] "${title}" → ${result.fragments.length} sections, ${outboundTitles.length} links`);
      } catch (e: any) {
        console.warn(`  [wiki] failed for "${title}": ${e.message ?? e}`);
      }
    }
  }

  // ── arXiv ────────────────────────────────────────────────────────────────
  const manifestDrivenArxiv = !!arxivDecl;
  const heuristicArxiv = !manifest && /science|physics|biology|chemistry|astrophysic|mathematic|machine\s*learning|deep\s*learning|artificial\s*intelligence|neural|quantum|cs\.|cosmology/i.test(objective);
  if ((manifestDrivenArxiv || heuristicArxiv) && !budget.exhausted().yes) {
    // arXiv categories belong in the *filter* path (see arxiv_source.seed),
    // not in the query — joining them into a string ("cs.LG cs.AI") returns
    // zero papers because no abstract contains that phrase. Always use the
    // objective (or partition / quoted topic) as the topic query and pass the
    // scope through so the adapter can build a category filter from it.
    const arxivQuery = arxivDecl?.partition
      ? arxivDecl.partition
      : (objective.match(/"([^"]+)"/)?.[1] ?? objective.slice(0, 80)).trim();
    if (arxivDecl?.partition) console.log(`  [arxiv] Partition claimed: ${arxivDecl.partition}`);
    console.log(`\n  [arxiv] seed+fetch("${arxivQuery}") scope=${JSON.stringify(arxivDecl?.scope ?? {})}`);
    try {
      const urls = await arxivSource.seed({ query: arxivQuery, limit: 5, scope: arxivDecl?.scope });
      let indexed = 0;
      for (const u of urls) {
        if (budget.exhausted().yes) break;
        try {
          const result = await arxivSource.fetch(u);
          for (const vf of result.fragments) await onVerbatim(vf, arxivSource.id, arxivDecl?.partition);
          indexed += result.fragments.length;
        } catch (perPaper: any) {
          console.warn(`  [arxiv] per-paper failed ${u}: ${perPaper.message ?? perPaper}`);
        }
      }
      console.log(`  [arxiv] indexed ${indexed} papers`);
    } catch (e: any) {
      console.warn(`  [arxiv] search failed: ${e.message ?? e}`);
    }
  }

  // ── PubMed ───────────────────────────────────────────────────────────────
  if (pubmedDecl && !budget.exhausted().yes) {
    // Like arXiv, PubMed is a search corpus: derive a search term from the
    // claimed partition, the declared scope query, or the objective. The term
    // is passed through verbatim so operators can use PubMed field tags
    // (e.g. `asthma[mesh] AND 2024[pdat]`).
    const pubmedQuery = pubmedDecl.partition
      ?? (typeof pubmedDecl.scope?.query === 'string' ? pubmedDecl.scope.query as string : undefined)
      ?? (objective.match(/"([^"]+)"/)?.[1] ?? objective.slice(0, 80)).trim();
    if (pubmedDecl.partition) console.log(`  [pubmed] Partition claimed: ${pubmedDecl.partition}`);
    console.log(`\n  [pubmed] seed+fetch("${pubmedQuery}") scope=${JSON.stringify(pubmedDecl.scope ?? {})}`);
    try {
      const urls = await pubmedSource.seed({ query: pubmedQuery, limit: 5, scope: pubmedDecl.scope });
      let indexed = 0;
      for (const u of urls) {
        if (budget.exhausted().yes) break;
        try {
          const result = await pubmedSource.fetch(u);
          for (const vf of result.fragments) await onVerbatim(vf, pubmedSource.id, pubmedDecl.partition);
          indexed += result.fragments.length;
        } catch (perPaper: any) {
          console.warn(`  [pubmed] per-paper failed ${u}: ${perPaper.message ?? perPaper}`);
        }
      }
      console.log(`  [pubmed] indexed ${indexed} abstracts`);
    } catch (e: any) {
      console.warn(`  [pubmed] search failed: ${e.message ?? e}`);
    }
  }

  // ── RSS ──────────────────────────────────────────────────────────────────
  const manifestDrivenRss = !!rssDecl;
  const heuristicRss = !manifest && /current[\s_-]?events|news|today|breaking|headline|politics|election/i.test(objective);
  if ((manifestDrivenRss || heuristicRss) && !budget.exhausted().yes) {
    const declaredFeeds = Array.isArray(rssDecl?.scope?.feeds) ? rssDecl!.scope!.feeds as string[] : [];
    const envFeeds = (process.env.HIVE_AUX_RSS_FEEDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const defaultFeeds = ['https://feeds.bbci.co.uk/news/world/rss.xml'];
    const feeds = declaredFeeds.length > 0 ? declaredFeeds : (envFeeds.length > 0 ? envFeeds : defaultFeeds);
    const feed = feeds[Math.floor(Math.random() * feeds.length)]!;
    console.log(`\n  [rss] fetch("${feed}")`);
    try {
      const result = await rssSource.fetch(feed);
      for (const vf of result.fragments) await onVerbatim(vf, rssSource.id, rssDecl?.partition);
      console.log(`  [rss] indexed ${result.fragments.length} items`);
    } catch (e: any) {
      console.warn(`  [rss] failed: ${e.message ?? e}`);
    }
  }

  // ── Common Crawl ─────────────────────────────────────────────────────────
  if (ccSource && !budget.exhausted().yes) {
    const domains = (ccDecl?.scope?.domains as string[] | undefined) ?? [];
    const snapshot = (ccDecl?.scope?.snapshot as string | undefined) ?? 'env/default';
    console.log(`\n  [cc] snapshot=${snapshot} domains=${domains.join(',') || '(env)'}`);
    try {
      const seedQuery = domains[0] ?? objective.slice(0, 60);
      const urls = await ccSource.seed({ query: seedQuery, limit: 10 });
      let indexed = 0;
      for (const u of urls) {
        if (budget.exhausted().yes) break;
        try {
          const result = await ccSource.fetch(u);
          for (const vf of result.fragments) await onVerbatim(vf, ccSource.id, ccDecl?.partition);
          indexed += result.fragments.length;
        } catch (perPage: any) {
          console.warn(`  [cc] per-page failed ${u}: ${perPage.message ?? perPage}`);
        }
      }
      console.log(`  [cc] indexed ${indexed} fragments`);
    } catch (e: any) {
      console.warn(`  [cc] failed: ${e.message ?? e}`);
    }
  }

  // Read the Hypercore-resident total so the runLoop log carries "I signed X
  // overall" alongside the per-cycle delta — the contextualising signal a bee
  // operator wants when most cycles legitimately produce 0 (RSS sources hit
  // their TTL fast).
  const totalLocal = store.localFragmentCount;

  if (!finalSummary) {
    const parts: string[] = [`Indexed ${fragmentsIndexed} new`];
    if (skippedFresh > 0) parts.push(`${skippedFresh} already fresh`);
    if (errors > 0) parts.push(`${errors} errors`);
    parts.push(`${totalLocal} total signed`);
    finalSummary = `Crawl cycle complete: ${parts.join(' · ')}. Queue: ${crawlQueue.size()}, visited: ${crawlQueue.visitedSize()}.`;
  }
  console.log(`\n[done] ${finalSummary}`);

  await crawlQueue.flush();
  if (ownStore) await store.close();
  return { fragmentsIndexed, skippedFresh, errors, totalLocal, summary: finalSummary, budget: budget.summary() };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const objective = process.env.HIVE_OBJECTIVE ?? 'Find recent papers about retrieval augmented generation and knowledge graphs';
  const maxFragments = Number(process.env.HIVE_MAX_FRAGMENTS ?? 30);
  const maxMinutes = Number(process.env.HIVE_MAX_MINUTES ?? 10);

  runAutonomousExtraction(objective, { maxFragments, maxMinutes })
    .then(result => {
      console.log('\n════════════════════════════════════');
      console.log('Autonomous extraction complete');
      console.log(`Fragments indexed : ${result.fragmentsIndexed}`);
      console.log(`Summary           : ${result.summary}`);
      console.log('Budget used       :', result.budget);
    })
    .catch(err => { console.error(err); process.exit(1); });
}
