# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is called a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

## Current state: v0.1 complete

All modules implemented:
- **Module 1**: Local embeddings (all-MiniLM-L6-v2, ~80MB CPU) + HNSW index
- **Module 2**: Reactive extractor (arXiv API + CrossRef DOI validation + RSS)
- **Module 3**: KnowledgeStore on Hypercore + Hyperbee + Autobase
- **Module 4**: P2P network (Hyperswarm peer discovery + HTTP sync between BEEs)
- **Module 5**: Vector query API (Fastify)
- **Module 6**: Web UI with Gemini synthesis
- **Module 7**: Autonomous extractor (Gemini function calling) + topic tree + claim registry

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
│   │   ├── knowledge_store.ts   ← KnowledgeStore (Autobase + Hyperbee)
│   │   ├── claim_registry.ts    ← P2P registry: which BEE covers which topic
│   │   ├── topic_assignment.ts  ← assigns topic tree leaves to BEEs
│   │   ├── p2p_node.ts          ← Hyperswarm P2P connectivity
│   │   ├── sync_manager.ts      ← HTTP-based fragment sync between BEEs
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
└── scripts/
    └── verify_store.ts          ← KnowledgeStore diagnostic tool
```

## How to run

```bash
# Production (single BEE, zero-config):
bash hive.sh

# Dev (3 BEEs on the same machine):
bash start.sh                    # starts bee-1, bee-2, bee-3
bash start.sh bee-1 bee-2        # specific BEEs only
```

**Key environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Required. Set in `.env` |
| `HIVE_PORT` | 8080 | API server port |
| `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
| `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory |
| `HIVE_BOOTSTRAP` / `BEE_PEER` | — | Known peer URL to bootstrap from |
| `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
| `HIVE_OBJECTIVE` | — | Explicit objective (overrides auto-discovery) |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | 20 | Fragments per extraction cycle |
| `HIVE_EXTRACT_INTERVAL_MS` | 300000 | Cycle interval (5 min) |

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
- **HTTP sync (not pure Hypercore)**: SyncManager polls `/api/fragments` every 8s — simpler for v0.1
- **Gemini 2.5 Flash**: used for both synthesis (UI) and autonomous extraction

## Known issues

| Issue | Impact | Mitigation |
|-------|--------|------------|
| `Autobase is closing` on concurrent writes | Hypercore save fails | Write queue in `knowledge_store.ts`; Hypercore save is non-fatal; HNSW always succeeds |
| HTTP sync is not pure P2P | Requires peer's API to be reachable | Native Hypercore replication stream planned for v0.2 |
| No replication factor enforcement | Fragments may exist in < 3 BEEs | Planned for v0.2 |
| `BEE_TOPIC_DOMAIN` sometimes picks wrong domain | If preferred domain is fully claimed | Expected — falls back to next best available |

## GitHub

```
Repo   : https://github.com/capybarist/hive (private)
Default: main branch
Push   : requires GITHUB_TOKEN workaround (Codespace env conflict)
         TOKEN=$(GITHUB_TOKEN="" gh auth token)
         git remote set-url origin "https://capybarist:${TOKEN}@github.com/capybarist/hive.git"
```

## Developer context

- Background: Java/enterprise (Windows Financial Services)
- Learning distributed systems and AI
- Project serves as both portfolio and real product
- Communicates in Spanish
- All code comments and logs must be in English
- `Bash(*)` is pre-approved in `.claude/settings.json`
