import { createLLMProvider } from '@hive/core';
import type { LLMMessage } from '@hive/core';
import type { SearchResult } from './query_engine.js';

const SYSTEM_PROMPT = `You are HIVE (Heuristic Intelligent Vector Extraction), a knowledge assistant grounded in verified sources.

Rules:
- Base your answers primarily on the provided verified fragments.
- Cite sources as clickable markdown links, e.g. [Author et al. 2024](https://arxiv.org/abs/2312.00752). Each fragment includes a URL — use it.
- Give thorough, detailed answers — explain concepts, provide context, and expand on implications.
- Maintain conversational continuity: if the user asks follow-up questions, refer back to what was previously discussed.
- If fragments don't cover something fully, say so and offer what you can from context.
- Use markdown for structure (headers, bullet points, bold) when it improves clarity.
- Never fabricate sources or data.`;

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
    .map((f, i) => {
      const url = sourceUrl(f);
      const sourceLabel = url ? `${f.source} → ${url}` : f.source;
      return `[Fragment ${i + 1}]\nSource: ${sourceLabel}${f.title ? ` — "${f.title}"` : ''}\nConfidence: ${f.confidence}\n\n${f.text}`;
    })
    .join('\n\n---\n\n');

  return `VERIFIED HIVE KNOWLEDGE:\n\n${ctx}\n\n---\n\nQUESTION: ${question}`;
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
    ...history.map(h => ({
      role: (h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      parts: [{ type: 'text' as const, text: h.content }],
    })),
    { role: 'user', parts: [{ type: 'text', text: userPrompt }] },
  ];

  const { text } = await provider.generate(messages, SYSTEM_PROMPT, { temperature: 0.5, maxTokens: 8192 });
  return { answer: text, mode };
}
