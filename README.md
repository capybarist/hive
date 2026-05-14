# HIVE — Heuristic Intelligent Vector Extraction

**A decentralized, verifiable knowledge base built for LLMs.**  
A P2P network of autonomous BEEs that extract, sign, and sync knowledge from the open web.

> *What Wikipedia is for humans — but for machines.*

→ **[Read the Manifesto](./MANIFESTO.md)** — why this exists and where it's going.

---

## Quick start

### Option 1 — Docker (recommended)

```bash
docker run -d \
  -e LLM_PROVIDER=groq \
  -e LLM_API_KEY=gsk_your_key_here \
  -p 8080:8080 -p 7700:7700 \
  -v hive-data:/root/.hive \
  ghcr.io/capybarist/hive:latest
```

Open `http://localhost:8080` — the BEE self-configures and starts indexing.

Get a free Groq key at [console.groq.com](https://console.groq.com).

### Option 2 — From source

```bash
git clone https://github.com/capybarist/hive.git && cd hive
npm install
pip install -r packages/embeddings/requirements.txt

# Set your LLM key
echo "LLM_PROVIDER=groq" >> .env
echo "LLM_API_KEY=gsk_your_key_here" >> .env

bash hive.sh   # single BEE, production mode
```

Open `http://localhost:8080` — the BEE scans the network, claims uncovered topics, and starts indexing autonomously.

### Dev mode — 3 BEEs on the same machine

```bash
bash start.sh           # starts bee-1, bee-2, bee-3
bash start.sh --clean   # wipe data and restart
bash stop.sh --force    # kill everything
```

---

## LLM Providers

| Provider | Cost | Model | Notes |
|---|---|---|---|
| **Ollama** | Free, local | `qwen2.5:3b` | No API key. Runs on your machine. Recommended for VPS. |
| **Groq** | Free tier 100K tokens/day | `llama-3.3-70b-versatile` | Best quality for free. Get key at console.groq.com |
| **Gemini** | Free tier available | `gemini-2.5-flash` | aistudio.google.com |
| **Claude** | Paid | `claude-sonnet-4-6` | console.anthropic.com |
| **OpenAI** | Paid | `gpt-4o` | platform.openai.com |

HIVE uses **one provider for everything** — both autonomous extraction and query synthesis. The embeddings model (all-MiniLM-L6-v2, ~80MB) always runs locally and is not an LLM.

```bash
# Cloud provider — set in hive/.env
LLM_PROVIDER=groq
LLM_API_KEY=gsk_your_key

# Or Ollama (local, no key needed) — requires --profile ollama
LLM_PROVIDER=ollama
# OLLAMA_URL=http://ollama:11434   ← default, no need to set this
```

Or configure at runtime via the UI — click the provider button in the sidebar.

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

## How it works

```
BEE starts
  → Reads data/topic_tree.json (95 topics, 9 domains)
  → Scans peers via HTTP: which topics are already covered
  → Claims uncovered topics (random jitter to avoid races)
  → Every 5 min: LLM agent extracts fragments for each topic
      → Wikipedia first (stable facts)
      → RSS feeds for news topics
      → arXiv for academic/scientific topics
  → Fragments saved to Hypercore (append-only, ed25519-signed)
  → Hypercore replicates to peers natively
  → HTTP sync as fallback for restrictive network environments
  → Before indexing: checks Hypercore for existing fragment (dedup)
      → Fresh content (wiki 7d, rss 24h, arxiv 30d): skip
      → Stale content: supersede() — marks old, indexes new
```

---

## Architecture

```
packages/
  core/        — KnowledgeStore (Hypercore+Hyperbee), P2P node, identity, sync, topic registry
  agent/       — Autonomous extractor (LLM function calling), budget controller
  embeddings/  — Python: all-MiniLM-L6-v2 + HNSW + Qdrant backend
  api/         — Fastify API + UI server
  ui/          — Web UI (vanilla HTML/JS, light theme)

data/
  topic_tree.json   — knowledge taxonomy (95 topics, 9 domains)
  bee-*/            — runtime data per BEE (gitignored)

bees/               — dev configs for multi-BEE testing
```

**Data flow:**
```
BEE-A writes fragment → Hypercore (append-only, signed)
  → Hyperswarm connects BEE-A and BEE-B
  → Protomux channel exchanges HTTP URLs
  → HTTP GET /api/status exchanges Hypercore public keys
  → BEE-B opens BEE-A's core + download() → native replication
  → watchRemoteCore() live stream → HNSW updated
  → HTTP sync (SyncManager) as fallback transport
```

---

## v0.5 Status — May 2026

| Module | Description | Status |
|--------|-------------|--------|
| 1 | Embeddings + local HNSW (all-MiniLM-L6-v2, 80MB CPU) | ✅ |
| 2 | Extractor: wikipedia_fetch (sections API) + arXiv + RSS + web | ✅ |
| 3 | KnowledgeStore — Hypercore + Hyperbee, append-only, ed25519-signed | ✅ |
| 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed in v0.4 |
| 5 | Vector query API (Fastify) + federated search | ✅ |
| 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI / Ollama) — light theme | ✅ |
| 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
| — | Aggregator node + Qdrant backend | ✅ added in v0.4 |
| — | Ollama local LLM (no API key, runs on VPS) | ✅ added in v0.5 |
| — | wikipedia_fetch via Wikipedia REST API (all sections, not just intro) | ✅ added in v0.5 |

**Planned for v0.6 — Trust & correctness:**
- **LLM-free verbatim extraction**: tools auto-index content verbatim without LLM writing the text. Fixes hallucination in small models and fulfils the "no fabricated citations" guarantee. 10x throughput improvement.
- Signature verification on receive (`watchRemoteCore` validates ed25519)
- Replication factor ≥ 3 (auto-replicate until confirmed on 3 BEEs)
- `IConsensus` — multi-agent voting on fragment quality

**Planned for v0.7 — Scale:**
- BulkImporter: direct Wikipedia XML dump ingestion without LLM (enables Wikipedia-scale indexing)
- Semantic routing (query propagation to relevant BEEs only)
- QVAC integration (`LLM_PROVIDER=qvac` for on-device inference)
- Token economics: extractors earn USD₮ per query served (WDK)

---

## Known issues (v0.5)

- **Signature verification on receive**: fragments are signed when saved but signatures are not verified when received from peers. A malicious node could inject unsigned data. Fix planned for v0.5.
- **Replication factor not enforced**: fragments may exist in fewer than 3 BEEs. No automatic re-replication yet.
- **Hyperswarm DHT in Codespaces**: same-machine P2P works. Cross-machine via DHT requires open UDP ports (production VMs work fine; Codespaces uses HTTP sync fallback automatically).
- **No migration scripts**: breaking format changes require `bash start.sh --clean`.

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
