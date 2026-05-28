import { createLLMProvider } from '@hive/core';
import type { LLMMessage } from '@hive/core';

// v0.8 — the LLM only needs the rendering-relevant subset of a v0.8 hit.
// Kept shallow on purpose: api_server projects QueenSearchHit into this shape
// so this module doesn't take a dep on @hive/embeddings-node.
export interface RetrievedFragment {
  id: string;
  text: string;
  title?: string;
  url: string;
  source: string;            // adapter id (wikipedia-en, arxiv, …)
  source_type: string;
  lang: string;
  node_id: string;
  score: number;
  relevant: boolean;
}

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

You are the FINAL judge of whether the fragments actually answer the
question. Vector search is fuzzy — it often returns fragments that are
topically near but do not contain the answer (e.g. an article about the
city "Fano" for a question about the person "Guido Fanti"). Decide
honestly, because a badge shown to the user depends on your verdict:

- If the fragments genuinely contain the answer:
  - Use them as ground truth. Build a complete, well-organised answer.
    Synthesise across multiple fragments instead of dumping them one by
    one. Use bullets for genuine lists (three or more parallel items).

- If the fragments do NOT actually contain the answer (loosely related,
  off-target, or simply silent on the subject):
  - Your reply MUST begin with the exact token [[NO_MATCH]] on the very
    first line, with nothing before it.
  - After that token, answer from your general knowledge, prefixed with
    "⚠ Not verified by HIVE — answering from general knowledge:".
  - Do NOT enumerate the unrelated fragments — that's noise, not help.

Never fabricate facts, sources, or links.`;

// The sentinel the model emits when the provided fragments don't actually
// answer the question. Stripped before the answer reaches the client; its
// presence flips the "Verified by HIVE" badge off.
const NO_MATCH_SENTINEL = '[[NO_MATCH]]';

export type LLMMode = 'verified' | 'hybrid' | 'no_data';

export interface LLMResponse {
  answer: string;
  mode: LLMMode;
  // True only when the answer genuinely rests on HIVE fragments. The
  // caller uses this — NOT the retrieval gate alone — to decide whether
  // to show the "Verified by HIVE" badge and the source chips.
  grounded: boolean;
}

function sourceUrl(f: RetrievedFragment): string | null {
  // v0.8 — the per-fragment url is the canonical link. The adapter id
  // (wikipedia-en, arxiv, …) is the display label.
  return f.url || null;
}

function buildPrompt(question: string, fragments: RetrievedFragment[]): string {
  // v0.7.7.6 — widen the context. Was 4 fragments × 400 chars (~1.6k chars),
  // which starved the model and produced terse answers. 8 × 900 (~7k chars)
  // gives it enough verbatim material to write the depth the system prompt
  // asks for, while staying well within Groq/Gemini TPM on a single query.
  const ctx = fragments
    .slice(0, 8)
    .map((f, i) => {
      const url = sourceUrl(f);
      const sourceLabel = url ? `${f.source} → ${url}` : f.source;
      const text = f.text.slice(0, 900);
      return `[${i + 1}] ${f.title ?? ''} (${sourceLabel})\n${text}`;
    })
    .join('\n\n');

  return `HIVE KNOWLEDGE:\n${ctx}\n\nQUESTION: ${question}`;
}

export async function synthesize(
  question: string,
  fragments: RetrievedFragment[],
  hasRelevantData: boolean,
  history: Array<{role: string; content: string}> = [],
): Promise<LLMResponse> {
  const provider = createLLMProvider();

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

  const { text } = await provider.generate(messages, SYSTEM_PROMPT, { temperature: 0.5, maxTokens: 1800 });

  // When we never had fragments to begin with, it's a plain general-knowledge
  // answer — not grounded, no badge.
  if (!hasRelevantData) {
    return { answer: text, mode: 'hybrid', grounded: false };
  }

  // We sent fragments and asked the model to be the final judge. If it
  // emitted the NO_MATCH sentinel, the fragments didn't actually answer —
  // strip the token, drop to hybrid, and let the caller suppress the badge
  // and the (misleading) source chips.
  const trimmed = text.trimStart();
  if (trimmed.startsWith(NO_MATCH_SENTINEL)) {
    const answer = trimmed.slice(NO_MATCH_SENTINEL.length).trimStart();
    return { answer, mode: 'hybrid', grounded: false };
  }

  return { answer: text, mode: 'verified', grounded: true };
}
