# HIVE — Heuristic Intelligent Vector Extraction

**A decentralized, verifiable knowledge base built for LLMs.**  
A P2P network of autonomous BEEs that extract, sign, and sync knowledge.

> *What Wikipedia is for humans — but for machines.*

→ **[Read the Manifesto](./MANIFESTO.md)** — why this exists and where it's going.

---

## Quick start

### Option 1 — Docker (recommended, no dependencies)

```bash
docker run -d \
  -e GEMINI_API_KEY=your_key_here \
  -p 8080:8080 \
  -v hive-data:/hive/data \
  ghcr.io/capybarist/hive:latest
```

Open http://localhost:8080 — your BEE will self-configure and start indexing.

### Option 2 — npx (Node.js 20+ and Python 3.10+ required)

```bash
# Set your API key
export GEMINI_API_KEY=your_key_here

# Run (installs everything automatically on first run)
npx hive-network
```

### Option 3 — From source

```bash
git clone https://github.com/capybarist/hive.git && cd hive
npm install
pip install -r packages/embeddings/requirements.txt
echo "GEMINI_API_KEY=your_key_here" > .env
bash hive.sh
```

The BEE starts, scans the network, **chooses an uncovered topic from the knowledge tree**, and begins indexing. No manual topic configuration needed.

> Data persists between restarts. Run `bash start.sh --clean` only when explicitly upgrading to a new incompatible version.

---

## Configuration options (all optional)

```bash
# Connect to an existing network
HIVE_BOOTSTRAP=http://peer.example.com bash hive.sh

# Custom port
HIVE_PORT=8081 HIVE_EMBEDDER_PORT=7701 bash hive.sh

# Data directory (default: ~/.hive)
HIVE_DATA_DIR=/data/my-bee bash hive.sh

# Suggest a preferred domain (optional)
# The BEE will still be autonomous — it only prioritizes this domain if there are uncovered leaves
BEE_TOPIC_DOMAIN=health bash hive.sh
```

---

## How it works

```
BEE starts
  → Reads data/topic_tree.json (95 available topics)
  → Scans peers: which topics are already covered
  → Claims 3 uncovered topics (or least-covered ones)
  → Loop every 5 min: extracts fragments for each claimed topic
  → Automatically syncs with other BEEs every 8s
  → Renews claims (TTL 30min) to maintain its territory
```

Each BEE decides what to index on its own. Nobody tells it what to do.

---

## Architecture

```
packages/
  core/        — KnowledgeStore (Hypercore+Hyperbee), P2P, identity, topic registry
  agent/       — Autonomous extractor (Gemini function calling), reactive extractor
  embeddings/  — Python server: all-MiniLM-L6-v2 + HNSW
  api/         — Fastify API + UI server
  ui/          — Web interface (vanilla HTML/JS)

data/
  topic_tree.json   — knowledge tree (95 topics, 9 domains)
  bee-*/            — runtime data per BEE (auto-generated, not in git)

bees/               — configs for local multi-BEE testing (not production)
```

---

## Local multi-BEE testing

To test multiple BEEs on the same machine:

```bash
# Launches all BEEs from bees/*.env
bash start.sh

# Or specific BEEs only
bash start.sh bee-1 bee-2 bee-3

# Add a new BEE
cat > bees/bee-4.env << 'EOF'
BEE_NAME=bee-4
BEE_PORT=8083
BEE_EMBEDDER_PORT=7703
BEE_DATA_DIR=../../data/bee-4
BEE_PEER=http://127.0.0.1:8080
HIVE_EXTRACT_MAX_FRAGMENTS=20
HIVE_EXTRACT_INTERVAL_MS=300000
EOF
bash start.sh bee-4
```

---

## v0.2 Status

| Module | Description | Status |
|--------|-------------|--------|
| 1 | Embeddings + local HNSW | ✅ v0.2 |
| 2 | Reactive extractor (arXiv + RSS) | ✅ v0.2 |
| 3 | Hypercore + Hyperbee (native replication) | ✅ v0.2 |
| 4 | P2P network (Hyperswarm + Protomux core-key exchange) | ✅ v0.2 |
| 5 | Vector API (Fastify) | ✅ v0.2 |
| 6 | UI with Gemini synthesis | ✅ v0.2 |
| 7 | Autonomous extractor + topic tree + claim registry | ✅ v0.2 |

**Planned for v0.3:**
- Replication factor enforcement (≥ 3)
- Semantic routing (VecDHT)
- Token economics
- Sybil attack resistance

---

## Known Issues (v0.2)

- **Hyperswarm DHT may be blocked in Codespaces**: same-machine P2P works fine; cross-machine needs Hyperswarm DHT. Production VMs with open UDP work correctly.
- **No migration scripts**: breaking format changes between versions require `bash start.sh --clean`.
- **Replication factor not enforced**: fragments may exist in < 3 BEEs (v0.3 fix).

---

## Logs

```bash
tail -f /tmp/hive_api.log        # BEE activity
tail -f /tmp/hive_embedder.log   # embeddings server
```
