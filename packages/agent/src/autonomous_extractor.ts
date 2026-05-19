import { KnowledgeStore, loadOrCreateIdentity, createLLMProvider } from '@hive/core';
import type { LLMMessage, MessagePart } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { TOOL_DECLARATIONS, executeTool, resetSeenTitles } from './tools_registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

const SYSTEM_PROMPT = `You are HIVE's autonomous knowledge extraction agent. You run fully autonomously — NEVER ask for user input, NEVER ask for clarification, NEVER wait for a response. If a tool fails, immediately try the next tool without commenting.

Your mission: pick good sources for the assigned objective. The fetch tools handle indexing themselves with verbatim content from the source — you DO NOT write or paraphrase fragment text. Your job is to decide WHAT to fetch and WHEN to stop.

Tools and what they do automatically:
- wikipedia_fetch(title): fetches a Wikipedia article and indexes every section verbatim. ALWAYS prefer this for any Wikipedia content. Returns count + section titles, NOT text.
- arxiv_search(query, limit): searches arXiv and indexes each paper's abstract verbatim. Use for scientific/academic topics. Returns count + paper titles.
- rss_fetch(url, limit): fetches an RSS/Atom feed and indexes each article's body verbatim. Use only when you know an RSS URL (ends in .xml, /rss, /feed).
- web_fetch(url, confidence?): fetches a non-Wikipedia URL and indexes the content in verbatim chunks. Use for specific article URLs.
- index_fragment(...): legacy/manual indexing. ONLY use if you have non-source-derived text. Almost never needed under the new flow.
- finish(summary, fragments_count): end the session.

REQUIRED workflow — repeat until budget exhausted:
  1. Start with wikipedia_fetch(main_topic_title) — most reliable, gives you many fragments per call
  2. Then arxiv_search(specific_keywords) for academic depth (when topic is scientific)
  3. Then rss_fetch(known_feed_url) for news/recent content (when applicable)
  4. Then web_fetch(specific_url) only if a particular page is highly relevant
  5. Call finish() when budget is near exhausted or after 2-3 sources

What you DO NOT do anymore (compared to old prompt):
  - Do NOT call index_fragment after each fetch — the fetch tools do it themselves
  - Do NOT read the section/article text from the fetch tool response — you only see counts + titles
  - Do NOT generate IDs or paraphrase text — the tools generate stable IDs from the source

Source priority and confidence (auto-assigned by tools):
  - Wikipedia sections: 0.9
  - RSS articles      : 0.85
  - arXiv papers      : 0.7
  - Web pages         : 0.7 (or pass confidence arg)

Move quickly: one fetch call per turn, then the next. Don't second-guess what to fetch; just keep coverage diverse.`;

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

  const messages: LLMMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: `Research objective: ${objective}\n\nStart extracting knowledge now. Remember to call finish() when done.` }] },
  ];

  console.log(`\n🤖 Autonomous extractor starting`);
  console.log(`   Objective: ${objective}`);
  console.log(`   Budget: ${budget['cfg'].maxTokens} tokens | ${budget['cfg'].maxFragments} fragments | ${budget['cfg'].maxMinutes}min\n`);

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
        if (ownStore) await store.close();
        return { fragmentsIndexed, summary: finalSummary, budget: budget.summary() };
      }

      const result = await executeTool(tc.name, tc.args, { embedderUrl: effectiveEmbedderUrl, onFragment });
      toolResultParts.push({ type: 'tool_result', id: tc.id, name: tc.name, result });
    }

    messages.push({ role: 'user', parts: toolResultParts });
  }

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
