# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is called a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

## Current state: v0.2 — HTTP sync working, native Hypercore replication WIP

All modules implemented:
- **Module 1**: Local embeddings (all-MiniLM-L6-v2, ~80MB CPU) + HNSW index
- **Module 2**: Reactive extractor (arXiv API + CrossRef DOI validation + RSS)
- **Module 3**: KnowledgeStore on Hypercore + Hyperbee (SESSION_CLOSED fixed)
- **Module 4**: P2P network — Hyperswarm discovery + HTTP sync fallback (see Known Issues)
- **Module 5**: Vector query API (Fastify)
- **Module 6**: Web UI with LLM synthesis (Gemini / Claude / OpenAI / Groq)
- **Module 7**: Autonomous extractor + topic tree + claim registry + aggregator node

## ⚠️ Architecture decision: HTTP sync as current transport

**The goal is native Hypercore block replication.** Hypercore is the source of truth and the reason HIVE uses this stack — it provides append-only, cryptographically verifiable, P2P-native storage. The data IS stored in Hypercore on every node.

**Current reality:** Native Corestore block replication between nodes is not yet working. Root cause identified but not fully resolved: `Hypercore.createProtocolStream()` creates its own Protomux internally, conflicting with our custom key-exchange channel. Additionally, `_shouldReplicate()` in Corestore requires `core.replicator.downloading === true`, which requires explicit `core.download()` calls. Both fixes are in place but block delivery is still not confirmed in production.

**What works today:** HTTP sync via `SyncManager`. Every node (BEE and aggregator) pulls fragments from peers via `GET /api/fragments`. Peer discovery is decentralized — when two nodes connect via Hyperswarm, they exchange their HTTP API URLs through the existing Protomux channel (`hive/core-keys/v1`, message index 1). No hardcoded URLs.

**Path forward:** Fix native Hypercore replication. When it works, SyncManager becomes redundant but harmless. See `test_replication.ts` for the test that must pass.

## How data flows between BEEs (current: HTTP sync)

```
BEE-A extracts a fragment
  → saves to its local Hypercore (append-only, signed) + HNSW embedder
  → Hyperswarm connects BEE-A and BEE-B on the HIVE topic
  → Protomux channel (hive/core-keys/v1):
      msg[0] = 32-byte core public key (for future native replication)
      msg[1] = HTTP API URL of sender  (for current HTTP sync)
  → BEE-B receives BEE-A's HTTP URL → adds to SyncManager
  → SyncManager pulls GET /api/fragments from BEE-A every 8s
  → new fragments → POST /add to BEE-B's embedder → HNSW updated

When native Hypercore replication works, the flow will be:
  → BEE-B opens BEE-A's core read-only via core key
  → Corestore replication delivers blocks
  → watchRemoteCore() drives live Hyperbee history stream → HNSW updated
```
```

**HNSW is a derived index, not a separate store.** It is always reconstructable from Hypercore.
On startup, `watchFragments()` replays the full Hyperbee history and rebuilds HNSW locally.
On peer connect, `watchRemoteCore()` watches the peer's replicated core and keeps HNSW in sync.

## File structure

```
hive/
├── hive.sh              ← production launcher (zero-config, single BEE)
├── start.sh             ← dev launcher (multiple BEEs from bees/*.env)
├── bees/                ← dev configs: bee-1.env, bee-2.env, bee-3.env
├── data/
│   ├── topic_tree.json  ← 95-topic knowledge taxonomy (only committed file here)
│   └── bee-*/           ← runtime data: corestore/, vectors/, identity/ (gitignored)
├── packages/
│   ├── core/src/
│   │   ├── knowledge_store.ts   ← KnowledgeStore (Hypercore + Hyperbee)
│   │   │                           key methods: save(), watchFragments(), watchRemoteCore()
│   │   │                           coreKey getter exposes public key for peer exchange
│   │   ├── p2p_node.ts          ← Hyperswarm + Protomux core-key exchange + replication
│   │   ├── claim_registry.ts    ← P2P registry: which BEE covers which topic
│   │   ├── topic_assignment.ts  ← assigns topic tree leaves to BEEs
│   │   ├── sync_manager.ts      ← HTTP fallback for UDP-blocked environments; active in Codespaces
│   │   └── node_identity.ts     ← ed25519 identity per BEE
│   ├── agent/src/
│   │   ├── autonomous_extractor.ts ← Gemini agent with tools (main extractor)
│   │   ├── reactive_extractor.ts   ← manual topic-list extractor (fallback/test)
│   │   ├── objective_discovery.ts  ← auto-assigns topics by scanning the network
│   │   ├── tools_registry.ts       ← tools: arxiv_search, rss_fetch, web_fetch...
│   │   └── budget_controller.ts    ← token/fragment/time limits
│   ├── embeddings/
│   │   └── api_server.py        ← FastAPI Python :7700, HNSW + sentence-transformers
│   ├── api/src/
│   │   └── api_server.ts        ← Fastify :8080, all endpoints + extraction loop
│   └── ui/
│       └── index.html           ← vanilla JS UI, dark theme
├── scripts/
│   └── verify_store.ts          ← KnowledgeStore diagnostic tool
└── packages/core/src/
    ├── test_v03.ts              ← SESSION_CLOSED fix tests (4 scenarios)
    └── test_replication.ts      ← P2P replication tests (3 phases, direct pipes)
```

## How to run

```bash
# Production (single BEE, zero-config):
bash hive.sh

# Dev (3 BEEs on the same machine):
bash start.sh                    # starts bee-1, bee-2, bee-3
bash start.sh bee-1 bee-2        # specific BEEs only
bash start.sh --clean            # wipe data and restart
```

**Key environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | LLM provider: `gemini`, `claude`, or `openai` |
| `LLM_API_KEY` | — | Required. API key for the chosen provider |
| `LLM_MODEL` | — | Optional model override (e.g. `gpt-4o-mini`) |
| `HIVE_PORT` | 8080 | API server port |
| `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
| `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory |
| `BEE_PEER` | — | Bootstrap peer HTTP URL (for claim discovery only, not data sync) |
| `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
| `HIVE_OBJECTIVE` | — | Explicit objective (overrides auto-discovery) |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | 20 | Fragments per extraction cycle |
| `HIVE_EXTRACT_INTERVAL_MS` | 300000 | Cycle interval (5 min) |

Note: `BEE_PEER` drives both HTTP claim discovery and data sync fallback.
Hypercore replication is primary (when Hyperswarm DHT is available).

## Topic auto-discovery flow

1. BEE starts with no `HIVE_OBJECTIVE`
2. Reads `data/topic_tree.json` (95 leaf topics, 9 domains)
3. Calls `/api/claims` on peers to see what is already covered
4. Scores leaves: unclaimed=100, covered by 1=50, already mine=10; +200 if matches `BEE_TOPIC_DOMAIN`
5. Claims top-N leaves with random jitter (reduces simultaneous-start races)
6. Extraction cycle every 5 min, ~maxFragments/numTopics fragments per topic
7. Renews claims (TTL 30 min) to maintain coverage territory

## Dev BEE ports

| BEE | API | Embedder | Notes |
|-----|-----|----------|-------|
| bee-1 | 8080 | 7700 | Seed (no peer) |
| bee-2 | 8081 | 7701 | Peers with bee-1 |
| bee-3 | 8082 | 7702 | Peers with bee-1, `BEE_TOPIC_DOMAIN=current_events` |

**Codespace URLs:**
```
https://vigilant-space-orbit-xrwvjw5v6r6q3pqr7-8080.app.github.dev
https://vigilant-space-orbit-xrwvjw5v6r6q3pqr7-8081.app.github.dev
https://vigilant-space-orbit-xrwvjw5v6r6q3pqr7-8082.app.github.dev
```

## Key design decisions

- **Hypercore over GenosDB**: open source, Holepunch ecosystem, production-proven (Pear, Keet)
- **No agent framework**: own TypeScript extractor + Gemini function calling — cleaner, auditable
- **Topic-centric, not source-centric**: LLM decides sources per topic at runtime
- **Append-only storage**: Hypercore never deletes; corrections use supersedes links
- **HNSW as derived index**: driven by Hypercore history stream, not a parallel store.
  Hypercore = source of truth. HNSW = local search index, always rebuildable from Hypercore.
- **Hypercore as source of truth**: append-only, ed25519-signed, P2P-native. Data lives here regardless of sync transport.
- **HNSW as derived index**: always rebuildable from Hypercore history on startup.
- **HTTP sync as transport (temporary)**: SyncManager pulls `/api/fragments` from peers discovered via P2P. Decentralized — HTTP URLs are exchanged via the existing Protomux channel, no hardcoded addresses.
- **Native Hypercore replication (goal)**: when working, replaces HTTP sync. Code is in place (`watchRemoteCore`, `core.download()`) but block delivery not yet confirmed. See Known Issues.
- **Multi-provider LLM**: Gemini, Claude, OpenAI, or Groq — set via `LLM_PROVIDER` + `LLM_API_KEY`
- **Groq default model**: `llama-3.3-70b-versatile` (128K context). Free tier: 100K tokens/day, 6K TPM.

## Known issues & TODO

| Issue | Impact | Status |
|-------|--------|--------|
| SESSION_CLOSED on writes | Hypercore write fails | **Fixed** — ensureOpen() + write queue |
| Native Hypercore block replication | Blocks don't flow between nodes | **Fixed** — root cause was `b.put()` not awaited in KnowledgeStore (Hyperbee v2 batch.put() is async). Hypercore was always empty. All 3 test phases pass. |
| HTTP sync as fallback | Works but not P2P-native | **Kept as fallback** — decentralized URL discovery via Protomux msg. Remove when confident Hypercore replication is stable in production. |
| Fragment TTL + cross-cycle dedup | Stale content stays forever; same article re-indexed wasting tokens | **Fixed** — `onFragment` checks Hypercore before saving. Skip if fresh (wiki 7d, rss 24h, arxiv 30d, web 3d). Supersede if stale. |
| `supersede()` not wired | KnowledgeStore had supersede() but nothing called it | **Fixed** — extractor calls supersede() for stale content; also fixed missing `await b.put()` in supersede batch. |
| Qdrant `_shouldReplicate` / `search()` API | qdrant-client v1.12+ removed `search()`, replaced with `query_points()` | **Fixed** — qdrant_index.py updated |
| `doi: "null"` string bug | Fragments stored with string "null" instead of JSON null | **Fixed** — tools_registry.ts sanitizes doi; only stores real DOIs starting with "10." |
| LLM uses arXiv ID format for non-arXiv content | Fragment IDs like `rock_history_c0` for Wikipedia content | **Fixed** — system prompt now specifies `wiki_*`, `rss_*`, `web_*` prefixes per source type |
| No replication factor enforcement | Fragments may exist in < 3 BEEs | Planned for v0.4 |
| `BEE_TOPIC_DOMAIN` sometimes picks wrong domain | If preferred domain is fully claimed | Expected — falls back to next best |
| Hyperswarm DHT may be blocked in Codespaces | Peers on different machines can't connect | Same-machine works. Production VMs with open UDP work fine. |

## Running tests

```bash
# SESSION_CLOSED fix + write queue + P2P lifecycle
packages/core/node_modules/.bin/tsx packages/core/src/test_v03.ts

# Native Hypercore replication (3 phases: baseline, key exchange, live stream)
packages/core/node_modules/.bin/tsx packages/core/src/test_replication.ts
```

## GitHub

```
Repo   : https://github.com/capybarist/hive (private)
Default: main branch
Push   : requires GITHUB_TOKEN workaround (Codespace env conflict)
         TOKEN=$(GITHUB_TOKEN="" gh auth token)
         git remote set-url origin "https://capybarist:${TOKEN}@github.com/capybarist/hive.git"
         git push origin main
```

## Developer context

- Background: Java/enterprise (Windows Financial Services)
- Learning distributed systems and AI
- Project serves as both portfolio and real product
- Communicates in Spanish
- All code comments and logs must be in English
- `Bash(*)` is pre-approved in `.claude/settings.json`
