import { KnowledgeStore, loadOrCreateIdentity } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { executeTool, resetSeenTitles } from './tools_registry.js';
import { CrawlQueue } from './crawl_queue.js';

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

  const indexInEmbedder = (id: string, text: string, frag: FragInput) => {
    const arxivId = frag.source?.match(/arXiv:(\S+)/i)?.[1] ?? null;
    fetch(`${effectiveEmbedderUrl}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, text,
        metadata: {
          source: frag.source, doi: frag.doi ?? null, doi_valid: frag.doi !== null,
          confidence: frag.confidence, title: frag.title ?? null, node_id: store.nodeId,
          arxiv_id: arxivId, extracted_at: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  };

  type FragInput = { id: string; text: string; source: string; doi: string | null; confidence: number; title?: string };

  const onFragment = async (frag: FragInput) => {
    const input: Parameters<typeof store.save>[0] = {
      id: frag.id, text: frag.text, source: frag.source,
      doi: frag.doi, confidence: frag.confidence, title: frag.title,
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
        const newId = await store.supersede(frag.id, input);
        indexInEmbedder(newId, frag.text, frag);
        budget.recordFragments(1);
        fragmentsIndexed++;
        onIndexed?.({ id: newId, title: frag.title, source: frag.source });
      } catch (e: any) {
        console.warn(`[store] Supersede failed for ${frag.id}: ${e.message}`);
      }
      return;
    }

    // ── New fragment ─────────────────────────────────────────────────────────
    try {
      await store.save(input);
    } catch (e: any) {
      console.warn(`[store] Hypercore save failed for ${frag.id}: ${e.message}`);
    }
    indexInEmbedder(frag.id, frag.text, frag);
    budget.recordFragments(1);
    fragmentsIndexed++;
    console.log(`  [+] Indexed: ${frag.id} | ${frag.source} | conf:${frag.confidence}`);
    onIndexed?.({ id: frag.id, title: frag.title, source: frag.source });
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
  console.log(`\n🤖 Autonomous extractor starting (direct, no LLM)`);
  if (batchTitles.length === 0) {
    console.log(`   Queue empty — seeding via wikipedia_search("${objective.slice(0, 60)}...")`);
    const seedResult = await executeTool('wikipedia_search', { query: objective, limit: 10 }, {
      embedderUrl: effectiveEmbedderUrl,
      onFragment,
      onCrawlEnqueue,
    });
    if (seedResult.ok && (seedResult.data as any)?.titles) {
      const titles = (seedResult.data as any).titles as string[];
      crawlQueue.enqueueMany(titles);
      console.log(`   Seeded queue with ${titles.length} titles from search`);
    } else {
      console.warn(`   Seed search failed: ${seedResult.error ?? 'no results'}`);
    }
    // Now refill our batch from the freshly-seeded queue
    const seededBatch = crawlQueue.dequeueBatch(BATCH_PER_CYCLE);
    batchTitles.push(...seededBatch);
  }

  console.log(`   Crawl batch: ${batchTitles.length} titles | queue: ${crawlQueue.size()} | visited: ${crawlQueue.visitedSize()}`);
  console.log(`   Budget: ${budget['cfg'].maxTokens} tokens | ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min\n`);

  // Drain the batch deterministically — one wikipedia_fetch per title.
  for (const title of batchTitles) {
    const check = budget.exhausted();
    if (check.yes) {
      console.log(`[budget] Exhausted: ${check.reason}`);
      finalSummary = `Budget exhausted (${check.reason}). Indexed ${fragmentsIndexed} fragments.`;
      break;
    }
    console.log(`  [fetch] wikipedia_fetch("${title}")`);
    try {
      const result = await executeTool('wikipedia_fetch', { title }, {
        embedderUrl: effectiveEmbedderUrl,
        onFragment,
        onCrawlEnqueue,
      });
      if (!result.ok) {
        console.warn(`  [fetch] failed for "${title}": ${result.error}`);
      } else {
        const d = result.data as any;
        console.log(`  [fetch] "${title}" → indexed ${d?.indexed_count ?? 0} sections, discovered ${d?.links_discovered ?? 0} links`);
      }
    } catch (e: any) {
      console.warn(`  [fetch] exception for "${title}": ${e.message}`);
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


  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const check = budget.exhausted();
    if (check.yes) {
      console.log(`\n[budget] Exhausted: ${check.reason}`);
      finalSummary = `Budget exhausted (${check.reason}). Indexed ${fragmentsIndexed} fragments.`;
      break;
    }

    let response;
    try {
      response = await provider.generateWithTools(messages, SYSTEM_PROMPT, TOOL_DECLARATIONS);
      onLLMHealth?.(true);
    } catch (e: any) {
      console.error(`[llm] Error: ${e.message}`);
      const isAuthError = /401|403|invalid.api.key|invalid_api_key/i.test(e.message);
      onLLMHealth?.(isAuthError ? false : true);
      break;
    }
    budget.recordTokens(response.tokensUsed);

    // Add assistant response to history
    const assistantParts: MessagePart[] = [];
    if (response.text) assistantParts.push({ type: 'text', text: response.text });
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        assistantParts.push({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args });
      }
    }
    if (assistantParts.length) messages.push({ role: 'assistant', parts: assistantParts });

    if (!response.toolCalls?.length) {
      // Model responded with text only — finished naturally
      finalSummary = response.text ?? 'Session complete.';
      console.log(`\n[agent] ${finalSummary}`);
      break;
    }

    // Execute each tool call
    const toolResultParts: MessagePart[] = [];
    for (const tc of response.toolCalls) {
      console.log(`  [tool] ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)})`);

      if (tc.name === 'arxiv_search') budget.recordArxivCall();
      if (tc.name === 'web_fetch') budget.recordWebFetch();

      if (tc.name === 'finish') {
        finalSummary = tc.args.summary as string;
        console.log(`\n[agent] Done: ${finalSummary}`);
        await crawlQueue.flush();
        const finalQ = crawlQueue.summary();
        console.log(`[queue] flushed: queue=${finalQ.queue} visited=${finalQ.visited}`);
        if (ownStore) await store.close();
        return { fragmentsIndexed, summary: finalSummary, budget: budget.summary() };
      }

      const result = await executeTool(tc.name, tc.args, {
        embedderUrl: effectiveEmbedderUrl,
        onFragment,
        onCrawlEnqueue,
      });
      toolResultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result });
    }

    messages.push({ role: 'user', parts: toolResultParts });
  }

  // Persist queue even if budget/iterations cap stopped us before finish()
  await crawlQueue.flush();
  const finalQ = crawlQueue.summary();
  console.log(`[queue] flushed: queue=${finalQ.queue} visited=${finalQ.visited}`);

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
