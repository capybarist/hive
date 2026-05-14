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
HIVE_EXTRACT_MAX_FRAGMENTS=20
HIVE_EXTRACT_INTERVAL_MS=300000   # 5 minutes
```

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

```bash
# In .env:
LLM_PROVIDER=ollama
# (comment out or remove LLM_API_KEY)

# Start with Ollama profile (Docker pulls the image automatically)
docker compose --profile ollama up -d

# Download the AI model once (~1.9GB, persists across restarts)
docker exec hive-ollama ollama pull qwen2.5:3b

# Restart BEEs to pick up the new provider
docker compose restart bee-1 bee-2 aggregator
```

RAM guide: `qwen2.5:3b` ~1.9GB needs ~4GB total VPS. For tighter RAM use `qwen2.5:1.5b` (~950MB).

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
| 2 | Reactive extractor (arXiv + RSS + web fetch) | ✅ |
| 3 | KnowledgeStore — Hypercore + Hyperbee, append-only, ed25519-signed | ✅ |
| 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed in v0.4 |
| 5 | Vector query API (Fastify) + federated search | ✅ |
| 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI / Ollama) | ✅ |
| 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
| — | Aggregator node + Qdrant backend | ✅ added in v0.4 |
| — | Ollama local LLM + light theme UI | ✅ added in v0.5 |

**Planned for v0.6:**
- Signature verification on receive (`watchRemoteCore` validates ed25519)
- Replication factor enforcement (≥ 3 copies per fragment)
- `IConsensus` — multi-agent voting on fragment quality
- Semantic routing (query propagation to semantically relevant BEEs)

**Planned for v0.7+:**
- P2P topic coordination (without HTTP claims)
- Token economics (extractors rewarded for verified contributions)

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
