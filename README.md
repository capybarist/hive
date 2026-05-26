# HIVE — Heuristic Intelligent Vector Extraction

**A decentralized, verifiable knowledge base built for LLMs.**  
A P2P network of autonomous BEEs that extract, sign, and sync knowledge from the open web.

> *What Wikipedia is for humans — but for machines.*

→ **[Read the Manifesto](./MANIFESTO.md)** — why this exists and where it's going.

---

## Quick start

The recommended deployment is the **full stack via Docker Compose** —
that gives you a BEE, a queen, Qdrant, and a Caddy reverse proxy all
wired up. You only need an LLM API key.

### 1. Full VPS stack (recommended)

```bash
git clone https://github.com/capybarist/hive.git && cd hive
cp .env.example .env
nano .env                                # paste your LLM_API_KEY
docker compose up -d                     # caddy + qdrant + bee-1 + queen
```

That's it. Open:
- `http://<your-ip>` → queen UI (via Caddy)
- `http://<your-ip>:8080` → bee-1 dashboard (extraction activity)
- `http://<your-ip>:8090` → queen dashboard (Qdrant-backed queries)

> 🔁 **Upgrading from v0.6.x?** Just `git pull && docker compose pull
> && docker compose up -d`. The service rename `aggregator` → `queen`
> reuses the existing `aggregator-data` volume — fragments survive.
> See [CHANGELOG.md](./CHANGELOG.md#070--2026-05-22--bee--queen-role-split)
> for the full migration table.

Default provider is **Gemini Flash Lite** (free tier covers a 4 GB VPS
with 1–2 BEEs easily). Get a key in <2 min at
[aistudio.google.com](https://aistudio.google.com).

#### Add a second BEE

> ⚠️  **Still not recommended on a 4 GB VPS in v0.7.0.** The bee
> container today carries an embedder + HNSW + sentence-transformers
> model (~700 MB resident) — the same as in v0.6.x. v0.7.0 only ships
> the role split scaffolding; HNSW is dropped from bees in v0.7.x once
> the producer-only mode actually stops talking to the embedder, at
> which point 2-4 bees fit comfortably on a 4 GB box. Until then,
> use 8 GB+ VPS for multi-bee deployments.

```bash
docker compose --profile bee-2 up -d   # 8 GB+ VPS only on v0.6.x
```

Bee-2 listens on `:8081` and auto-coordinates topics with bee-1 over
the Hyperswarm P2P network.

#### Run a fully-local LLM (no cloud)

Ollama is **opt-in** since v0.6.4.2 — the default LLM is Gemini, which
needs a key but covers the free tier with room to spare. If you really
want zero-cloud:

```bash
docker compose --profile ollama up -d    # pulls qwen2.5:1.5b on first start
# then in .env: LLM_PROVIDER=ollama   LLM_MODEL=qwen2.5:1.5b
```

The `ollama-init` container pulls `qwen2.5:1.5b` (~950 MB) automatically
on first start. If it fails, pull manually:

```bash
docker exec hive-ollama ollama pull qwen2.5:1.5b
```

For a larger (slower, more accurate) model:

```bash
# In .env:
OLLAMA_MODEL=qwen2.5:3b   # ~1.9 GB — needs 6 GB+ VPS
docker compose up -d --force-recreate ollama-init
```

Ollama adds ~2 GB of RAM and is much slower (~250 frag/h on CPU vs
several thousand/h on cloud). Use it only if you specifically want
zero-cloud operation. RAM guide: `qwen2.5:1.5b` ~950 MB → safe on 4 GB
VPS, `qwen2.5:3b` ~1.9 GB → needs 6 GB+.

### 2. Single node from source

The minimum path — runs a **BEE** (producer-only, ~150 MB, no embedder,
no LLM, no `/api/query`):

```bash
git clone https://github.com/capybarist/hive.git && cd hive
npm install
bash hive.sh                       # bee on :8080 — no .env needed
```

A bee extracts knowledge entirely without an LLM (since v0.6.1 the
crawl loop is purely mechanical: drain queue → `wikipedia_fetch`
verbatim → sign → append to Hypercore). It joins the Hyperswarm DHT,
claims topics from `data/topic_tree.json`, fetches articles, and
replicates with peers — all on day one, no API key required.

For **hive** (all-in-one with `/api/query`) or **queen** (query-only),
you need Python + an embedder + an LLM key (the LLM is used **only**
to synthesise natural-language answers from verified fragments at
query time):

```bash
pip install -r packages/embeddings/requirements.txt    # only for hive/queen
echo "LLM_PROVIDER=gemini"        > .env
echo "LLM_API_KEY=AIza_your_key" >> .env

HIVE_MODE=hive bash hive.sh                            # extractor + queries (dev)
bash queen.sh                                          # consumer-only with Qdrant (production)
```

### 3. Launch modes

| Script | `HIVE_MODE` | What it runs | When to use |
|---|---|---|---|
| `bash hive.sh` *(default)* | `bee` | Extractor + own Hypercore. No embedder, no LLM, no `/api/query`. | Most people. Contribute to the network. |
| `HIVE_MODE=hive bash hive.sh` | `hive` | Extractor + embedder + LLM + `/api/query`, all in one process. | Dev, single-machine demos, "I want it all". |
| `bash queen.sh` | `queen` | Embedder + Qdrant + LLM + `/api/query`. No extractor. | Public query endpoint, vertical-private deployments. |

The Docker Compose stack runs one bee + one queen by default (see the
[Quick start](#1-full-vps-stack-recommended) above); the launch scripts
are for running directly on a host without Docker.

### 4. Dev mode — 3 nodes on one machine

```bash
bash start.sh                            # 3 nodes on :8080 :8081 :8082
bash start.sh --clean                    # wipe data and restart
bash stop.sh --force                     # kill all processes
```

Useful for testing P2P + replication locally before deploying.

---

## LLM Providers

HIVE uses an LLM in exactly **one place**: **query synthesis on the
queen**. When a client hits `/api/query`, the queen takes the top
verified fragments returned by vector search and asks the LLM to weave
them into a natural-language answer with citations. That's it.

**Bees never call an LLM.** Since v0.6.1 the extractor is a purely
mechanical loop (drain queue → `wikipedia_fetch` verbatim → sign →
append). Topic assignment comes from `data/topic_tree.json` + hash-
based round-robin among peers — no LLM, no API key needed for bee
mode.

The embeddings model (`all-MiniLM-L6-v2`, ~80 MB) runs locally on
queens and is not an LLM.

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
# Role (since v0.7.0)
HIVE_MODE=bee                # bee | queen | hive (default: bee)

# Provider (used by queen and hive — bee skips LLM)
LLM_PROVIDER=groq            # groq | gemini | claude | openai | ollama
LLM_API_KEY=your_key         # not needed for ollama or bee

# Queen-specific LLM (Docker Compose path — lets the queen run a fast
# cloud LLM for synthesis while bees use whatever they want for extraction)
AGGREGATOR_LLM_PROVIDER=groq         # variable name kept for v0.6 compat; renames to QUEEN_LLM_PROVIDER in v0.8
AGGREGATOR_LLM_API_KEY=your_groq_key
AGGREGATOR_LLM_MODEL=                # optional override

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

# Source declaration (v0.7.3 BeeManifest)
HIVE_SOURCES=wikipedia-en           # comma-separated: wikipedia-en, arxiv, rss, web, common-crawl
HIVE_POLICY=drift-ok                # drift-ok (follow all links) | exclusive (stay in scope)
HIVE_SCOPE='{"category_tree":"Category:Medicine"}'  # JSON scope — optional
HIVE_BEE_REPLICATE=all              # all | neighbors | none (peer-to-peer replication)
HIVE_LANGUAGES=en                   # comma-separated BCP-47 language codes

# Scope partitioning (v0.7.6 — opt-in coordination for multi-bee deployments)
HIVE_PARTITION='Category:Pharmacology'  # plain string when there's only one source
# OR per-source: HIVE_PARTITION='{"wikipedia-en":"Category:Pharmacology","arxiv":"cs.LG"}'
# Partition lives INSIDE the declared scope — three Medicine bees can pick
# Pharmacology / Surgery / Oncology and never overlap, while staying exclusive.

# Extraction tuning
HIVE_EXTRACT_MAX_FRAGMENTS=9        # fragments per cycle, split across claimed topics
HIVE_EXTRACT_INTERVAL_MS=60000      # pause between cycles (1 min = near-continuous)
HIVE_EXTRACT_BUDGET_MINUTES=20      # wall-clock budget per cycle, divided across topics
```

**Bee throughput** depends only on `MAX_FRAGMENTS`, `INTERVAL_MS`, and
Wikipedia's response time — there's no LLM in the loop. With the
defaults (9 fragments/cycle, 60 s cycle) a healthy bee produces
~13 000 fragments/day. Lower `INTERVAL_MS` for more, raise it to be
gentler on the source.

**Query latency** (queen `/api/query`) is dominated by the LLM
synthesis call:

| Provider | Typical query latency | Notes |
|---|---|---|
| Groq | ~1–2 s | Free 100K tok/day. Best speed/quality trade-off. |
| Gemini Flash Lite | ~2–3 s | Generous free tier. Default. |
| OpenAI / Claude | ~2–4 s | Paid. Highest quality. |
| Ollama qwen2.5:1.5b | ~15–30 s | Free, local, slow. Useful for fully-offline demos. |

---

## Queen node (was: aggregator)

A queen connects to all BEEs in the network, replicates their Hypercore data, and indexes everything into Qdrant for scalable vector search. It doesn't extract — it consumes. (Renamed from "aggregator" in v0.7.0 to keep the bee metaphor consistent: bees forage, queens organise.)

```bash
# Requires Docker for Qdrant (started automatically)
bash queen.sh

# Or with explicit Qdrant URL
QDRANT_URL=http://localhost:6333 bash queen.sh
```

The queen's Qdrant dashboard is available at `http://localhost:6333/dashboard`.

Any node can become a queen — it will automatically sync all existing fragments from peers via Hypercore replication.

> ℹ️  `bash aggregator.sh` still works in v0.7.0: it's now a wrapper
> that prints a deprecation notice and execs `queen.sh`. The wrapper
> goes away in v0.8.

---

## How it works

```
Every node (bee | queen | hive) starts:
  → Loads ed25519 identity from data/identity/node.json (created on first boot)
  → Opens its Hypercore pair (fragments + claims) in a shared Corestore
  → Joins Hyperswarm DHT on topic = sha256("hive-network-v0.1")

On every peer connection (all modes):
  → store.replicate(socket) opens native Hypercore replication
  → Protomux channel `hive/meta/v2` exchanges:
       { nodeId, publicKey, coreKey, claimsCoreKey }
  → peer-meta event:
      • register peer's pubkey for ed25519 verify on receive
      • queen / hive: open peer's fragments core read-only → download
                        + watchRemoteCore: live stream → verify sig → POST to embedder
      • bee: registers the peer but does not download remote cores (v0.7)

Bee extraction loop (every HIVE_EXTRACT_INTERVAL_MS) — NO LLM:
  → Dequeue 5 titles from crawl_queue.jsonl
  → For each: wikipedia_fetch verbatim → onFragment per H2/H3
       → store.get(id) — check Hypercore for existing fragment
            → Fresh (within TTL — wiki 7d, rss 24h, arxiv 30d): skip
            → Stale: supersede() — old marked, new appended (still signed)
            → New: save() — signed and appended to own Hypercore
  → Aux fetch by rule: news topics → rss_fetch; science → arxiv_search

Queen query path (/api/query) — the ONLY LLM call in HIVE:
  → embedder.embed(question) → top-K vectors from Qdrant
  → fragments = fetch text for each match (already signed when ingested)
  → llm.generate(system_prompt, "fragments + question") → natural-language answer
  → return { answer, sources: [{ url, title, source }, ...] }

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
  embeddings/  — Python: all-MiniLM-L6-v2 → HNSW (hive mode) or Qdrant (queens). v0.7 bees skip the embedder entirely.
  api/         — Fastify :8080 + UI server, runtime-env loader, version badge
  ui/          — Web UI (vanilla HTML/JS, light theme, version + mode chips)

data/
  topic_tree.json    — committed taxonomy (95 topics, 9 domains)
  identity/          — runtime ed25519 keypair per node (gitignored)
  corestore/         — Hypercore data: fragments + claims cores (gitignored)
  repl_cursors/      — last-processed Hyperbee seq per remote peer
                       (queen-side, since v0.7.6.4; resume cursor for
                       watchRemoteCore — safe to delete, costs a one-time
                       full replay)
  crawl_queue.jsonl  — persistent BFS queue of titles to fetch
  .runtime.env       — UI-set LLM overrides (since v0.6.4.3)
```

---

## v0.7 architecture

v0.7 brings two architectural changes. **Section 1 is shipped in
v0.7.0**; sections 2-5 land progressively in v0.7.1+. See
[CHANGELOG.md](./CHANGELOG.md) for what's released today and
[CLAUDE.md](./CLAUDE.md) for the detailed roadmap.

### 1. Role split: `bee` / `queen` / `hive` *(shipped in v0.7.0)*

Same binary, same Docker image, mode selected at runtime via the
`HIVE_MODE` env var:

| Mode | Role | Who runs it |
|------|------|-------------|
| `HIVE_MODE=bee` *(default since v0.7.0.6)* | **Producer** — extracts, signs, propagates its Hypercore. No embedder, no LLM, no query API. ~150 MB. | Most operators. Contribute to the network. Raspberry-Pi-friendly. |
| `HIVE_MODE=queen` (renamed from aggregator) | **Consumer / indexer** — replicates every bee's Hypercore into Qdrant, serves `/api/query` with LLM synthesis. ~600 MB. | Anyone who wants to query (public services, private corporate verticals). |
| `HIVE_MODE=hive` | Both in one process. | Devs, single-machine quickstart, advanced users who want extractor + queries in one. |

The metaphor stays: bees forage, the queen organises. Splitting roles
amplifies Hypercore's single-writer pattern — it does not break P2P.
No "HIVE Inc." middle layer; anyone can run their own queen indexing
whichever bees they care about.

### 2. Source-driven extraction (replaces topic-driven)

The v0.6 `topic_tree.json` was a static taxonomy committed in the repo
— a soft point of centralisation. v0.7 replaces it with **per-BEE
source declarations**:

Each BEE publishes a self-declared **BeeManifest** to its Hyperbee at
startup, listing which sources it covers (`wikipedia-en`, `arxiv`,
`common-crawl-2026-04` …). Queens read manifests when they replicate a
core and expose `GET /api/directory` — a live view of all known BEE
declarations. No central source list lives in the repo.

```
GET /api/directory          → all known BeeManifests (queen: all peers; bee: self only)
GET /api/status             → node health, mode, version, peer count
GET /api/topics             → Knowledge Network panel data (fragment counts per node)
GET /api/crawl              → forager state (queue, visited, next titles)  [bee/hive]
GET /api/query?q=…          → vector search + LLM synthesis                [queen/hive]
```

All source adapters implement the same `ForagerSource` interface
(`seed`, `fetch`, `normalize`, `owns`). The generic forager owns
queue + visited + dedup + budgeting + claims. Adding a new source =
one file.

Open-web extraction goes through **Common Crawl** (publicly hosted,
reproducible, snapshot-versioned). Google / Bing / proprietary search
are explicitly out of scope: non-reproducible, ToS-hostile,
recentralising.

The shift in framing:

- **v0.6:** *a P2P network of BEEs that extract from configured fetch tools, organised by a shared topic taxonomy.*
- **v0.7+:** *a P2P network of BEEs that extract from objectively-identifiable public sources they self-declare, organised by what each BEE chose to cover.*

Closer to what HIVE has always wanted to be — Wikipedia for machines —
without the last vestige of editorial centralisation.

### 3. Bee specialisation: scope + policy + recovery

A BEE's manifest can declare a **scope** within each source (Wikipedia
`Category:Medicine` subtree; arXiv `q-bio.QM`; a list of domains in
Common Crawl). The `policy` field controls what the forager does with
out-of-scope links it discovers:

- `"exclusive"` — drop them. Specialist bees stay focused.
- `"drift-ok"` — follow them. Reproduces v0.6 BFS-everything behaviour.

When a specialist bee exhausts its scope, the forager runs an
automatic recovery ladder: **expand scope → rotate source → relax
policy → announce exhausted**. A focused bee never sits idle silently.

### 4. Bee replication topology (opt-in)

Default `HIVE_BEE_REPLICATE=neighbors` — a bee only replicates peers
whose declared scope overlaps with its own. `none` (lightest) and
`all` (v0.6.4 behaviour) are also valid. Queens always replicate every
bee they index, so network-level durability does not depend on
bee↔bee replication — that is an extra resilience bonus.

### 5. Queens are durability nodes, not just query nodes

A queen does two things with each bee it follows: keeps a full
**read-replica of the bee's Hypercore** on disk (signed,
append-only, durable) and **indexes new fragments into Qdrant** as a
derived vector index. Qdrant is rebuildable from the cores; the cores
are the source of truth. If every queen disappeared, bees still hold
their own signed cores; one operator restarting a queen rebuilds the
index from scratch.

---

## Logs

```bash
tail -f /tmp/hive_api_bee-1.log   # BEE-1 activity
tail -f /tmp/hive_embedder.log    # queen embedder
tail -f /tmp/hive_queen.log       # queen P2P + sync (was: hive_aggregator.log)
```

For Docker deployments use `docker compose logs -f <service>`
(`bee-1`, `queen`, `qdrant`, `caddy`).

---

## License

BUSL-1.1 — free to use non-commercially. Converts to MIT after 4 years.  
See [LICENSE](./LICENSE) and [MANIFESTO.md](./MANIFESTO.md).
