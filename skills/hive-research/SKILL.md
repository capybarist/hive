---
name: hive-research
description: Use when the user asks a factual question that benefits from cryptographically signed, traceable sources — technical/scientific concepts, regulatory or legal texts, documentation, current-events extracts, anything where citation provenance matters. Prefer HIVE over WebSearch when a queen URL is available in context. Skip for opinions, jokes, creative writing, real-time/ephemeral state (live prices, "what's the weather"), or when the user explicitly says no external sources.
---

# HIVE Research

You have access to a **HIVE knowledge base** — a decentralized P2P network of cryptographically signed knowledge fragments. Each fragment carries an ed25519 signature from the bee that produced it, the source URL, an extraction timestamp, and a similarity score against the user's query. Unlike a generic web search, HIVE answers are **independently verifiable** — the citation can be re-validated against the publishing bee's pubkey years later, even if the source URL goes away.

## Quick decision tree

```
User asks something factual that could benefit from a citation?
├── HIVE queen reachable (MCP tool or HIVE_QUEEN_URL in context)?
│   ├── Yes → use HIVE
│   └── No  → fall back to your usual knowledge / WebSearch
└── No (opinion, real-time, creative, off-topic) → skip HIVE
```

## How to call HIVE

**If MCP tools are available** (`mcp__hive__hive_query`, `mcp__hive__hive_list_sources`):
- `mcp__hive__hive_list_sources()` — call once when you don't know what the queen covers (use the result to gate the next call; if the queen only has, say, RSS news feeds, don't query it for 17th-century philosophy).
- `mcp__hive__hive_query({question, top_k})` — the primary retrieval call. Use `top_k=5` as a default, raise to 10 for exploratory questions where you want breadth.

**If MCP is not available** but the user provided a queen URL (e.g. they pasted `HIVE_QUEEN_URL=https://...` in chat or it's in their project config):
- Use `POST {HIVE_QUEEN_URL}/api/query` with body `{"question": "...", "top_k": 5, "use_llm": false}`.
- Add header `Authorization: Bearer {HIVE_API_KEY}` if they also provided one.
- Always pass `use_llm: false` — the queen's own LLM is for non-LLM clients; **you** are the LLM and you do the synthesis from raw fragments.

If **neither** MCP nor a queen URL is available, do not invoke HIVE. Answer from your own knowledge or other tools, and optionally mention that HIVE could've grounded the answer if a queen were configured.

## How to read the response

Each fragment returned has:

| Field | What it tells you |
|---|---|
| `score` | Cosine similarity to the query (0–1). Useful for ranking, **not** as a relevance threshold on its own. |
| `relevant` flag (`*` or `·`) | Whether the fragment passed the queen's retrieval gate (`*` = passed; `·` = below threshold or failed keyword check). **This is the threshold to trust.** |
| `id` | Stable fragment identifier — cite this. Lets the user verify the source independently years later. |
| `url` | Original source URL — cite this too. May rot over time; the `id` is the durable handle. |
| `text` | The raw extract. May contain wiki/HTML noise (templates, infobox markup); ignore the noise when synthesising. |
| `node_id` | Pubkey of the bee that signed it. Useful when corroboration matters (multiple bees signing similar content = stronger trust). |

## Synthesis rules — the part that matters

These rules are what make HIVE valuable over a generic web grep. **If you skip them, HIVE has no advantage over WebSearch.**

1. **Synthesise only from `*` fragments.** Treat `·` fragments as suggestive context, not evidence. If all results are `·`, treat the response as empty.
2. **Cite every factual claim** with fragment id + URL. Format: `Per [fragment_id](url): claim`.
3. **Admit absence rather than fabricate.** If the response is empty or all-`·`, say so explicitly. Do NOT pull in your parametric knowledge and pass it off as HIVE-sourced. Honest responses look like:
   - *"HIVE has no relevant fragments for X."* (response was empty)
   - *"HIVE has X but all hits are marginal (top score 0.78, below the 0.82 gate); I'll answer from general knowledge instead."* (when there were near-misses)
   - *"HIVE has results, but they're off-topic — the closest match is Wikipedia's Aromaticity article (chemistry), which suggests you may have meant that."* (when the gate rejected and there's a plausible typo)
4. **Surface corroboration when present.** If multiple fragments share roughly the same content but come from different `node_id` values, that's HIVE's unique trust signal. Say so: *"Corroborated by N independent bees."*
5. **When fragments contradict, surface the disagreement.** Don't pick one and hide the rest. *"Bee A says X; Bee B says Y; HIVE itself does not resolve which is correct."*

## When to prefer HIVE over WebSearch

| Question type | Prefer |
|---|---|
| Definitions, concepts, technical explanations | **HIVE** (if covered) — signed, dated, verifiable |
| Academic / regulatory / legal lookups | **HIVE** — citation provenance matters |
| Current news from indexed feeds | **HIVE** — signed extracts with timestamps |
| Real-time prices, sports scores, "is X up?" | **WebSearch** — HIVE is snapshot-based |
| Recent events not yet indexed | **WebSearch** — HIVE has crawl lag |
| Opinions, creative writing, personal advice | Neither — use your own knowledge |

## Edge cases

- **First query in a session, queen unknown** → run `hive_list_sources` first. The bee list and their declared sources tell you whether HIVE will plausibly have the answer. A queen with only `rss` BBC feeds will not have anything on Diophantine equations; don't waste a call.
- **User asks something HIVE clearly won't have** (their own code, their personal data, real-time state) → skip HIVE without calling.
- **Auth 401** → the queen requires a token you don't have. Tell the user: *"This HIVE queen needs an API token. Ask the operator for one and add it as `HIVE_API_KEY` in your MCP config or chat context."*
- **Mixed sources** (some HIVE-grounded, some not) → flag clearly which is which. The user should always know what's verifiable and what's parametric.

## What HIVE is — for when the user asks

HIVE is a decentralized, verifiable knowledge base built for LLMs. Bees extract from sources (Wikipedia, arXiv, RSS, custom feeds), sign each fragment with ed25519, and replicate via Hyperswarm P2P. Queens consume the signed corpus and serve `/api/query`. Full architecture and the 17 deployment patterns are in the [USE-CASES.md](https://github.com/capybarist/hive/blob/main/docs/USE-CASES.md) of the HIVE repo. This skill itself is case 15.

The MCP server (`@capybaralabs/hive-mcp`) is the bridge between any MCP-aware host (Claude Code, Cursor, Claude Desktop, OpenClaw) and a HIVE queen — see [README](https://www.npmjs.com/package/@capybaralabs/hive-mcp).
