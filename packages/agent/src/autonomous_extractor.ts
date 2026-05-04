import { KnowledgeStore, loadOrCreateIdentity } from '@hive/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetController, BudgetConfig, DEFAULT_BUDGET } from './budget_controller.js';
import { TOOL_DECLARATIONS, executeTool } from './tools_registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.HIVE_DATA_DIR ?? resolve(__dirname, '../../../data');
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SYSTEM_PROMPT = `You are HIVE's autonomous knowledge extraction agent.

Your mission: given a high-level research objective, autonomously discover, validate, and index scientific knowledge into the HIVE network.

You have access to these tools:
- arxiv_search: find papers on a topic
- crossref_validate: verify a DOI exists
- web_fetch: get content from any URL
- chunk_text: split text into indexable fragments
- index_fragment: store a verified fragment in HIVE
- finish: end the session with a summary

Strategy:
1. Start broad: search arXiv for the main topic
2. For each relevant paper: validate DOI, chunk the abstract+title, index the chunks
3. Follow interesting leads: if a paper mentions related work, search for that too
4. Prioritize papers with valid DOIs (higher confidence)
5. Avoid indexing duplicates (same arXiv ID already indexed)
6. When budget is near exhaustion or you've covered the topic well, call finish()

Quality rules:
- Only index content directly relevant to the objective
- Keep confidence 0.95 for DOI-validated papers, 0.70 for arXiv-only
- Fragment IDs must be unique: use format {arxiv_id}_c{chunk_index} or {domain}_{hash}`;

interface Message {
  role: 'user' | 'model';
  parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: unknown } }>;
}

async function callGemini(messages: Message[], apiKey: string): Promise<{ text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; tokensUsed: number }> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: messages,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as any;
  const candidate = data.candidates?.[0];
  const tokensUsed = (data.usageMetadata?.totalTokenCount ?? 0) as number;

  const text = candidate?.content?.parts?.find((p: any) => p.text)?.text as string | undefined;
  const toolCalls = (candidate?.content?.parts ?? [])
    .filter((p: any) => p.functionCall)
    .map((p: any) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} }));

  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, tokensUsed };
}

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
  const apiKey = process.env.GEMINI_API_KEY ?? GEMINI_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

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

  const onFragment = async (frag: { id: string; text: string; source: string; doi: string | null; confidence: number; title?: string }) => {
    await store.save({
      id: frag.id, text: frag.text, source: frag.source,
      doi: frag.doi, confidence: frag.confidence, title: frag.title,
      extracted_at: new Date().toISOString(), node_id: store.nodeId,
    });
    await fetch(`${effectiveEmbedderUrl}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: frag.id, text: frag.text, metadata: { source: frag.source, doi: frag.doi, doi_valid: frag.doi !== null, confidence: frag.confidence, title: frag.title, node_id: store.nodeId } }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    budget.recordFragments(1);
    fragmentsIndexed++;
    console.log(`  [+] Indexed: ${frag.id} | ${frag.source} | conf:${frag.confidence}`);
    onIndexed?.({ id: frag.id, title: frag.title, source: frag.source });
  };

  const messages: Message[] = [
    { role: 'user', parts: [{ text: `Research objective: ${objective}\n\nStart extracting knowledge now. Remember to call finish() when done.` }] },
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
      response = await callGemini(messages, apiKey);
    } catch (e: any) {
      console.error(`[gemini] Error: ${e.message}`);
      break;
    }
    budget.recordTokens(response.tokensUsed);

    // Add model response to history
    const modelParts: Message['parts'] = [];
    if (response.text) modelParts.push({ text: response.text });
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        modelParts.push({ functionCall: { name: tc.name, args: tc.args } });
      }
    }
    if (modelParts.length) messages.push({ role: 'model', parts: modelParts });

    if (!response.toolCalls?.length) {
      // Model responded with text only — finished naturally
      finalSummary = response.text ?? 'Session complete.';
      console.log(`\n[agent] ${finalSummary}`);
      break;
    }

    // Execute each tool call
    const toolResultParts: Message['parts'] = [];
    for (const tc of response.toolCalls) {
      console.log(`  [tool] ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)})`);

      if (tc.name === 'arxiv_search') budget.recordArxivCall();
      if (tc.name === 'web_fetch') budget.recordWebFetch();

      if (tc.name === 'finish') {
        finalSummary = tc.args.summary as string;
        console.log(`\n[agent] Done: ${finalSummary}`);
        await store.close();
        return { fragmentsIndexed, summary: finalSummary, budget: budget.summary() };
      }

      const result = await executeTool(tc.name, tc.args, { embedderUrl: EMBEDDER_URL, onFragment });
      toolResultParts.push({ functionResponse: { name: tc.name, response: result } });
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
