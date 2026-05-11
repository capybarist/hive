import { KnowledgeStore, loadOrCreateIdentity, createLLMProvider } from '@hive/core';
import type { LLMMessage, MessagePart } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { TOOL_DECLARATIONS, executeTool, resetSeenTitles } from './tools_registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

const SYSTEM_PROMPT = `You are HIVE's autonomous knowledge extraction agent.

Your mission: given a research objective, extract and index as many relevant scientific papers as possible from arXiv into the HIVE knowledge network.

Tools available:
- arxiv_search(query, limit): search arXiv for scientific papers
- rss_fetch(url, limit): fetch an RSS/Atom feed, returns articles with title+description
- web_fetch(url): fetch any webpage and extract text
- crossref_validate(doi): check if a DOI is real
- index_fragment(id, text, source, doi, confidence, title): store ONE fragment
- finish(summary, fragments_count): end the session

Extraction strategy — maximize coverage:
1. If the objective mentions RSS feeds or news: use rss_fetch on each URL, then index each article
2. If the objective is about scientific papers: use arxiv_search
3. For EVERY item found: immediately call index_fragment
4. Then explore related sub-topics or feeds mentioned in the content
5. Keep going until budget runs out
6. Do NOT call chunk_text or crossref_validate unless you have extra budget — just index directly

Fragment format:
- id: "{arxiv_id}_c0" (always c0 for abstract-level fragments)
- text: the full title + ". " + abstract text
- confidence: 0.95 if DOI present, 0.70 if arXiv-only

Domain focus: ONLY index papers directly about the stated objective.
Reject papers that merely mention the topic in passing.
If you index something off-topic, you are wasting the budget.

Maximize: papers indexed per token spent. Call finish() when budget is near exhaustion.`;

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

  // Reset per-session dedup so a new extraction cycle can re-index previously seen titles
  resetSeenTitles();

  const onFragment = async (frag: { id: string; text: string; source: string; doi: string | null; confidence: number; title?: string }) => {
    // Save to Hypercore (source of truth + P2P replication via watchFragments)
    try {
      await store.save({
        id: frag.id, text: frag.text, source: frag.source,
        doi: frag.doi, confidence: frag.confidence, title: frag.title,
        extracted_at: new Date().toISOString(), node_id: store.nodeId,
      });
    } catch (e: any) {
      console.warn(`[store] Hypercore save failed for ${frag.id}: ${e.message}`);
    }
    // Extract arxiv_id from source string (e.g. "arXiv:2605.05576v1" → "2605.05576v1")
    const arxivId = frag.source?.match(/arXiv:(\S+)/i)?.[1] ?? null;
    // Direct HNSW write for immediate local search availability.
    // watchFragments() handles P2P-replicated fragments and startup replay.
    fetch(`${effectiveEmbedderUrl}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: frag.id, text: frag.text,
        metadata: {
          source: frag.source, doi: frag.doi ?? null, doi_valid: frag.doi !== null,
          confidence: frag.confidence, title: frag.title ?? null, node_id: store.nodeId,
          arxiv_id: arxivId,
          extracted_at: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
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
    } catch (e: any) {
      console.error(`[llm] Error: ${e.message}`);
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
