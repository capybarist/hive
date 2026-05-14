# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

## Current state: v0.5 — Ollama local LLM + light theme UI

All 7 modules complete. Native P2P replication fixed in v0.4. Ollama provider added in v0.5.

| Module | Description | Status |
|--------|-------------|--------|
| 1 | Embeddings + HNSW (all-MiniLM-L6-v2, 80MB CPU) | ✅ |
| 2 | Extractor: arXiv + RSS + web (Wikipedia-first prompt) | ✅ |
| 3 | KnowledgeStore — Hypercore + Hyperbee, ed25519-signed | ✅ |
| 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed v0.4 |
| 5 | Vector query API (Fastify) + federated queries | ✅ |
| 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI / Ollama) | ✅ |
| 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
| — | Aggregator node + Qdrant backend | ✅ added v0.4 |
| — | Ollama local LLM provider + light theme UI | ✅ added v0.5 |

**NOT in spec that we have:**
- Aggregator node (not in original spec)
- Multi-provider LLM: Groq, Gemini, Claude, OpenAI, **Ollama (local)**
- TTL + supersede wired in extractor
- Light theme UI (was dark)

**In spec but NOT yet implemented:**
- `Autobase` multi-writer (decision: abandoned — single-writer per BEE is simpler and correct for HIVE's model)
- `IConsensus` — multi-agent fragment quality voting (v0.6)
- Signature verification on receive (fragments signed but not verified on receipt) — v0.5
- Factor de replicación ≥ 3 (v0.5)
- Semantic routing / VecDHT (v0.6)
- Token economics (v0.7+)

## How data flows

```
BEE-A extracts a fragment
  → saves to local Hypercore (append-only, ed25519-signed) + HNSW embedder
  → Hyperswarm connects BEE-A and BEE-B on HIVE topic
  → Protomux channel (hive/meta/v1, msg[0]): exchanges HTTP API URLs
  → HTTP GET /api/status: peer's Hypercore public key
  → store.get({key}) + core.download({start:0,end:-1})
      → Corestore streamTracker.attachAll() → native replication active
  → watchRemoteCore(): live Hyperbee history stream → HNSW updated
  → SyncManager: HTTP pull from /api/fragments every 8s (fallback)

Before indexing any fragment:
  → store.get(id) — check Hypercore for existing fragment
  → Fresh (within TTL): skip — save LLM tokens
  → Stale (past TTL): supersede() — marks old, indexes new
  → New: save() + embedder /add
```

**TTL by source:** wiki 7 days · rss 24h · arXiv 30 days · web 3 days

**HNSW is a derived index**, always reconstructable from Hypercore history.

## Autobase decision

The original spec calls for Autobase (multi-writer linealisation). This was removed in v0.2.1 due to `Autobase is closing` concurrent write errors. The current model — each BEE has its own single-writer Hypercore, peers open it read-only — is actually a better fit for HIVE's architecture (each BEE is the sole authority on its own knowledge). Autobase is not planned for reinstatement.

## File structure

```
hive/
├── hive.sh              ← production launcher (zero-config, single BEE)
├── start.sh             ← dev launcher (multiple BEEs from bees/*.env)
├── aggregator.sh        ← aggregator node launcher (starts Qdrant via Docker)
├── stop.sh              ← kills all processes by port
├── bees/                ← dev configs: bee-1.env, bee-2.env, bee-3.env
├── data/
│   ├── topic_tree.json  ← 95-topic knowledge taxonomy (committed)
│   └── bee-*/           ← runtime data (gitignored)
├── packages/
│   ├── core/src/
│   │   ├── knowledge_store.ts   ← KnowledgeStore: save/get/supersede/watchFragments/watchRemoteCore
│   │   ├── p2p_node.ts          ← Hyperswarm + Protomux URL exchange + store.replicate()
│   │   ├── sync_manager.ts      ← HTTP sync fallback (8s interval)
│   │   ├── claim_registry.ts    ← topic claim coordination via HTTP
│   │   ├── topic_assignment.ts  ← assigns topic tree leaves to BEEs
│   │   └── node_identity.ts     ← ed25519 identity per BEE
│   ├── agent/src/
│   │   ├── autonomous_extractor.ts ← LLM agent + dedup/TTL/supersede logic
│   │   ├── tools_registry.ts       ← arxiv_search, rss_fetch, web_fetch, index_fragment
│   │   └── budget_controller.ts    ← token/fragment/time limits per cycle
│   ├── embeddings/
│   │   ├── api_server.py        ← FastAPI :7700, HNSW + Qdrant backends
│   │   └── qdrant_index.py      ← Qdrant client (aggregator backend)
│   ├── api/src/
│   │   ├── api_server.ts        ← Fastify :8080, all endpoints + extraction loop
│   │   └── llm_client.ts        ← LLM synthesis for /api/query
│   └── ui/
│       └── index.html           ← vanilla JS UI, dark theme
└── packages/core/src/
    └── test_replication.ts      ← P2P replication tests (3 phases) — ALL PASS
```

## How to run

```bash
# Production (single BEE):
bash hive.sh

# Dev (3 BEEs):
bash start.sh
bash start.sh --clean        # wipe data and restart
bash stop.sh --force         # kill all processes

# Aggregator (starts Qdrant via Docker automatically):
bash aggregator.sh
```

**Key environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | `gemini` · `claude` · `openai` · `groq` · `ollama` |
| `LLM_API_KEY` | — | Required for cloud providers. Not needed for `ollama`. |
| `LLM_MODEL` | — | Optional override (e.g. `qwen2.5:1.5b` for Ollama on low RAM) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL. In Docker: `http://ollama:11434` |
| `HIVE_PORT` | 8080 | API server port |
| `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
| `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory |
| `BEE_PEER` | — | Bootstrap peer HTTP URL |
| `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | 20 | Fragments per extraction cycle |
| `HIVE_EXTRACT_INTERVAL_MS` | 300000 | Cycle interval (5 min) |

**LLM architecture note:** HIVE uses ONE `LLM_PROVIDER` for both extraction (autonomous agent, tool calls) and query synthesis (RAG answers). The embeddings model (all-MiniLM-L6-v2) is separate and always runs locally via Python — it was never a cloud LLM.

**Ollama setup (Docker):**
```bash
# Start with Ollama profile
docker compose --profile ollama up -d

# Pull model once (persists in ollama-data volume)
docker exec hive-ollama ollama pull qwen2.5:3b

# In .env:
# LLM_PROVIDER=ollama
# OLLAMA_URL=http://ollama:11434  (already the default in docker-compose.yml)
```
RAM guidance: `qwen2.5:3b` ~1.9GB (recommended for 4GB VPS). Use `qwen2.5:1.5b` ~950MB for tighter RAM.

## Dev BEE ports

| BEE | API | Embedder | Notes |
|-----|-----|----------|-------|
| bee-1 | 8080 | 7700 | Seed — no peer |
| bee-2 | 8081 | 7701 | Peers with bee-1 |
| bee-3 | 8082 | 7702 | Peers with bee-1, `BEE_TOPIC_DOMAIN=current_events` |
| aggregator | 8090 | 7790 | Read-only, Qdrant backend |

## Key design decisions

- **Hypercore as source of truth**: append-only, ed25519-signed. Data lives here regardless of sync transport.
- **Single-writer per BEE**: each BEE owns its Hypercore. Peers open it read-only. No Autobase.
- **HNSW/Qdrant as derived index**: always rebuildable from Hypercore. HNSW for BEEs, Qdrant for aggregator.
- **HTTP sync as fallback**: SyncManager pulls `/api/fragments` from peers. Decentralized — HTTP URLs exchanged via Protomux. Kept while native replication stabilises.
- **Native Hypercore replication**: core key fetched via HTTP after peer URL is known. No Protomux conflict. All test phases pass.
- **No agent framework**: own TypeScript extractor, cleaner and more auditable than LangChain/LangGraph for this use case.
- **Topic-centric**: LLM decides sources per topic at runtime. Wikipedia first, then RSS, then arXiv.
- **Multi-provider LLM**: Groq (recommended), Gemini, Claude, OpenAI.

## Known issues & roadmap

| Issue | Impact | Status |
|-------|--------|--------|
| `await b.put()` missing in KnowledgeStore | Hypercore was always empty — P2P replication impossible | **Fixed v0.4** |
| Listeners registered after p2pNode.start() | Aggregator missed early peer events | **Fixed v0.4** |
| Env trailing newline bug | LLM_API_KEY corrupted in tmp_env | **Fixed v0.4** |
| `node --env-file` inheritance | Shell env overrides --env-file | **Fixed v0.4** |
| Native Hypercore replication | test_replication.ts all phases pass | **Fixed v0.4** |
| HTTP sync as fallback | Works, not P2P-native | **Kept as fallback** |
| Fragment TTL + cross-cycle dedup | Wasted LLM tokens on stale content | **Fixed v0.4** |
| `supersede()` not wired | KnowledgeStore method never called | **Fixed v0.4** |
| Qdrant `search()` API v1.12+ | search() removed, use query_points() | **Fixed v0.4** |
| doi string "null" bug | String not JSON null | **Fixed v0.4** |
| Signature verification on receive | Malicious node could inject unsigned data | **TODO v0.5** |
| Replication factor ≥ 3 | Fragments may exist in < 3 BEEs | **TODO v0.5** |
| IConsensus — fragment quality voting | No multi-agent validation | **TODO v0.6** |
| Semantic routing / VecDHT | All BEEs reply to all queries | **TODO v0.6** |
| Token economics | No incentive layer | **TODO v0.7+** |
| Hyperswarm DHT blocked in Codespaces | Cross-machine needs open UDP | Expected — HTTP sync covers Codespaces |

## Running tests

```bash
# Native Hypercore replication — should show ALL PHASES PASSED
packages/core/node_modules/.bin/tsx packages/core/src/test_replication.ts

# SESSION_CLOSED fix + write queue
packages/core/node_modules/.bin/tsx packages/core/src/test_v03.ts
```

## GitHub

```
Repo   : https://github.com/capybarist/hive (private)
Branch : feature/v04-p2p-replication (current work)
Push   : requires GITHUB_TOKEN workaround
         TOKEN=$(GITHUB_TOKEN="" gh auth token)
         git remote set-url origin "https://capybarist:${TOKEN}@github.com/capybarist/hive.git"
         git push origin feature/v04-p2p-replication
```

## Developer context

- Background: Java/enterprise (Windows Financial Services)
- Learning distributed systems and AI
- Project serves as both portfolio and real product
- Communicates in Spanish
- All code comments and logs must be in English
- `Bash(*)` is pre-approved in `.claude/settings.json`
