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

| Provider | Free tier | Model | Notes |
|---|---|---|---|
| **Groq** | 100K tokens/day, unlimited RPD on some models | `llama-3.3-70b-versatile` | Recommended for dev. Get key at console.groq.com |
| **Gemini** | Limited free tier | `gemini-2.5-flash-lite` | Unlimited RPD on flash-lite. aistudio.google.com |
| **Claude** | Paid | `claude-sonnet-4-6` | console.anthropic.com |
| **OpenAI** | Paid | `gpt-4o` | platform.openai.com |

```bash
# Set in hive/.env (persists across restarts)
LLM_PROVIDER=groq
LLM_API_KEY=gsk_your_key
LLM_MODEL=llama-3.3-70b-versatile   # optional override
```

Or configure at runtime via the UI — click the provider button in the sidebar.

---

## Configuration

```bash
# Provider
LLM_PROVIDER=groq            # groq | gemini | claude | openai
LLM_API_KEY=your_key

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
  ui/          — Web UI (vanilla HTML/JS, dark theme)

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

## v0.4 Status — May 2026

| Module | Description | Status |
|--------|-------------|--------|
| 1 | Embeddings + local HNSW (all-MiniLM-L6-v2, 80MB CPU) | ✅ |
| 2 | Reactive extractor (arXiv + RSS + web fetch) | ✅ |
| 3 | KnowledgeStore — Hypercore + Hyperbee, append-only, ed25519-signed | ✅ |
| 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed in v0.4 |
| 5 | Vector query API (Fastify) + federated search | ✅ |
| 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI) | ✅ |
| 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
| — | Aggregator node + Qdrant backend | ✅ added in v0.4 |

**Planned for v0.5:**
- Signature verification on receive (`watchRemoteCore` validates ed25519)
- Replication factor enforcement (≥ 3 copies per fragment)
- Cross-machine test on real VMs with open UDP
- README installation guide and `hive.sh` polish

**Planned for v0.6+:**
- `IConsensus` — multi-agent voting on fragment quality
- Semantic routing (query propagation to semantically relevant BEEs)
- P2P topic coordination (without HTTP claims)
- Token economics (extractors rewarded for verified contributions)

---

## Known issues (v0.4)

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
