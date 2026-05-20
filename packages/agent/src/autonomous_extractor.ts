import { KnowledgeStore, loadOrCreateIdentity, createLLMProvider } from '@hive/core';
import type { LLMMessage, MessagePart } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { TOOL_DECLARATIONS, executeTool, resetSeenTitles } from './tools_registry.js';
import { CrawlQueue } from './crawl_queue.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

const SYSTEM_PROMPT = `You are HIVE's autonomous knowledge extraction agent. You run fully autonomously — NEVER ask for user input, NEVER ask for clarification, NEVER wait for a response. If a tool fails, immediately try the next tool without commenting.

You operate as a Wikipedia-style spider. Each cycle the runtime hands you a small queue of article titles to process. Your job is to call wikipedia_fetch on each one, in order, until the queue is drained OR your budget is near exhausted. Every fetched article automatically adds its internal Wikipedia links to a persistent crawl queue that future cycles will consume — that is how HIVE grows indefinitely. You do not have to plan exploration; the queue does it for you.

You only deviate from queue-draining in two cases:
  1. Queue is empty (rare — only at first boot or after a wipe). Then call wikipedia_search(topic_keywords, limit=10) to seed 5-10 starting titles, then wikipedia_fetch each one.
  2. The topic is scientific. After the queue is drained you MAY call arxiv_search(query) once to add academic depth.

Tools (the fetch ones do their own indexing — you never write text):
- wikipedia_fetch(title): fetches a Wikipedia article, indexes every section verbatim, AND enqueues every internal link it finds for future cycles. This is your primary tool — call it once per queued title.
- wikipedia_search(query, limit): SEARCH-only. Returns related Wikipedia titles. Does NOT index. Use only to seed when the queue is empty.
- arxiv_search(query, limit): searches arXiv and indexes each paper's abstract verbatim. Use after queue drained for scientific topics.
- rss_fetch(url, limit): RSS/Atom feed → indexes each article verbatim. Only if a known feed URL is supplied.
- web_fetch(url): non-Wikipedia URL → indexes chunks verbatim. Avoid unless you need a very specific page.
- finish(summary, fragments_count): end the session when budget exhausts.

What you DO NOT do:
  - Do NOT call wikipedia_search if the queue already has titles to process — drain it first.
  - Do NOT call index_fragment after a fetch — the fetch tools index automatically.
  - Do NOT read the section text from the fetch response — you only see counts + titles + links_discovered.
  - Do NOT skip queue items "because the topic looks unrelated". The spider crawls; the embedder filters at query time.
  - Do NOT generate IDs or paraphrase text — the tools generate stable IDs from the source.

Workflow per turn:
  - Pick the next queued title (provided in the user message)
  - Call wikipedia_fetch(that title)
  - Move on to the next title without commentary
  - When all queued titles are done OR budget is near exhausted, call finish()`;

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
  onLLMHealth?: (ok: boolean) => void,
): Promise<ExtractionResult> {
  const provider = createLLMProvider();

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

  // ── Persistent crawl queue (Wikipedia spider) ───────────────────────────────
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

  // Build the user message. If the queue has work, the queue is the
  // objective — the LLM just walks through titles. If empty, fall back
  // to the agent's natural-language objective (seed-mode).
  const objectiveText = batchTitles.length > 0
    ? [
        `Crawl queue has ${queueSummary.queue} pending Wikipedia titles after this batch was reserved for you.`,
        `Visited so far: ${queueSummary.visited} unique titles.`,
        ``,
        `Process THESE TITLES IN ORDER by calling wikipedia_fetch on each one.`,
        `Do not search, do not deviate — just fetch:`,
        ...batchTitles.map(t => `  - ${t}`),
        ``,
        `Each wikipedia_fetch automatically indexes verbatim and grows the crawl`,
        `queue. When you've processed all titles above, call finish().`,
      ].join('\n')
    : [
        `The crawl queue is empty (first-boot or post-wipe). Seed it.`,
        ``,
        `Research objective for SEEDING ONLY: ${objective}`,
        ``,
        `Step 1: call wikipedia_search(query, limit=10) ONCE to discover seed titles.`,
        `Step 2: call wikipedia_fetch on each returned title.`,
        `Step 3: call finish(). Subsequent cycles will use the populated queue.`,
      ].join('\n');

  const messages: LLMMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: objectiveText }] },
  ];

  console.log(`\n🤖 Autonomous extractor starting`);
  if (batchTitles.length > 0) {
    console.log(`   Crawl mode — batch: ${batchTitles.length} titles | queue: ${queueSummary.queue} | visited: ${queueSummary.visited}`);
  } else {
    console.log(`   Seed mode (queue empty) — Objective: ${objective}`);
  }
  console.log(`   Budget: ${budget['cfg'].maxTokens} tokens | ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min\n`);

  // Crawler callback: tools (mainly wikipedia_fetch) feed discovered titles here.
  const onCrawlEnqueue = (titles: string[]) => {
    const added = crawlQueue.enqueueMany(titles);
    if (added > 0) console.log(`  [queue] +${added} new titles (size now ${crawlQueue.size()})`);
  };

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
