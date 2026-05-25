import { createLLMProvider } from '@hive/core';
import type { LLMMessage } from '@hive/core';
import type { SearchResult } from './query_engine.js';

// v0.7.2.5 — system prompt rewritten for conciser, more natural answers.
// The previous prompt asked the model to "cite sources as clickable markdown
// links" inline, which produced wall-of-text answers full of bracketed URLs
// every other sentence. The UI already renders each source as a clickable
// chip beneath the answer (and any inline [text](url) the LLM emits is
// rendered as a real anchor since UI v0.7.2.5), so inline citations are
// redundant noise in most answers.
//
// The other change is the "no relevant data" path: the model used to fill
// the answer with an exhaustive list of unrelated content it DID have
// ("here are the China highways I do know about: 109, 110, 211, …"). That
// is more confusing than helpful. The instruction is now to say so briefly
// and stop.
const SYSTEM_PROMPT = `You are HIVE, a knowledge assistant grounded in verified fragments from a decentralized P2P network.

Voice:
- Answer in natural prose. Be direct.
- Do not narrate the retrieval: never say "based on the provided fragments",
  "the fragment mentions", "according to source X", "here is what I have", etc.
  The user can see the sources separately under your answer.
- Do not embed inline citations or raw URLs unless they make the answer
  meaningfully better. The UI shows source chips and renders any [text](url)
  you emit as a clickable link, but those should be used sparingly — only
  when naming a specific entity that genuinely benefits from a link.

When the fragments answer the question:
- Use them as ground truth.
- Add helpful context and explanation; don't just regurgitate sentences.
- Use bullets only for genuine lists (three or more parallel items), not
  for every short answer.

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
