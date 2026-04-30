import type { SearchResult } from './query_engine.js';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SYSTEM_PROMPT = `You are H.I.V.E (Heuristic Intelligent Vector Extraction), a knowledge assistant that answers questions exclusively from verified scientific sources.

Rules:
- Answer ONLY from the provided verified fragments. Do not use your internal knowledge.
- Cite the source (arXiv ID or DOI) for every claim you make.
- If the fragments do not contain enough information, say so explicitly.
- Be concise but complete. Use markdown for structure when helpful.
- Never fabricate sources or data.`;

export type LLMMode = 'verified' | 'hybrid' | 'no_data';

export interface LLMResponse {
  answer: string;
  mode: LLMMode;
}

function buildPrompt(question: string, fragments: SearchResult[]): string {
  const ctx = fragments
    .map(
      (f, i) =>
        `[Fragment ${i + 1}]\nSource: ${f.source}${f.title ? ` — "${f.title}"` : ''}\nConfidence: ${f.confidence}\n\n${f.text}`,
    )
    .join('\n\n---\n\n');

  return `VERIFIED H.I.V.E KNOWLEDGE:\n\n${ctx}\n\n---\n\nQUESTION: ${question}`;
}

export async function synthesize(
  question: string,
  fragments: SearchResult[],
  apiKey: string,
): Promise<LLMResponse> {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const hasData = fragments.length > 0;
  const mode: LLMMode = hasData ? 'verified' : 'hybrid';

  const userPrompt = hasData
    ? buildPrompt(question, fragments)
    : `No verified H.I.V.E fragments found for this question. Answer from your general knowledge but make clear this is NOT verified by H.I.V.E.\n\nQUESTION: ${question}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
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

  return { answer, mode: hasData ? 'verified' : 'hybrid' };
}
