import { KnowledgeStore, loadOrCreateIdentity, buildEmbedderPayload } from '@hive/core';
import type { Fragment } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { executeTool, resetSeenTitles } from './tools_registry.js';
import { CrawlQueue } from './crawl_queue.js';
import { wikipediaSource } from './forager/wikipedia_source.js';

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

  // Reset per-session title dedup (prevents same article from two sources in one cycle)
  resetSeenTitles();

  // ── Persistent crawl queue (Wikipedia forager) ───────────────────────────────
  // Loaded once per cycle. We pull a small batch off the head, hand those to
  // the LLM as the cycle's work, and any new links wikipedia_fetch discovers
  // get enqueued for future cycles. The queue dedupes against the visited set
  // so we never re-process the same title.
  const crawlQueue = new CrawlQueue({ dataDir: DATA_DIR });
  await crawlQueue.load();
  const BATCH_PER_CYCLE = 5;
  const batchTitles = crawlQueue.dequeueBatch(BATCH_PER_CYCLE);
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
  // The 1.5B Ollama model was unreliable as an orchestrator: it called
  // wikipedia_search, then narrated about "next cycle" instead of fetching,
  // or passed wrong argument shapes to wikipedia_fetch. The crawler is purely
  // mechanical (drain queue → fetch each → enqueue links) so we run it
  // deterministically and skip the LLM altogether. Query synthesis still uses
  // the LLM in the aggregator — that's a different code path.
  //
  // v0.7.1 — the Wikipedia path now goes through the ForagerSource interface
  // (packages/agent/src/forager/wikipedia_source.ts). Behaviour is bit-for-bit
  // the same; what changed is the seam. Auxiliary RSS / arXiv branches below
  // still call the legacy `executeTool` tools — they migrate to ForagerSource
  // adapters in v0.7.2.
  console.log(`\n🤖 Autonomous extractor starting (direct, no LLM) — wikipedia via ForagerSource`);
  if (batchTitles.length === 0) {
    // Objectives are verbose LLM prompts like `Find recent content about
    // "Biodiversity and Conservation" (...)`. Wikipedia's search wants a
    // short noun phrase — extract the quoted topic name, or fall back to
    // the first ~50 chars if no quotes are present.
    const quoted = objective.match(/"([^"]+)"/);
    const searchQuery = quoted ? quoted[1] : objective.slice(0, 60);
    console.log(`   Queue empty — seeding via wikipediaSource.seed("${searchQuery}")`);
    let seedTitles: string[] = [];
    try {
      const seedUrls = await wikipediaSource.seed({ query: searchQuery, limit: 10 });
      // Bridge until v0.7.3 moves the crawl queue itself to URL storage:
      // the queue keeps storing Wikipedia titles, so map adapter-returned
      // URLs back to titles here.
      seedTitles = seedUrls
        .map((u) => wikipediaSource.titleFromUrl(u))
        .filter((t): t is string => t !== null);
      const added = crawlQueue.enqueueMany(seedTitles);
      console.log(`   Seeded queue with ${added}/${seedTitles.length} new titles (rest already visited)`);
    } catch (e: any) {
      console.warn(`   Seed search failed: ${e.message ?? e}`);
    }
    // Now refill our batch from the freshly-seeded queue
    const seededBatch = crawlQueue.dequeueBatch(BATCH_PER_CYCLE);
    batchTitles.push(...seededBatch);

    // Fallback: if seed returned only visited titles, the BFS frontier is
    // stuck. Re-fetch one of the seeded (visited) articles anyway — its
    // outgoing /wiki/ links are the lifeline that unblocks the queue.
    // onFragment dedups by id so re-indexing is harmless; the side-effect
    // we want is link discovery via outbound URLs.
    if (batchTitles.length === 0 && seedTitles.length > 0) {
      const bootstrap = seedTitles[0]!;
      console.log(`   All ${seedTitles.length} seed titles already visited — bootstrap re-fetch of "${bootstrap}" to discover new links`);
      batchTitles.push(bootstrap);
    }
  }

  console.log(`   Crawl batch: ${batchTitles.length} titles | queue: ${crawlQueue.size()} | visited: ${crawlQueue.visitedSize()}`);
  console.log(`   Budget: ${budget['cfg'].maxTokens} tokens | ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min\n`);

  // Drain the batch deterministically — one wikipediaSource.fetch per title.
  // We only mark a title as `visited` if the fetch succeeded; transient
  // failures (network blip, Wikipedia 503) leave the title eligible for
  // re-enqueue by a future fetch that discovers the same link.
  for (const title of batchTitles) {
    const check = budget.exhausted();
    if (check.yes) {
      console.log(`[budget] Exhausted: ${check.reason}`);
      finalSummary = `Budget exhausted (${check.reason}). Indexed ${fragmentsIndexed} fragments.`;
      break;
    }
    console.log(`  [fetch] wikipediaSource.fetch("${title}")`);
    try {
      const url = wikipediaSource.urlFromTitle(title);
      const result = await wikipediaSource.fetch(url);
      // Pipe fragments through onFragment so the existing dedup / TTL /
      // supersede / Hypercore-save / embedder-POST pipeline applies
      // unchanged. The adapter has no opinion on those concerns.
      for (const frag of result.fragments) {
        await onFragment(frag);
      }
      const outboundTitles = result.outboundLinks
        .map((u) => wikipediaSource.titleFromUrl(u))
        .filter((t): t is string => t !== null);
      if (outboundTitles.length > 0) onCrawlEnqueue(outboundTitles);
      crawlQueue.markVisited(title);
      console.log(`  [fetch] "${title}" → indexed ${result.fragments.length} sections, discovered ${outboundTitles.length} links`);
    } catch (e: any) {
      console.warn(`  [fetch] failed for "${title}": ${e.message ?? e} — leaving unvisited for retry`);
    }
  }

  // ── Auxiliary sources (rule-based, no LLM) ──────────────────────────────
  // After draining the Wikipedia batch we optionally pull from one
  // supplementary source per cycle, picked from the topic objective:
  //   - "current_events" / news / today        → rss_fetch over a curated feed
  //   - "science", "physics", "biology", math, ml, ai, cs → arxiv_search
  //   - otherwise nothing extra (Wikipedia covers it)
  // The choice is deterministic so the LLM stays out. Curated feeds and
  // categories are tweakable via env (HIVE_AUX_RSS_FEEDS, HIVE_AUX_ARXIV).
  if (!budget.exhausted().yes) {
    const lower = objective.toLowerCase();
    const auxQuery = (objective.match(/"([^"]+)"/)?.[1] ?? objective.slice(0, 80)).trim();

    const newsRe = /current[\s_-]?events|news|today|breaking|headline|politics|election/;
    const scienceRe = /science|physics|biology|chemistry|astrophysic|mathematic|machine\s*learning|deep\s*learning|artificial\s*intelligence|neural|quantum|cs\.|cosmology/;

    if (newsRe.test(lower)) {
      const feeds = (process.env.HIVE_AUX_RSS_FEEDS ?? 'https://feeds.bbci.co.uk/news/world/rss.xml,https://www.reutersagency.com/feed/').split(',').map(s => s.trim()).filter(Boolean);
      const feed = feeds[Math.floor(Math.random() * feeds.length)];
      console.log(`\n  [aux] rss_fetch("${feed}") — news domain detected`);
      try {
        const r = await executeTool('rss_fetch', { url: feed, limit: 10 }, {
          embedderUrl: effectiveEmbedderUrl, onFragment, onCrawlEnqueue,
        });
        if (r.ok) console.log(`  [aux] rss indexed ${(r.data as any)?.indexed_count ?? 0} items`);
        else console.warn(`  [aux] rss failed: ${r.error}`);
      } catch (e: any) {
        console.warn(`  [aux] rss exception: ${e.message}`);
      }
    } else if (scienceRe.test(lower)) {
      console.log(`\n  [aux] arxiv_search("${auxQuery}") — science domain detected`);
      try {
        const r = await executeTool('arxiv_search', { query: auxQuery, limit: 5 }, {
          embedderUrl: effectiveEmbedderUrl, onFragment, onCrawlEnqueue,
        });
        if (r.ok) console.log(`  [aux] arxiv indexed ${(r.data as any)?.indexed_count ?? 0} papers`);
        else console.warn(`  [aux] arxiv failed: ${r.error}`);
      } catch (e: any) {
        console.warn(`  [aux] arxiv exception: ${e.message}`);
      }
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
