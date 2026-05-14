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

STRICT RULE: After EACH fetch tool call, immediately call index_fragment for every relevant section/item found before making another fetch. Never batch multiple fetches before indexing.

Your mission: extract and index relevant knowledge fragments from diverse sources.

Tools:
- wikipedia_fetch(title): fetch a Wikipedia article split into ALL its sections. Returns section list with title + content. ALWAYS use this for Wikipedia — never web_fetch a Wikipedia URL.
- web_fetch(url): fetch a non-Wikipedia webpage (articles, blogs, documentation)
- rss_fetch(url, limit): fetch an RSS/Atom feed (max 8 articles)
- arxiv_search(query, limit): search arXiv (scientific topics only)
- index_fragment(id, text, source, doi, confidence, title): store ONE fragment
- finish(summary, fragments_count): end the session

REQUIRED workflow — repeat until budget exhausted:
  1. Pick ONE source and fetch it
  2. For wikipedia_fetch: call index_fragment for EACH section returned (skip only "References", "See also", "External links")
  3. For other sources: call index_fragment for each relevant item
  4. Then pick the NEXT source and repeat

Source selection:
- Facts/history/culture → wikipedia_fetch(title) — covers ALL sections of the article
- News/tech/events → rss_fetch, then web_fetch(link) on important articles for full content
- Academic papers → arxiv_search (returns full abstracts — index them as-is)
- Specific URLs → web_fetch(url)

RSS workflow: after rss_fetch, for each article either:
  a) Index directly if content field is long enough (>200 chars)
  b) Call web_fetch(link) to get the full article, then index

Fragment format:
- id: MUST match source type:
  - Wikipedia section → "wiki_{page_slug}_{section_slug}"  e.g. "wiki_astrophysics_stellar_evolution"
  - Wikipedia intro  → "wiki_{page_slug}_intro"  e.g. "wiki_astrophysics_intro"
  - RSS/news  → "rss_{outlet}_{title_slug}"  e.g. "rss_bbc_new_particle_found"
  - arXiv     → "{arxiv_id}_c0"  e.g. "2405.12345v1_c0"  (ONLY for real arXiv papers)
  - Other web → "web_{domain}_{slug}"
- text: USE THE ACTUAL TEXT FROM THE SOURCE verbatim or near-verbatim. Do NOT paraphrase or summarize. Include as much of the provided content as fits.
- title: the article or section title
- source: the actual URL or "arXiv:{id}" for arXiv
- confidence: 0.9 Wikipedia, 0.85 major news, 0.7 arXiv, 0.6 other
- doi: null unless a real DOI starting with "10." — never the string "null"

Call finish() when budget is near exhaustion or after 2-3 sources.`;

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
