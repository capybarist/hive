# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is called a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

## Current state: v0.3 — native P2P replication

All modules implemented and working:
- **Module 1**: Local embeddings (all-MiniLM-L6-v2, ~80MB CPU) + HNSW index
- **Module 2**: Reactive extractor (arXiv API + CrossRef DOI validation + RSS)
- **Module 3**: KnowledgeStore on Hypercore + Hyperbee (SESSION_CLOSED fixed)
- **Module 4**: P2P network — Hyperswarm discovery + native Hypercore replication with core-key exchange
- **Module 5**: Vector query API (Fastify)
- **Module 6**: Web UI with Gemini synthesis
- **Module 7**: Autonomous extractor (Gemini function calling) + topic tree + claim registry

## How data flows between BEEs (P2P architecture)

```
BEE-A extracts a fragment
  → saves to its local Hypercore (append-only, signed)
  → Hyperswarm connects BEE-A and BEE-B on the HIVE topic
  → Protomux channel (hive/core-keys/v1) exchanges 32-byte core public keys
  → BEE-B opens BEE-A's core read-only in its own Corestore
  → Corestore replication stream delivers the blocks
  → watchRemoteCore() detects new frag:* entries via live Hyperbee history stream
  → POST /add to BEE-B's local embedder → HNSW updated
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
│   │   ├── sync_manager.ts      ← DEPRECATED: was HTTP polling, replaced by Hypercore replication
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
| `GEMINI_API_KEY` | — | Required. Set in `.env` |
| `HIVE_PORT` | 8080 | API server port |
| `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
| `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory |
| `BEE_PEER` | — | Bootstrap peer HTTP URL (for claim discovery only, not data sync) |
| `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
| `HIVE_OBJECTIVE` | — | Explicit objective (overrides auto-discovery) |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | 20 | Fragments per extraction cycle |
| `HIVE_EXTRACT_INTERVAL_MS` | 300000 | Cycle interval (5 min) |

Note: `BEE_PEER` is now used only for claim-registry HTTP calls (topic coordination).
Data sync is fully Hypercore-native — no HTTP sync needed.

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
https://fantastic-orbit-4q7wx7jw4j45275r5-8080.app.github.dev
https://fantastic-orbit-4q7wx7jw4j45275r5-8081.app.github.dev
https://fantastic-orbit-4q7wx7jw4j45275r5-8082.app.github.dev
```

## Key design decisions

- **Hypercore over GenosDB**: open source, Holepunch ecosystem, production-proven (Pear, Keet)
- **No agent framework**: own TypeScript extractor + Gemini function calling — cleaner, auditable
- **Topic-centric, not source-centric**: LLM decides sources per topic at runtime
- **Append-only storage**: Hypercore never deletes; corrections use supersedes links
- **HNSW as derived index**: driven by Hypercore history stream, not a parallel store.
  Hypercore = source of truth. HNSW = local search index, always rebuildable from Hypercore.
- **Native Hypercore replication**: Protomux channel exchanges core public keys on connect;
  each BEE opens peer's core read-only; Corestore replication delivers blocks automatically.
- **Gemini 2.5 Flash**: used for both synthesis (UI) and autonomous extraction

## Known issues

| Issue | Impact | Status |
|-------|--------|--------|
| SESSION_CLOSED on writes | Hypercore write fails | **Fixed** — ensureOpen() + write queue + per-connection Corestore session |
| HTTP sync inconsistency between nodes | Different nodes returned different results | **Fixed** — replaced with Hypercore-native replication |
| No replication factor enforcement | Fragments may exist in < 3 BEEs | Planned for v0.4 |
| `BEE_TOPIC_DOMAIN` sometimes picks wrong domain | If preferred domain is fully claimed | Expected — falls back to next best available |
| Hyperswarm DHT may be blocked in Codespaces | Peers on different machines can't connect | Only affects cross-machine; same-machine works. Production VMs with open UDP work fine. |

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
