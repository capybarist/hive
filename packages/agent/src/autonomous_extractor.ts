import { KnowledgeStore, loadOrCreateIdentity, buildEmbedderPayload } from '@hive/core';
import type { BeeManifest, DeclaredSource, Fragment } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { CrawlQueue } from './crawl_queue.js';
import { wikipediaSource } from './forager/wikipedia_source.js';
import { arxivSource } from './forager/arxiv_source.js';
import { rssSource } from './forager/rss_source.js';
import { CommonCrawlSource } from './forager/common_crawl_source.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// HIVE forager — a bee that goes out to bring knowledge back to the colmena.
//
// In v0.6.1 we removed the LLM from this loop entirely. The previous design
// asked the LLM (qwen2.5:1.5b in our deployment) to orchestrate "look at the
// queue, fetch the next title, repeat". Empirically it would call
// wikipedia_search and then narrate "Please proceed with the next cycle"
// instead of actually fetching, or pass arrays where wikipedia_fetch wanted
// a string. The crawl flow is purely mechanical — drain queue → fetch →
// enqueue links — so we now run it as straight code. The LLM is reserved for
// /api/query synthesis (a different code path in the aggregator).

export type { BudgetConfig } from './budget_controller.js';

export interface ExtractionResult {
  fragmentsIndexed: number;
  summary: string;
  budget: ReturnType<BudgetController['summary']>;
}

export async function runAutonomousExtraction(
  objective: string,
  budgetConfig: Partial<BudgetConfig> = {},
  existingStore?: KnowledgeStore,
  embedderUrlOverride?: string,
  onIndexed?: (frag: { id: string; title?: string; source: string }) => void,
  // onLLMHealth kept in signature for backwards-compat with old callers
  // (api_server.ts passes it). We always report "ok" since this path no
  // longer touches the LLM.
  onLLMHealth?: (ok: boolean) => void,
): Promise<ExtractionResult> {
  onLLMHealth?.(true);

  const effectiveEmbedderUrl = embedderUrlOverride ?? EMBEDDER_URL;
  const budget = new BudgetController({ ...DEFAULT_BUDGET, ...budgetConfig });

  // Use the provided store (no lock conflict) or open a new one for CLI use
  let store: KnowledgeStore;
  let ownStore = false;
  if (existingStore) {
    store = existingStore;
  } else {
    const identity = loadOrCreateIdentity(resolve(DATA_DIR, 'identity'));
    store = new KnowledgeStore(DATA_DIR, identity);
    await store.ready();
    ownStore = true;
  }

  let fragmentsIndexed = 0;
  let finalSummary = '';

  // v0.7.2: in-cycle title dedup used to live in tools_registry's
  // _seenTitles Set, cleared at the top of each cycle. With sources
  // now adapter-isolated (each is stateless), in-cycle dedup is
  // handled at the CrawlQueue level for Wikipedia and is unnecessary
  // for arXiv/RSS (rarely repeated titles within a single cycle).

  // ── Manifest-driven source selection (v0.7.5) ───────────────────────────────
  // Read the BEE's own manifest from Hypercore to learn which sources it has
  // declared. Fallback: no manifest → [{id:'wikipedia-en', policy:'drift-ok'}]
  // (v0.6 behaviour preserved). Queens (HAS_LOCAL_STORE=false) never publish a
  // manifest so they stay on the fallback path, which is fine — they don't run
  // extraction.
  let manifest: BeeManifest | null = null;
  try {
    manifest = await store.getLocalManifest();
  } catch { /* manifest not published yet — first boot, use defaults */ }

  const declaredSources: DeclaredSource[] = manifest?.declared_sources?.length
    ? manifest.declared_sources
    : [{ id: 'wikipedia-en', policy: 'drift-ok' }];

  const wikiDecl   = declaredSources.find(s => s.id === 'wikipedia-en');
  const arxivDecl  = declaredSources.find(s => s.id === 'arxiv');
  const rssDecl    = declaredSources.find(s => s.id === 'rss');
  const ccDecl     = declaredSources.find(s => s.id === 'common-crawl' || s.id.startsWith('common-crawl-'));

  console.log(`[manifest] Active sources: ${declaredSources.map(s => s.id).join(', ')} (from ${manifest ? 'published manifest' : 'defaults'})`);

  // Build a scoped Common Crawl instance if declared (scope carries snapshot + domains)
  const ccSource = ccDecl ? new CommonCrawlSource({
    snapshot: (ccDecl.scope?.snapshot as string | undefined) ?? undefined,
    domains:  Array.isArray(ccDecl.scope?.domains) ? ccDecl.scope!.domains as string[] : [],
  }) : null;

  // ── Persistent crawl queue (Wikipedia forager) ───────────────────────────────
  // Loaded once per cycle. We pull a small batch off the head, hand those to
  // the LLM as the cycle's work, and any new links wikipedia_fetch discovers
  // get enqueued for future cycles. The queue dedupes against the visited set
  // so we never re-process the same title.
  const crawlQueue = new CrawlQueue({ dataDir: DATA_DIR });
  await crawlQueue.load();
  const BATCH_PER_CYCLE = 5;
  const batchTitles = wikiDecl ? crawlQueue.dequeueBatch(BATCH_PER_CYCLE) : [];
  const queueSummary = crawlQueue.summary();

  // TTL by source type — how long before stale content should be superseded
  const getFragmentTTL = (id: string): number => {
    const h = 3_600_000;
    if (id.startsWith('wiki_'))  return 7  * 24 * h;  // Wikipedia: stable, 7 days
    if (id.startsWith('rss_'))   return 24 * h;         // News/RSS: 24 hours
    if (id.match(/^\d{4}\.\d/)) return 30 * 24 * h;    // arXiv: immutable, 30 days
    return 3 * 24 * h;                                   // Other web: 3 days
  };

  const indexInEmbedder = (frag: Fragment) => {
    fetch(`${effectiveEmbedderUrl}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: frag.id,
        text: frag.text,
        metadata: buildEmbedderPayload(frag),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  };

  type FragInput = { id: string; text: string; source: string; doi: string | null; confidence: number; title?: string };

  const onFragment = async (frag: FragInput) => {
    // arXiv IDs travel as a structured field so academic-source fragments
    // can be filtered downstream without parsing the source URL each time.
    const arxivId = frag.source?.match(/arXiv:(\S+)/i)?.[1];
    const input: Parameters<typeof store.save>[0] = {
      id: frag.id, text: frag.text, source: frag.source,
      doi: frag.doi, confidence: frag.confidence, title: frag.title,
      arxiv_id: arxivId,
      extracted_at: new Date().toISOString(), node_id: store.nodeId,
    };

    // ── Cross-cycle dedup + TTL ──────────────────────────────────────────────
    // Hypercore is the source of truth — check it before spending LLM budget.
    const existing = await store.get(frag.id).catch(() => null);
    if (existing) {
      const ageMs = Date.now() - new Date(existing.extracted_at).getTime();
      const ttlMs = getFragmentTTL(frag.id);

      if (ageMs < ttlMs) {
        // Fresh content — skip entirely, save tokens
        console.log(`  [skip] ${frag.id} (${Math.round(ageMs / 3_600_000)}h old, TTL ${ttlMs / 3_600_000}h)`);
        return;
      }

      // Stale content — supersede in Hypercore and update embedder
      console.log(`  [supersede] ${frag.id} (${Math.round(ageMs / 3_600_000)}h old)`);
      try {
        const newFrag = await store.supersede(frag.id, input);
        indexInEmbedder(newFrag);
        budget.recordFragments(1);
        fragmentsIndexed++;
        onIndexed?.({ id: newFrag.id, title: newFrag.title, source: newFrag.source });
      } catch (e: any) {
        console.warn(`[store] Supersede failed for ${frag.id}: ${e.message}`);
      }
      return;
    }

    // ── New fragment ─────────────────────────────────────────────────────────
    // We save to Hypercore first so the embedder payload carries the canonical
    // hash + signature. If Hypercore write fails (timeout, session closed) we
    // skip the embedder entirely — a fragment that isn't in the signed log
    // shouldn't appear as if it were.
    try {
      const saved = await store.save(input);
      indexInEmbedder(saved);
      budget.recordFragments(1);
      fragmentsIndexed++;
      console.log(`  [+] Indexed: ${saved.id} | ${saved.source} | conf:${saved.confidence}`);
      onIndexed?.({ id: saved.id, title: saved.title, source: saved.source });
    } catch (e: any) {
      console.warn(`[store] Hypercore save failed for ${frag.id} — skipping embedder: ${e.message}`);
    }
  };

  // Crawler callback: tools (mainly wikipedia_fetch) feed discovered titles here.
  const onCrawlEnqueue = (titles: string[]) => {
    const added = crawlQueue.enqueueMany(titles);
    if (added > 0) console.log(`  [queue] +${added} new titles (size now ${crawlQueue.size()})`);
  };

  // ── Direct-mode crawler (NO LLM) ────────────────────────────────────────────
  // v0.7.5: sources are now driven by the BEE manifest (declared_sources).
  // Sources not declared in the manifest are skipped; fallback (no manifest)
  // runs Wikipedia-only, preserving v0.6 behaviour.
  console.log(`\n🤖 Autonomous extractor starting (direct, no LLM)`);
  console.log(`   Budget: ${budget['cfg'].maxTokens} tokens | ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min`);

  // ── Wikipedia (BFS crawler) ──────────────────────────────────────────────
  if (wikiDecl) {
    // v0.7.6 — seed query priority:
    //   1. wikiDecl.partition (the narrowest claim) — e.g. "Category:Pharmacology"
    //   2. wikiDecl.scope.category_tree                — e.g. "Category:Medicine"
    //   3. quoted topic from the objective string
    //   4. first 60 chars of the objective as fallback
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
      // BFS frontier stuck — bootstrap re-fetch to discover new links
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
        for (const frag of result.fragments) await onFragment(frag);
        // v0.7.6 — under policy=exclusive + partition, drop outbound links
        // that fall outside the claimed partition. WikipediaSource's
        // isInPartition is a coarse pre-filter (alphabetical check; category
        // membership defers to the seed-time API query elsewhere) — good
        // enough to keep the queue focused without an API call per link.
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
        if (outboundTitles.length > 0) onCrawlEnqueue(outboundTitles);
        crawlQueue.markVisited(title);
        console.log(`  [wiki] "${title}" → ${result.fragments.length} sections, ${outboundTitles.length} links`);
      } catch (e: any) {
        console.warn(`  [wiki] failed for "${title}": ${e.message ?? e}`);
      }
    }
  }

  // ── arXiv ────────────────────────────────────────────────────────────────
  // Runs when 'arxiv' is declared in the manifest (v0.7.5+), OR as an
  // aux heuristic when NOT manifest-driven and objective looks like science.
  const manifestDrivenArxiv = !!arxivDecl;
  const heuristicArxiv = !manifest && /science|physics|biology|chemistry|astrophysic|mathematic|machine\s*learning|deep\s*learning|artificial\s*intelligence|neural|quantum|cs\.|cosmology/i.test(objective);
  if ((manifestDrivenArxiv || heuristicArxiv) && !budget.exhausted().yes) {
    // v0.7.6 — query priority:
    //   1. arxivDecl.partition (e.g. "cs.LG") — most specific
    //   2. arxivDecl.scope.categories joined as a query string
    //   3. quoted topic from the objective
    const arxivQuery = arxivDecl?.partition
      ? arxivDecl.partition
      : (Array.isArray(arxivDecl?.scope?.categories) && (arxivDecl!.scope!.categories as string[]).length > 0)
        ? (arxivDecl!.scope!.categories as string[]).join(' ')
        : (objective.match(/"([^"]+)"/)?.[1] ?? objective.slice(0, 80)).trim();
    if (arxivDecl?.partition) console.log(`  [arxiv] Partition claimed: ${arxivDecl.partition}`);
    console.log(`\n  [arxiv] seed+fetch("${arxivQuery}")`);
    try {
      const urls = await arxivSource.seed({ query: arxivQuery, limit: 5 });
      let indexed = 0;
      for (const u of urls) {
        if (budget.exhausted().yes) break;
        try {
          const result = await arxivSource.fetch(u);
          for (const frag of result.fragments) await onFragment(frag);
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

  // ── RSS ──────────────────────────────────────────────────────────────────
  // Runs when 'rss' is declared, OR as aux heuristic for news objectives.
  const manifestDrivenRss = !!rssDecl;
  const heuristicRss = !manifest && /current[\s_-]?events|news|today|breaking|headline|politics|election/i.test(objective);
  if ((manifestDrivenRss || heuristicRss) && !budget.exhausted().yes) {
    // Manifest scope.feeds takes priority; fallback to env var or BBC world
    const declaredFeeds = Array.isArray(rssDecl?.scope?.feeds) ? rssDecl!.scope!.feeds as string[] : [];
    const envFeeds = (process.env.HIVE_AUX_RSS_FEEDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const defaultFeeds = ['https://feeds.bbci.co.uk/news/world/rss.xml'];
    const feeds = declaredFeeds.length > 0 ? declaredFeeds : (envFeeds.length > 0 ? envFeeds : defaultFeeds);
    const feed = feeds[Math.floor(Math.random() * feeds.length)]!;
    console.log(`\n  [rss] fetch("${feed}")`);
    try {
      const result = await rssSource.fetch(feed);
      for (const frag of result.fragments) await onFragment(frag);
      console.log(`  [rss] indexed ${result.fragments.length} items`);
    } catch (e: any) {
      console.warn(`  [rss] failed: ${e.message ?? e}`);
    }
  }

  // ── Common Crawl ─────────────────────────────────────────────────────────
  // Only runs when explicitly declared in the manifest — no heuristic fallback.
  // Requires scope.domains (or HIVE_CC_DOMAINS env var) to be non-empty;
  // without a domain target, seed() would query the entire CC snapshot.
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
          for (const frag of result.fragments) await onFragment(frag);
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

  if (!finalSummary) {
    finalSummary = `Crawl cycle complete. Indexed ${fragmentsIndexed} new fragments. Queue: ${crawlQueue.size()}, visited: ${crawlQueue.visitedSize()}.`;
  }
  console.log(`\n[done] ${finalSummary}`);

  await crawlQueue.flush();
  if (ownStore) await store.close();
  return { fragmentsIndexed, summary: finalSummary, budget: budget.summary() };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
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
