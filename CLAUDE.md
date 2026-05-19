# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

---

## Current state: v0.5.1 — HIVE_API_URL fix + auto-deploy + systemd recovery

v0.5.1 is an operational hardening release on top of v0.5: same features,
but the P2P replication actually works cross-container, the stack survives
reboots, and pushes to main auto-deploy to the server.

### What v0.5.1 shipped

| Item | Why | Where |
|------|-----|-------|
| `HIVE_API_URL` env var | bee was hardcoding `http://127.0.0.1:${PORT}` as its peer-reachable URL. In Docker that resolves to *the peer's* loopback, so neither HTTP sync nor the HTTP-bootstrap of native Hypercore replication ever connected cross-container → aggregator stayed at 655 fragments while bee climbed to 2,294+ over 2 days | `packages/api/src/api_server.ts` + 3 places in `docker-compose.yml` |
| Auto-deploy on push to main | Mirror of what cAPY has. Workflow SSHes to server (dedicated `DEPLOY_SSH_KEY` secret), pulls image, recreates stack, verifies `/api/status` | `.github/workflows/publish-docker.yml` |
| `deploy/hive.service` systemd unit | Stack returns at boot even if containers were removed (the outage we hit: `restart=unless-stopped` doesn't save you from missing containers, only from crashed ones). `ExecStartPre=-docker compose pull` tolerates GHCR hiccups | `deploy/hive.service` |

### Empirical validation after the v0.5.1 fix (2026-05-19)

Before fix: aggregator `peers=0`, `[sync] Peer http://127.0.0.1:8080 unreachable` looping forever in logs, Qdrant stuck at **655** for days.
After fix (within 90s of redeploy): `[p2p] Peer connected: b70fdf81575eab07 (total: 1)`, `Got API URL from b70fdf81575eab07: http://bee-1:8080`, `Core key fetched ... native replication started`. Qdrant went **655 → 1540** in the first 90 seconds as the backlog drained over Hypercore replication. Continues catching up live thereafter.

### What v0.5.1 did NOT fix

- **Indexing rate stays ~5-10 fragments/hour on Ollama CPU**. Tried switching bee-1 to Groq free tier as an acceleration, but free-tier Groq is unsuitable for this workload because (1) `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` have only 6k-12k TPM on free tier, and (2) the bee and aggregator share the same API key → they share the TPM bucket → the aggregator's query traffic eats into the bee's extraction budget, every extractor cycle 429s on rate limits. Reverted bee-1 to Ollama. The real fix is v0.6 (LLM-free extraction), not throwing more LLM at it.
- **Aggregator's `(unhealthy)` status in `docker ps`** is cosmetic — the Dockerfile `HEALTHCHECK` curls `127.0.0.1:8080` which doesn't exist inside the aggregator container. The aggregator itself is fully operational (peers=1, replication active, queries served). Leave it; fixing the healthcheck doesn't change behaviour.

All 7 modules complete. Native P2P replication fixed in v0.4. Ollama + major extraction improvements added in v0.5.

| Module | Description | Status |
|--------|-------------|--------|
| 1 | Embeddings + HNSW (all-MiniLM-L6-v2, 80MB CPU) | ✅ |
| 2 | Extractor: wikipedia_fetch (sections API) + rss_fetch + arxiv_search + web_fetch | ✅ |
| 3 | KnowledgeStore — Hypercore + Hyperbee, ed25519-signed | ✅ |
| 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed v0.4 |
| 5 | Vector query API (Fastify) + federated queries | ✅ |
| 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI / Ollama) — light theme | ✅ |
| 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
| — | Aggregator node + Qdrant backend | ✅ added v0.4 |
| — | Ollama local LLM provider (no API key) | ✅ added v0.5 |
| — | wikipedia_fetch tool using Wikipedia sections REST API | ✅ added v0.5 |
| — | HIVE_EXTRACT_BUDGET_MINUTES — configurable per-topic time budget | ✅ added v0.5 |

**Added beyond original spec:**
- Aggregator node + Qdrant backend
- Multi-provider LLM: Groq, Gemini, Claude, OpenAI, Ollama (local)
- TTL + supersede wired in extractor
- Light theme UI
- `wikipedia_fetch` tool with Wikipedia REST API (sections, not HTML scraping)
- `HIVE_EXTRACT_BUDGET_MINUTES` env var

**In original spec, not yet implemented:**
- `Autobase` multi-writer → **abandoned** (see decision below)
- `IConsensus` multi-agent fragment quality voting → **v0.6**
- Signature verification on receive → **v0.6**
- Replication factor ≥ 3 → **v0.6**
- LLM-free verbatim extraction → **v0.6** (see architectural decision below)
- Semantic routing / VecDHT → **v0.7**
- Token economics (WDK) → **v0.7+**

---

## Roadmap

### v0.6 — Trust & correctness
The Manifesto guarantees "no fabricated citations". v0.6 closes the gap between the promise and the implementation.

| Item | Why | Notes |
|------|-----|-------|
| LLM-free verbatim extraction | Small models hallucinate fragment text — violates "no fabricated citations" | See architectural decision below |
| Signature verification on receive | Malicious nodes can inject unsigned fragments today | `watchRemoteCore` validates ed25519 before indexing |
| Replication factor ≥ 3 | Fragments may exist on only 1 BEE — single point of failure | Auto-replicate until ≥ 3 copies confirmed |
| IConsensus — fragment quality voting | No validation that fragment text matches claimed source | Multiple BEEs vote; outliers rejected |

### v0.7 — Scale & economics
| Item | Why |
|------|-----|
| BulkImporter — Wikipedia dump | LLM-per-fragment is too slow for Wikipedia-scale (~46 years on Ollama CPU). Direct chunking of Wikipedia XML dumps, no LLM, into Hypercore. |
| Semantic routing / VecDHT | All BEEs reply to all queries; should route to relevant nodes only |
| QVAC integration | `LLM_PROVIDER=qvac` for on-device inference without Ollama overhead |
| Token economics (WDK) | Extractors earn USD₮ per query served; consumers pay per query |
| Topic tree expansion | 95 topics → 5000+ for meaningful coverage |

---

## Critical architectural decision: LLM-free extraction (v0.6)

### The problem
Currently the extraction agent uses an LLM to:
1. Decide **what** to fetch (correct — this requires intelligence)
2. **Write the text** of each fragment (wrong — small models hallucinate)

With qwen2.5:1.5b, the LLM paraphrases or invents content instead of extracting verbatim. The ed25519 signature only guarantees "node X said this" — it does NOT guarantee the fragment text matches the source URL. This violates the Manifesto's "no fabricated citations" guarantee.

### The fix (v0.6)
Separate orchestration from extraction:

```
Current (v0.5):
  LLM → web_fetch(url) → sees 8000 chars → writes fragment text → index_fragment()
  Problem: LLM invents / paraphrases the text

Target (v0.6):
  LLM → wikipedia_fetch(title) → tool auto-indexes sections verbatim → returns "indexed N sections"
  LLM only decides WHAT to fetch and WHEN to move to the next source
  Fragment text = verbatim from source API, never LLM-generated
```

`wikipedia_fetch`, `rss_fetch`, and `arxiv_search` tools will call `onFragment()` internally with verbatim content, bypassing the LLM for text generation entirely. The LLM receives only a summary ("indexed 12 sections of Astrophysics") and decides next steps.

Benefits: zero hallucination, 10x+ throughput (no LLM per fragment), source fidelity guaranteed.

The LLM remains responsible for: topic selection, source discovery, query synthesis in `/api/query`.

---

## Autobase decision

The original spec calls for Autobase (multi-writer linearisation). Removed in v0.2.1 — `Autobase is closing` concurrent write errors were unresolvable. The current model (each BEE owns its single-writer Hypercore, peers open it read-only) is architecturally cleaner for HIVE: each BEE is the sole authority on its own knowledge. Not planned for reinstatement.

---

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
  → Fresh (within TTL): skip
  → Stale (past TTL): supersede() — marks old, indexes new
  → New: save() + embedder /add
```

**TTL by source:** wiki 7 days · rss 24h · arXiv 30 days · web 3 days

**HNSW is a derived index**, always reconstructable from Hypercore history.

---

## File structure

```
hive/
├── hive.sh              ← production launcher (zero-config, single BEE)
├── aggregator.sh        ← aggregator node launcher (starts Qdrant via Docker)
├── start.sh             ← dev launcher (multiple BEEs from bees/*.env)
├── stop.sh              ← kills all processes by port
├── docker-compose.yml   ← full VPS stack (Caddy + BEE + Aggregator + Qdrant + Ollama)
├── bees/                ← dev configs: bee-1.env, bee-2.env, bee-3.env
├── data/
│   ├── topic_tree.json  ← 95-topic knowledge taxonomy (committed)
│   └── bee-*/           ← runtime data (gitignored)
└── packages/
    ├── core/src/
    │   ├── knowledge_store.ts   ← KnowledgeStore: save/get/supersede/watchFragments/watchRemoteCore
    │   ├── p2p_node.ts          ← Hyperswarm + Protomux URL exchange + store.replicate()
    │   ├── sync_manager.ts      ← HTTP sync fallback (8s interval)
    │   ├── claim_registry.ts    ← topic claim coordination via HTTP
    │   ├── topic_assignment.ts  ← assigns topic tree leaves to BEEs
    │   └── node_identity.ts     ← ed25519 identity per BEE
    ├── agent/src/
    │   ├── autonomous_extractor.ts ← LLM orchestration agent + dedup/TTL/supersede logic
    │   ├── tools_registry.ts       ← wikipedia_fetch, arxiv_search, rss_fetch, web_fetch, index_fragment
    │   ├── budget_controller.ts    ← token/fragment/time limits per cycle
    │   └── text_chunker.ts         ← overlapping chunk splitting utility
    ├── embeddings/
    │   ├── api_server.py        ← FastAPI :7700, HNSW + Qdrant backends
    │   └── qdrant_index.py      ← Qdrant client (aggregator backend)
    ├── api/src/
    │   ├── api_server.ts        ← Fastify :8080, all endpoints + extraction loop
    │   └── llm_client.ts        ← LLM synthesis for /api/query
    └── ui/
        └── index.html           ← vanilla JS UI, light theme
```

---

## How to run

```bash
# Docker — full stack (recommended for VPS):
docker compose up -d
# Model pulls automatically on first start via ollama-init container

# Production (single BEE, from source):
bash hive.sh

# Dev (3 BEEs, from source):
bash start.sh
bash start.sh --clean        # wipe data and restart
bash stop.sh --force         # kill all processes

# Aggregator (from source, starts Qdrant via Docker automatically):
bash aggregator.sh
```

---

## Key environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `ollama` (Docker) / `gemini` (shell) | `gemini` · `claude` · `openai` · `groq` · `ollama` |
| `LLM_API_KEY` | — | Required for cloud providers. Not needed for `ollama`. |
| `LLM_MODEL` | — | Optional override (e.g. `qwen2.5:1.5b`) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server. In Docker Compose: `http://ollama:11434` |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | Model to pull on first start (Docker only) |
| `HIVE_PORT` | 8080 | API server port |
| `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
| `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory |
| `HIVE_PEER` | — | Bootstrap peer HTTP URL |
| `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | 9 (Docker) / 10 (shell) | Max fragments per extraction cycle |
| `HIVE_EXTRACT_INTERVAL_MS` | 60000 (Docker) / 1800000 (shell) | Pause between cycles (ms) |
| `HIVE_EXTRACT_BUDGET_MINUTES` | 20 (Docker) / 8 (shell) | Total LLM time budget per cycle, split across topics |

**LLM architecture note:** ONE `LLM_PROVIDER` for both extraction orchestration and query synthesis. The embeddings model (all-MiniLM-L6-v2, ~80MB) always runs locally via Python — never a cloud LLM.

**Throughput guidance with Ollama:**
- `qwen2.5:1.5b` on CPU: ~5-10 tokens/sec → ~630 fragments/day (1 BEE, 3 topics)
- `qwen2.5:3b` on CPU: slower, needs 4GB+ free RAM
- Groq free tier: ~500 tokens/sec → ~6,400 fragments/day
- Fragment quality warning: small models (1.5b) paraphrase instead of extracting verbatim. Use Groq/Gemini for production quality. v0.6 will fix this architecturally.

---

## Dev BEE ports

| BEE | API | Embedder | Notes |
|-----|-----|----------|-------|
| bee-1 | 8080 | 7700 | Seed — no peer |
| bee-2 | 8081 | 7701 | Peers with bee-1 |
| bee-3 | 8082 | 7702 | Peers with bee-1, `BEE_TOPIC_DOMAIN=current_events` |
| aggregator | 8090 | 7790 | Read-only, Qdrant backend |

---

## Key design decisions

- **Hypercore as source of truth**: append-only, ed25519-signed. Data lives here regardless of sync transport.
- **Single-writer per BEE**: each BEE owns its Hypercore. Peers open it read-only. No Autobase.
- **HNSW/Qdrant as derived index**: always rebuildable from Hypercore. HNSW for BEEs, Qdrant for aggregator.
- **HTTP sync as fallback**: SyncManager pulls `/api/fragments` from peers every 8s. Kept while native replication stabilises.
- **Native Hypercore replication**: core key fetched via HTTP after peer URL is known. All test phases pass.
- **No agent framework**: own TypeScript extractor — cleaner and more auditable than LangChain for this use case.
- **Topic-centric extraction**: LLM picks sources per topic. wikipedia_fetch → rss_fetch → arxiv_search priority.
- **LLM for orchestration only (v0.6 target)**: LLM decides what to fetch, tools do the verbatim extraction.

---

## Known issues

| Issue | Impact | Status |
|-------|--------|--------|
| `await b.put()` missing in KnowledgeStore | Hypercore always empty — P2P replication impossible | **Fixed v0.4** |
| Listeners registered after p2pNode.start() | Aggregator missed early peer events | **Fixed v0.4** |
| Native Hypercore replication | test_replication.ts all phases pass | **Fixed v0.4** |
| Qdrant `search()` API v1.12+ | Replaced with query_points() | **Fixed v0.4** |
| ollama-init TTY error | `ollama pull` CLI requires TTY — switched to HTTP API | **Fixed v0.5** |
| web_fetch 2000-char truncation | Only article intro indexed — missed 95% of content | **Fixed v0.5** (wikipedia_fetch) |
| RSS 300-char teaser | Useless teasers indexed instead of article content | **Fixed v0.5** (content:encoded) |
| arXiv 500-char abstract | Abstract cut mid-sentence | **Fixed v0.5** (2000 chars) |
| LLM writes fragment text | Small models hallucinate/paraphrase — violates "no fabricated citations" | **TODO v0.6** (LLM-free extraction) |
| Signature verification on receive | Malicious node could inject unsigned data | **TODO v0.6** |
| Replication factor ≥ 3 | Fragments may exist on < 3 BEEs | **TODO v0.6** |
| IConsensus — fragment quality voting | No multi-agent validation | **TODO v0.6** |
| ~~Peer HTTP URL in Docker (127.0.0.1)~~ | ~~Aggregator advertises loopback — HTTP sync fallback fails cross-container~~ | **Fixed v0.5.1** — `HIVE_API_URL` env var. Note: also broke native replication, not just HTTP sync — the bootstrap of native replication requires the same HTTP exchange to fetch the peer's `coreKey`. Previous docs claimed native still worked; empirically it didn't (0 `native replication started` logs before the fix). |
| Free-tier Groq for bee extraction | bee + aggregator share the API key → share the TPM bucket. Aggregator's queries leave the bee with ~1-2k usable TPM/min, can't complete extraction cycles | **Won't fix at this layer** — real fix is v0.6 LLM-free extraction. Alternatives: separate API key per node, paid Groq Dev tier, or another provider with higher free TPM |
| Aggregator `(unhealthy)` in `docker ps` | Dockerfile HEALTHCHECK curls `127.0.0.1:8080` which isn't bound in the aggregator container | Cosmetic — aggregator works correctly. Will tidy when touching the Dockerfile next |
| Semantic routing / VecDHT | All BEEs reply to all queries | **TODO v0.7** |
| Token economics | No incentive layer | **TODO v0.7+** |
| Hyperswarm DHT in Codespaces | Cross-machine needs open UDP | Expected — HTTP sync covers Codespaces |

---

## Running tests

```bash
# Native Hypercore replication — should show ALL PHASES PASSED
packages/core/node_modules/.bin/tsx packages/core/src/test_replication.ts

# SESSION_CLOSED fix + write queue
packages/core/node_modules/.bin/tsx packages/core/src/test_v03.ts
```

---

## GitHub

```
Repo   : https://github.com/capybarist/hive (private)
Branch : main
Push   : requires GITHUB_TOKEN workaround
         TOKEN=$(GITHUB_TOKEN="" gh auth token)
         git remote set-url origin "https://capybarist:${TOKEN}@github.com/capybarist/hive.git"
         git push origin main
```

---

## Developer context

- Background: Java/enterprise (Financial Services)
- Learning distributed systems and AI
- Project is both portfolio and real product
- Communicates in Spanish
- All code comments and logs must be in English
- `Bash(*)` is pre-approved in `.claude/settings.json`
