# HIVE — Heuristic Intelligent Vector Extraction

**A decentralized, verifiable knowledge base built for LLMs.**  
A P2P network of autonomous BEEs that extract, sign, and sync knowledge from the open web.

> *What Wikipedia is for humans — but for machines.*

→ **[Read the Manifesto](./MANIFESTO.md)** — why this exists and where it's going.

---

## Quick start

The recommended deployment is the **full stack via Docker Compose** —
that gives you a BEE, an aggregator, Qdrant, and a Caddy reverse proxy
all wired up. You only need an LLM API key.

### 1. Full VPS stack (recommended)

```bash
git clone https://github.com/capybarist/hive.git && cd hive
cp .env.example .env
nano .env                                # paste your LLM_API_KEY
docker compose up -d                     # caddy + qdrant + bee-1 + aggregator
```

That's it. Open:
- `http://<your-ip>` → aggregator UI (via Caddy)
- `http://<your-ip>:8080` → bee-1 dashboard (extraction activity)
- `http://<your-ip>:8090` → aggregator dashboard (Qdrant-backed queries)

Default provider is **Gemini Flash Lite** (free tier covers a 4 GB VPS
with 1–2 BEEs easily). Get a key in <2 min at
[aistudio.google.com](https://aistudio.google.com).

#### Add a second BEE (more extraction throughput)

```bash
docker compose --profile bee-2 up -d
```

Bee-2 listens on `:8081` and auto-coordinates topics with bee-1 over the
P2P network. Each new BEE adds independent extraction capacity. For a
4 GB VPS, 2 BEEs is the practical limit when running with cloud LLM.

#### Run a fully-local LLM (no cloud)

```bash
docker compose --profile ollama up -d    # pulls qwen2.5:1.5b on first start
# then in .env: LLM_PROVIDER=ollama   LLM_MODEL=qwen2.5:1.5b
```

Ollama adds ~2 GB of RAM and is much slower (~250 frag/h on CPU vs
several thousand/h on cloud). Use it only if you specifically want
zero-cloud operation.

### 2. Single BEE without Docker (from source)

```bash
git clone https://github.com/capybarist/hive.git && cd hive
npm install
pip install -r packages/embeddings/requirements.txt

echo "LLM_PROVIDER=gemini" >> .env
echo "LLM_API_KEY=AIza_your_key_here" >> .env
echo "LLM_MODEL=gemini-2.5-flash-lite" >> .env

bash hive.sh                             # single BEE on :8080
```

### 3. Dev mode — 3 BEEs on one machine

```bash
bash start.sh                            # bees on :8080 :8081 :8082
bash start.sh --clean                    # wipe data and restart
bash stop.sh --force                     # kill all processes
```

Useful for testing P2P + replication locally before deploying.

---

## LLM Providers

HIVE uses **one provider for everything** — autonomous extraction *and*
query synthesis. The embeddings model (`all-MiniLM-L6-v2`, ~80 MB) always
runs locally and is not an LLM.

| Provider | Cost | Default model | Where to get a key |
|---|---|---|---|
| **Gemini** *(default)* | Generous free tier | `gemini-2.5-flash-lite` | [aistudio.google.com](https://aistudio.google.com) |
| **Groq** | Free 100K tok/day | `llama-3.3-70b-versatile` | [console.groq.com](https://console.groq.com) |
| **Claude** | Paid | `claude-sonnet-4-6` | [console.anthropic.com](https://console.anthropic.com) |
| **OpenAI** | Paid | `gpt-4o` | [platform.openai.com](https://platform.openai.com) |
| **Ollama** | Free, local, slow | `qwen2.5:1.5b` | runs on your VPS — opt in via `--profile ollama` |

Set in `.env`:

```bash
LLM_PROVIDER=gemini
LLM_API_KEY=AIza_your_key_here
LLM_MODEL=gemini-2.5-flash-lite          # optional override
```

Or configure at runtime via the UI — click the provider chip in the
sidebar. **Note:** UI-set provider lives in container memory; for
persistence across redeploys, set it in `.env`.

---

## Configuration

```bash
# Provider
LLM_PROVIDER=groq            # groq | gemini | claude | openai | ollama
LLM_API_KEY=your_key         # not needed for ollama

# Optional model override (defaults shown)
LLM_MODEL=llama-3.3-70b-versatile   # groq default
LLM_MODEL=gemini-2.5-flash-lite     # gemini default
LLM_MODEL=claude-sonnet-4-6         # claude default
LLM_MODEL=gpt-4o                    # openai default
LLM_MODEL=qwen2.5:1.5b             # ollama default (950MB, fits 4GB VPS)

# Ports
HIVE_PORT=8080
HIVE_EMBEDDER_PORT=7700

# Data (default: ~/.hive in production, data/bee-N/ in dev)
HIVE_DATA_DIR=/path/to/data

# Connect to existing network (optional)
HIVE_PEER=http://peer.example.com

# Suggest a domain (BEE still decides autonomously)
BEE_TOPIC_DOMAIN=health   # or: science, tech, history, culture...

# Extraction tuning
HIVE_EXTRACT_MAX_FRAGMENTS=9        # fragments per cycle, split across claimed topics
HIVE_EXTRACT_INTERVAL_MS=60000      # pause between cycles (1 min = near-continuous)
HIVE_EXTRACT_BUDGET_MINUTES=20      # total LLM time per cycle, divided by topic count
```

**Throughput guidance:**

| Provider | Fragments/day (1 BEE, 3 topics) | Notes |
|----------|--------------------------------|-------|
| Ollama qwen2.5:1.5b on CPU | ~630 | Free. No API key. Small model may paraphrase. |
| Groq free tier | ~6,400 | 100K tokens/day. Recommended for quality. |
| Gemini / OpenAI | ~10,000+ | Paid. Highest quality and speed. |

> **Fragment quality note:** Small local models (≤3b) tend to paraphrase source content instead of extracting verbatim, which can introduce inaccuracies. For production use, Groq (free) or Gemini are recommended. v0.6 will fix this architecturally — tools will auto-index verbatim content without LLM involvement in the text path.

---

## Full VPS stack (Docker Compose)

The recommended production setup runs everything with a single command.

```bash
# 1. Copy and edit config
cp .env.example .env
nano .env          # set LLM_PROVIDER + LLM_API_KEY (or use ollama, see below)

# 2. Start the full stack (Caddy + 2 BEEs + Aggregator + Qdrant)
docker compose up -d

# Access points:
#   http://your-ip        → Aggregator (via Caddy)
#   http://your-ip:8080   → BEE 1 directly
#   http://your-ip:8081   → BEE 2 directly
#   http://your-ip:8090   → Aggregator directly
#   http://your-ip:6333/dashboard → Qdrant
```

### Using Ollama (local LLM, no API key)

Ollama is the **default** in the Docker Compose stack. No config needed — just start:

```bash
docker compose up -d
```

The `ollama-init` container pulls `qwen2.5:1.5b` (~950MB) automatically on first start. If it fails, pull manually:

```bash
docker exec hive-ollama ollama pull qwen2.5:1.5b
```

To use a larger model (better quality, needs more RAM):

```bash
# In .env:
OLLAMA_MODEL=qwen2.5:3b   # ~1.9GB — needs 4GB+ free RAM
docker compose up -d --force-recreate ollama-init
```

RAM guide: `qwen2.5:1.5b` ~950MB → safe on 4GB VPS. `qwen2.5:3b` ~1.9GB → needs 6GB+ VPS.

---

## Aggregator node

An aggregator connects to all BEEs in the network, replicates their Hypercore data, and indexes everything into Qdrant for scalable vector search. It doesn't extract — it aggregates.

```bash
# Requires Docker for Qdrant (started automatically)
bash aggregator.sh

# Or with explicit Qdrant URL
QDRANT_URL=http://localhost:6333 bash aggregator.sh
```

The aggregator's Qdrant dashboard is available at `http://localhost:6333/dashboard`.

Any node can become an aggregator — it will automatically sync all existing fragments from peers via Hypercore replication + HTTP sync fallback.

---

## How it works (v0.6.4)

```
BEE starts
  → Loads ed25519 identity from data/identity/node.json (created on first boot)
  → Opens local Hypercore (fragments) + Hypercore (claims), same Corestore
  → Joins Hyperswarm DHT on topic = sha256("hive-network-v0.1")

On every peer connection:
  → store.replicate(socket) opens native Hypercore replication
  → Protomux channel `hive/meta/v2` exchanges:
       { nodeId, publicKey, coreKey, claimsCoreKey }
  → peer-meta event:
      • register peer's pubkey for ed25519 verify on receive
      • open peer's fragments core read-only by coreKey → download
      • open peer's claims   core read-only by claimsCoreKey → download
  → watchRemoteCore: live stream → verify signature → POST to local embedder

Extraction loop (every HIVE_EXTRACT_INTERVAL_MS):
  → Dequeue 5 titles from crawl_queue.jsonl
  → For each: wikipedia_fetch verbatim → onFragment per H2/H3
       → store.get(id) — check Hypercore for existing fragment
            → Fresh (within TTL — wiki 7d, rss 24h, arxiv 30d): skip
            → Stale: supersede() — old marked, new appended
            → New: save() + POST to embedder with hash + signature
  → Aux fetch by rule: news topics → rss_fetch; science → arxiv_search

No HTTP between two HIVE nodes anywhere since v0.6.4. The Fastify
server is for external clients only (dashboard + /api/query).
```

---

## Architecture

```
packages/
  core/        — KnowledgeStore (Hypercore+Hyperbee), P2P node, PeerRegistry,
                  ClaimRegistry, ed25519 identity, topic assignment
  agent/       — Autonomous extractor + crawl queue, wikipedia_fetch,
                  arxiv_search, rss_fetch, text_chunker, HTML-entity decoder
  embeddings/  — Python: all-MiniLM-L6-v2 → HNSW (bees) or Qdrant (aggregator)
  api/         — Fastify :8080 + UI server, runtime-env loader, version badge
  ui/          — Web UI (vanilla HTML/JS, light theme, version + mode chips)

data/
  topic_tree.json    — committed taxonomy (95 topics, 9 domains)
  identity/          — runtime ed25519 keypair per node (gitignored)
  corestore/         — Hypercore data: fragments + claims cores (gitignored)
  crawl_queue.jsonl  — persistent BFS queue of titles to fetch
  .runtime.env       — UI-set LLM overrides (since v0.6.4.3)
```

---

## Future architecture (v0.7+)

The next major version will split a bee's two responsibilities into
selectable modes, all from the same binary and the same Docker image:

| Mode | Role | Who runs it |
|------|------|-------------|
| `HIVE_MODE=bee` (new default) | **Producer** — extracts, signs, propagates its Hypercore. No embedder, no LLM, no query API. ~150 MB. | Anyone who wants to contribute to the network. Raspberry-Pi-friendly. |
| `HIVE_MODE=queen` (renamed from aggregator) | **Consumer / indexer** — replicates every bee's Hypercore into Qdrant, serves `/api/query` with LLM synthesis. ~600 MB. | Anyone who wants to query (public services, private corporate verticals). |
| `HIVE_MODE=hive` | Both in one process. | Single-machine quickstart — preserves v0.6 behaviour for backward compatibility. |

The metaphor stays: bees forage, the queen organises. Splitting roles
amplifies Hypercore's single-writer pattern (which Holepunch already
uses for Keet, Hyperdrive, etc.) — it does not break P2P. No
"HIVE Inc." middle layer; anyone can run their own queen indexing
whichever bees they care about.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history and
[CLAUDE.md](./CLAUDE.md) for the detailed roadmap.

---

## Logs

```bash
tail -f /tmp/hive_api_bee-1.log   # BEE-1 activity
tail -f /tmp/hive_embedder.log    # aggregator embedder
tail -f /tmp/hive_aggregator.log  # aggregator P2P + sync
```

---

## License

BUSL-1.1 — free to use non-commercially. Converts to MIT after 4 years.  
See [LICENSE](./LICENSE) and [MANIFESTO.md](./MANIFESTO.md).
