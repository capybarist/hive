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
  hasRelevantData: boolean,
): Promise<LLMResponse> {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const mode: LLMMode = hasRelevantData ? 'verified' : 'hybrid';

  // Only send relevant fragments to the LLM — low-score noise fragments are shown
  // in the UI for transparency but excluded from the LLM prompt
  const userPrompt = hasRelevantData
    ? buildPrompt(question, fragments)
    : `No verified H.I.V.E fragments were found for this question. You MUST still answer using your general knowledge, but you MUST start your response with: "⚠ Not verified by H.I.V.E — answering from general knowledge:"\n\nQUESTION: ${question}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
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
