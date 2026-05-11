import type { SearchResult } from './query_engine.js';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

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
  // Fallback: parse source string like "arXiv:2605.05576v1"
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
  apiKey: string,
  hasRelevantData: boolean,
  history: Array<{role: string; content: string}> = [],
): Promise<LLMResponse> {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const mode: LLMMode = hasRelevantData ? 'verified' : 'hybrid';

  const userPrompt = hasRelevantData
    ? buildPrompt(question, fragments)
    : `No verified HIVE fragments were found for this question. Answer from your general knowledge, starting with: "⚠ Not verified by HIVE — answering from general knowledge:"\n\nQUESTION: ${question}`;

  // Build multi-turn conversation contents
  const contents: Array<{role: string; parts: Array<{text: string}>}> = [
    // Seed with a brief context-setting exchange so Gemini knows the conversation style
    ...history.map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: userPrompt }] },
  ];

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.5, maxOutputTokens: 8192 },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no response)';

  return { answer, mode };
}
