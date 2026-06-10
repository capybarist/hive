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
import { CommonCrawlSource } from './forager/common_crawl_source.js';
import { getForager, describeForager } from './forager/registry.js';
import { isCatalogSource } from './forager/source.js';
import type { VerbatimFragment, ForagerDescriptor } from './forager/source.js';
import type { FragmentSink } from './fragment_sink.js';
import { CatalogInventory, runCatalogSweep } from './catalog_sweep.js';
import { promises as fs } from 'node:fs';

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

// Resolve an adapter id to its registry descriptor. CommonCrawl instances carry
// a snapshot-suffixed id (common-crawl-CC-MAIN-…) → fall back to the family id.
function descFor(adapterId: string): ForagerDescriptor | undefined {
  return describeForager(adapterId)
    ?? (adapterId.startsWith('common-crawl') ? describeForager('common-crawl') : undefined);
}

function sourceTypeFor(adapterId: string): string {
  return descFor(adapterId)?.sourceType ?? 'custom';
}

function langFor(adapterId: string): string {
  const m = adapterId.match(/-([a-z]{2})$/); // e.g. wikipedia-en, wikipedia-es
  if (m) return m[1]!;
  return descFor(adapterId)?.defaultLanguages?.[0] ?? 'en';
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
  store: FragmentSink,
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
    // v1.2 — adapters may supply anchor-contextualized embedding input
    // (vf.embedText) while the stored text stays verbatim. Only safe while
    // the unit is a single chunk; split units embed their own chunk text.
    const vec = await embedPassage(chunks.length === 1 ? (vf.embedText ?? ch.text) : ch.text);
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
      meta: vf.meta,
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
  store: FragmentSink,
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
  // Where signed fragments are published: a KnowledgeStore (p2p Hyperbee
  // append, the default) or a DirectTransport (HTTP delivery to a queen) —
  // both satisfy FragmentSink. When omitted, a local KnowledgeStore is opened.
  existingStore?: FragmentSink,
  onIndexed?: (frag: { id: string; title?: string; source: string }) => void,
  // Kept in the signature for backwards-compat with api_server.ts callers;
  // v0.8 has no LLM in the extractor loop, so we always report ok.
  onLLMHealth?: (ok: boolean) => void,
): Promise<ExtractionResult> {
  onLLMHealth?.(true);

  const budget = new BudgetController({ ...DEFAULT_BUDGET, ...budgetConfig });

  let store: FragmentSink;
  let ownStore: KnowledgeStore | null = null;
  let identity: NodeIdentity;
  if (existingStore) {
    store = existingStore;
    // No public identity getter on the store — reconstitute from the same
    // identity dir the api_server used. The api_server has already loaded it
    // so this is a cached read.
    identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
  } else {
    identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
    ownStore = new KnowledgeStore(DATA_DIR, identity);
    await ownStore.ready();
    store = ownStore;
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

  console.log(`[manifest] Active sources: ${declaredSources.map(s => s.id).join(', ')} (from ${manifest ? 'published manifest' : 'defaults'})`);

  // The persistent BFS frontier — only `crawl`-kind sources (Wikipedia) use it.
  const crawlQueue = new CrawlQueue({ dataDir: DATA_DIR });
  await crawlQueue.load();

  // Source-agnostic "recently fetched" feed. `crawl` sources expose progress via
  // the queue/visited counts; `search` sources have no frontier, so the dashboard
  // reads this capped JSONL tail instead. One entry per fetched document/cycle.
  const activityFile = resolve(DATA_DIR, 'forager_recent.jsonl');
  const activityBuf: { ts: string; source: string; title: string; url: string }[] = [];
  const seenDocs = new Set<string>();
  const recordActivity = (adapterId: string, vf: VerbatimFragment) => {
    if (seenDocs.has(vf.source)) return;
    seenDocs.add(vf.source);
    activityBuf.push({ ts: new Date().toISOString(), source: sourceTypeFor(adapterId), title: vf.title ?? vf.id, url: vf.source });
  };
  const flushActivity = async () => {
    if (!activityBuf.length) return;
    let prev: string[] = [];
    try { prev = (await fs.readFile(activityFile, 'utf8')).split('\n').filter(Boolean); } catch { /* none yet */ }
    const lines = [...prev, ...activityBuf.map((e) => JSON.stringify(e))].slice(-200);
    try { await fs.writeFile(activityFile, lines.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
  };

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
      if (n > 0) {
        console.log(`  [+] Indexed: ${vf.id} → ${n} chunk${n === 1 ? '' : 's'}`);
        recordActivity(adapterId, vf);
      }
    } catch (e: any) {
      console.warn(`[v0.8] Build/save failed for ${vf.id}: ${e?.message ?? e}`);
      errors++;
    }
  };

  console.log(`\n🤖 Autonomous extractor starting (v0.8 — chunk → embed → sign → append)`);
  console.log(`   Budget: ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min`);

  // ── Uniform source loop (v0.9 — ForagerRegistry) ─────────────────────────
  // Each declared source dispatches by its descriptor `kind`: `crawl` walks the
  // persistent BFS frontier (Wikipedia); `search` runs seed(query)→fetch with a
  // descriptor-driven rotation (pubmed terms / rss feeds / cc domains). A new
  // source only registers a descriptor — no new branch is needed here.

  // Wikipedia BFS frontier crawl.
  const runFrontierCrawl = async (decl: DeclaredSource): Promise<void> => {
    // Only the title-based Wikipedia frontier is wired today; other `crawl`
    // sources (generic web) are dispatch-only with no seedable frontier.
    if (decl.id !== 'wikipedia-en') return;
    const partLabel = decl.partition ?? null;
    const partAsTopic = partLabel ? partLabel.replace(/^Category:/i, '') : null;
    const scopeCat = typeof decl.scope?.category_tree === 'string'
      ? (decl.scope.category_tree as string).replace(/^Category:/i, '')
      : null;
    const quoted = objective.match(/"([^"]+)"/);
    const seedQuery = partAsTopic ?? scopeCat ?? (quoted ? quoted[1] : objective.slice(0, 60));
    if (partLabel) console.log(`   [wiki] Partition claimed: ${partLabel}`);

    const BATCH_PER_CYCLE = 5;
    const batchTitles = crawlQueue.dequeueBatch(BATCH_PER_CYCLE);
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
        for (const vf of result.fragments) await onVerbatim(vf, wikipediaSource.id, decl.partition);
        let outboundUrls = result.outboundLinks;
        if (decl.policy === 'exclusive' && decl.partition) {
          const before = outboundUrls.length;
          outboundUrls = outboundUrls.filter(u =>
            wikipediaSource.isInPartition!(u, decl.scope, decl.partition!));
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
  };

  // seed(query)→fetch for `search` sources (arXiv, PubMed, Common Crawl, RSS).
  const runSearchSource = async (decl: DeclaredSource, desc: ForagerDescriptor): Promise<void> => {
    // Common Crawl needs a scope-bound instance (snapshot/domains); the rest use
    // the registered singleton.
    const forager = desc.sourceType === 'commoncrawl'
      ? new CommonCrawlSource({
          snapshot: (decl.scope?.snapshot as string | undefined) ?? undefined,
          domains: Array.isArray(decl.scope?.domains) ? decl.scope!.domains as string[] : [],
        })
      : getForager(decl.id);
    if (!forager) { console.warn(`  [${decl.id}] no forager registered — skipping`); return; }

    // This cycle's seed query: rotate one entry of the declared array field if the
    // descriptor marks it as a rotated query list (pubmed terms / rss feeds / cc
    // domains); else fall back to partition / scope.query / objective. arXiv's
    // `categories` are a filter (rotates=false), so they stay in scope, not query.
    const field = desc.scope?.field;
    let candidates: string[] = (desc.scope?.rotates && field && Array.isArray(decl.scope?.[field]))
      ? (decl.scope![field] as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    // RSS without declared feeds keeps the env/default-feed behaviour.
    if (desc.sourceType === 'rss' && candidates.length === 0) {
      const envFeeds = (process.env.HIVE_AUX_RSS_FEEDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      candidates = envFeeds.length ? envFeeds : ['https://feeds.bbci.co.uk/news/world/rss.xml'];
    }
    const query = candidates.length
      ? candidates[Math.floor(Math.random() * candidates.length)]!
      : (decl.partition
          ?? (typeof decl.scope?.query === 'string' ? decl.scope.query as string : undefined)
          ?? (objective.match(/"([^"]+)"/)?.[1] ?? objective.slice(0, 80)).trim());

    if (decl.partition) console.log(`  [${desc.id}] Partition claimed: ${decl.partition}`);
    console.log(`\n  [${desc.id}] seed+fetch("${query}") scope=${JSON.stringify(decl.scope ?? {})}`);
    try {
      const urls = await forager.seed({ query, limit: desc.seedLimit ?? 5, scope: decl.scope });
      let indexed = 0;
      for (const u of urls) {
        if (budget.exhausted().yes) break;
        try {
          const result = await forager.fetch(u);
          for (const vf of result.fragments) await onVerbatim(vf, forager.id, decl.partition);
          indexed += result.fragments.length;
        } catch (perItem: any) {
          console.warn(`  [${desc.id}] item failed ${u}: ${perItem.message ?? perItem}`);
        }
      }
      console.log(`  [${desc.id}] fetched ${indexed} fragments`);
    } catch (e: any) {
      console.warn(`  [${desc.id}] search failed: ${e.message ?? e}`);
    }
  };

  // CatalogSource sweep (v1.x — direct mode §4). The catalog's content_hash
  // inventory is the change detector here, so the TTL freshness skip does NOT
  // apply: a changed document must re-embed even if its TTL hasn't lapsed.
  const runCatalog = async (decl: DeclaredSource): Promise<void> => {
    const forager = getForager(decl.id);
    if (!forager || !isCatalogSource(forager)) {
      console.warn(`  [${decl.id}] declared as catalog but the registered forager doesn't implement CatalogSource — skipping`);
      return;
    }
    const inventory = new CatalogInventory(DATA_DIR, decl.id);
    await inventory.load();
    const summary = await runCatalogSweep(
      forager,
      inventory,
      async (vf) => {
        try {
          const n = await buildAndSaveV08(vf, forager.id, store, identity, decl.partition, onIndexed);
          budget.recordFragments(n);
          fragmentsIndexed += n;
          if (n > 0) recordActivity(forager.id, vf);
        } catch (e: any) {
          console.warn(`[v0.8] Build/save failed for ${vf.id}: ${e?.message ?? e}`);
          errors++;
        }
      },
      { budgetExhausted: () => budget.exhausted().yes },
    );
    skippedFresh += summary.unchanged;
    errors += summary.errors;
  };

  // Legacy: a bee with NO published manifest could infer arxiv/rss from the
  // objective keywords. Preserve that by augmenting the declared list.
  const effectiveSources: DeclaredSource[] = [...declaredSources];
  if (!manifest) {
    if (/science|physics|biology|chemistry|astrophysic|mathematic|machine\s*learning|deep\s*learning|artificial\s*intelligence|neural|quantum|cs\.|cosmology/i.test(objective)
        && !effectiveSources.some(s => s.id === 'arxiv')) {
      effectiveSources.push({ id: 'arxiv', policy: 'drift-ok' });
    }
    if (/current[\s_-]?events|news|today|breaking|headline|politics|election/i.test(objective)
        && !effectiveSources.some(s => s.id === 'rss')) {
      effectiveSources.push({ id: 'rss', policy: 'drift-ok' });
    }
  }

  for (const decl of effectiveSources) {
    if (budget.exhausted().yes) break;
    const desc = descFor(decl.id);
    if (!desc) { console.warn(`[manifest] Unknown source '${decl.id}' — no forager registered; skipping`); continue; }
    if (desc.kind === 'crawl') await runFrontierCrawl(decl);
    else if (desc.kind === 'catalog') await runCatalog(decl);
    else await runSearchSource(decl, desc);
  }

  // Direct transport buffers deliveries — push out whatever this cycle left
  // pending before reporting totals. A failed flush counts as cycle errors;
  // deterministic ids make the eventual re-delivery harmless.
  if (store.flush) {
    try {
      await store.flush();
    } catch (e: any) {
      console.warn(`[transport] flush failed: ${e?.message ?? e}`);
      errors++;
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
  await flushActivity();
  if (ownStore) await ownStore.close();
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
