import { createLLMProvider } from '@hive/core';
import type { LLMMessage } from '@hive/core';
import type { SearchResult } from './query_engine.js';

// v0.7.6.2 — system prompt tuned for *depth* without losing the v0.7.2.5
// improvements. The v0.7.2.5 rewrite stopped the verbose "the fragment
// mentions X" / "based on the provided fragments…" narration and dropped
// inline-link spam, both of which were real wins. But "Answer in natural
// prose. Be direct." over-corrected: the model started shipping
// four-line answers for queries with five solid fragments of supporting
// material. This version keeps the no-meta-narration + sparing-citations
// rules and explicitly invites depth + context when the fragments
// support it.
const SYSTEM_PROMPT = `You are HIVE, a knowledge assistant grounded in verified fragments from a decentralized P2P network.

Voice:
- Write detailed, thorough answers. Explain concepts in depth, add context,
  give examples, and expand on implications. Don't write four lines when
  the fragments support twenty — the user came here for grounded depth,
  not a one-paragraph summary they could get from any chatbot.
- Do not narrate the retrieval: never say "based on the provided fragments",
  "the fragment mentions", "according to source X", "here is what I have",
  etc. The user can see the sources separately under your answer.
- Markdown structure (bold, bullets, occasional headers) is fine when it
  improves clarity; not required for short answers.
- Inline citations [text](url) only when naming a specific entity that
  genuinely benefits from a link — the UI shows source chips separately,
  so don't reach for citations every sentence.

When the fragments answer the question:
- Use them as ground truth.
- Build a complete, well-organised answer. Synthesise across multiple
  fragments instead of dumping them one by one.
- Use bullets for genuine lists (three or more parallel items), not for
  every short answer.

When the fragments do NOT answer the question:
- Say so in one or two short sentences. Do not enumerate unrelated content
  that happens to be in the fragments — that's noise, not help.
- If you can offer general (non-verified) knowledge, do so briefly under a
  clear caveat, then stop.

Never fabricate facts, sources, or links.`;

export type LLMMode = 'verified' | 'hybrid' | 'no_data';

export interface LLMResponse {
  answer: string;
  mode: LLMMode;
}

function sourceUrl(f: SearchResult): string | null {
  if (f.arxiv_id) return `https://arxiv.org/abs/${f.arxiv_id}`;
  const m = f.source?.match(/arXiv:(\S+)/i);
  if (m) return `https://arxiv.org/abs/${m[1]}`;
  if (f.doi) return `https://doi.org/${f.doi}`;
  return null;
}

function buildPrompt(question: string, fragments: SearchResult[]): string {
  const ctx = fragments
    .slice(0, 4)
    .map((f, i) => {
      const url = sourceUrl(f);
      const sourceLabel = url ? `${f.source} → ${url}` : f.source;
      const text = f.text.slice(0, 400);
      return `[${i + 1}] ${f.title ?? ''} (${sourceLabel})\n${text}`;
    })
    .join('\n\n');

  return `HIVE KNOWLEDGE:\n${ctx}\n\nQUESTION: ${question}`;
}

export async function synthesize(
  question: string,
  fragments: SearchResult[],
  _apiKey: string,
  hasRelevantData: boolean,
  history: Array<{role: string; content: string}> = [],
): Promise<LLMResponse> {
  const provider = createLLMProvider();
  const mode: LLMMode = hasRelevantData ? 'verified' : 'hybrid';

  const userPrompt = hasRelevantData
    ? buildPrompt(question, fragments)
    : `No verified HIVE fragments were found for this question. Answer from your general knowledge, starting with: "⚠ Not verified by HIVE — answering from general knowledge:"\n\nQUESTION: ${question}`;

  const messages: LLMMessage[] = [
    // Keep only last 2 turns of history to stay within TPM limits
    ...history.slice(-4).map(h => ({
      role: (h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      parts: [{ type: 'text' as const, text: h.content.slice(0, 600) }],
    })),
    { role: 'user', parts: [{ type: 'text', text: userPrompt }] },
  ];

  const { text } = await provider.generate(messages, SYSTEM_PROMPT, { temperature: 0.5, maxTokens: 1024 });
  return { answer: text, mode };
}
