# HIVE — Architecture & internals

Deep technical reference. The [README](../README.md) is the product overview;
this document is for operators and contributors who want the mechanics.

---

## 1. Node roles

Same binary, same Docker image. The role is chosen at runtime via `HIVE_MODE`:

| Mode | Role | Embeds passages? | Owns LanceDB? | Serves `/api/query`? | RAM |
|---|---|---|---|---|---|
| `bee` *(default)* | Producer — extract, embed, sign, append to own Hypercore | yes | no | no | ~900 MB |
| `queen` | Consumer — replicate bee cores, upsert vectors, answer queries | no (only the query) | yes | yes | ~900 MB + index |
| `hive` | Both, in one process (dev / single-machine) | yes | yes | yes | ~1 GB |

The metaphor: bees forage, the queen organises. Splitting the roles amplifies
Hypercore's single-writer pattern instead of fighting it. There is no "HIVE
Inc." middle layer — anyone can run a queen indexing whichever bees they care
about.

---

## 2. What a fact's life looks like

```
BEE (producer)                                    QUEEN (consumer)
─────────────                                     ────────────────
crawl source (Wikipedia/arXiv/RSS/CC)
   │
deterministic chunk  (chunker_version)
   │
embed each chunk     (e5-base ONNX int8, "passage: ")
   │
buildSignedFragmentV08
   │  hash = SHA-256(text + metadata + vector)
   │  signature = ed25519(hash)            vector is INLINE + signed
   │
append to own Hypercore  ──── Hyperswarm/Hypercore replication ───▶  replicate core (read-only)
                                                                       │
                                                                  verify signature + model/dim
                                                                       │
                                                                  decode fp16 vector
                                                                       │
                                                                  upsert into LanceDB  (NO embedding)
                                                                       │
client ── POST /api/query ─────────────────────────────────────▶  embed the QUERY ("query: ")
                                                                       │
                                                                  LanceDB ANN search (top-K)
                                                                       │
                                                                  retrieval gate (score ≥ 0.82 AND
                                                                    majority-keyword)
                                                                       │
                                                                  LLM synthesis + grounded-verdict
                                                                       │
client ◀──────── { answer, fragments, has_hive_data } ─────────────────┘
```

The shift from v0.7: **the queen never embeds passages.** Its per-fragment cost
is an upsert, not a transformer forward pass, so one queen can aggregate
hundreds of bees. Model migration becomes a distributed, rolling operation
(each bee re-embeds from its own local text) instead of a single giant queen
re-index — see [V0.8-MIGRATION.md](./V0.8-MIGRATION.md) §9.

---

## 3. Boot + P2P

```
Every node starts:
  → Load ed25519 identity from data/identity/node.json (created on first boot)
  → Open its Hypercore pair (fragments + claims) in a shared Corestore
  → Join Hyperswarm DHT on topic = sha256("hive-network-v0.1")

On every peer connection (all modes):
  → store.replicate(socket) opens native Hypercore replication
  → Protomux channel `hive/meta/v2` exchanges { nodeId, publicKey, coreKey, claimsCoreKey }
  → peer-meta event:
      • register peer's pubkey for ed25519 verify on receive
      • queen / hive: open peer's fragments core read-only → download
          + watchRemoteCoreV08: live stream → QueenIndex.upsertFragments
      • bee: registers the peer but does not download remote cores
```

No HTTP between two HIVE nodes anywhere since v0.6.4 — the Fastify server is for
external clients only (dashboard + `/api/query`). Cursor persistence
(`data/repl_cursors/<nodeId>.json`) lets the queen resume a remote core's
history stream instead of replaying from offset 0 on every reconnect.

---

## 4. Fragment v0.8 schema (`schema_version = 2`)

Source-agnostic, signed over text + metadata + **vector**. Full definition in
`packages/core/src/schema_v08.ts`; full rationale in
[V0.8-MIGRATION.md](./V0.8-MIGRATION.md) §3. Highlights:

- `vector`: base64(Float16Array, 768) — inline, ~2 KB/fragment.
- `content_hash`: SHA-256(NFC → trim → collapse-ws, **no lowercase**) — enables
  corroboration (two bees that share `chunker_version` produce identical
  hashes for identical content).
- `identifiers`: a `Record<string,string>` map (`{ doi, arxiv, pmid, … }`) —
  replaces the v0.7 source-specific `doi`/`arxiv_id` fields.
- `embedding_model` / `embedding_dim`: signed per fragment so a queen can route
  or reject vectors that don't match the network standard.
- `hash` covers the vector, so a bee cannot ship good text with a garbage
  vector deniably. Re-vectorizing = re-signing.

Queen-side / derived (NOT in the fragment, NOT signed): `corroboration_count`,
per-query `score`, `expires_at` (= `extracted_at` + `ttl_seconds`).

---

## 5. Embedding standard (network-wide invariant)

All bees + the queen MUST use the same model+dim or vectors aren't comparable.

- **Model:** `intfloat/multilingual-e5-base` · **Dim:** 768
- **Runtime:** ONNX int8 via `@huggingface/transformers` (transformers.js)
- **Prefixes (e5 requirement):** passages as `"passage: <text>"`, queries as
  `"query: <text>"`
- Declared in `BeeManifest.embedding_model` / `embedding_dim`.

Changing the model later = network-wide version bump + reset. Chosen now for
quality + multilingual coverage (fixes the v0.7 cross-lingual gap).

---

## 6. Retrieval gate

`packages/embeddings-node/src/retrieval_gate.ts`. Recalibrated for e5 (cosines
compress to ~0.70–0.91, vs MiniLM's ~0.20–0.45):

- `RELEVANT_SCORE = 0.82`
- A hit is relevant iff `score ≥ 0.82` **AND** a majority of meaningful query
  tokens appear (word-boundary, punctuation-stripped, stop-words removed).
- The LLM **grounded-verdict** (`[[NO_MATCH]]` sentinel) is the final word on
  the "Verified by HIVE" badge — it catches topically-near-but-wrong hits the
  gate lets through.

---

## 7. Source-driven extraction (BeeManifest)

Each bee publishes a self-declared `BeeManifest` to its Hyperbee at startup:
which sources it covers (`wikipedia-en`, `arxiv`, `rss`, `common-crawl-*`),
a `scope` within each source, a `policy` (`drift-ok` | `exclusive`), and an
optional `partition` for multi-bee coordination. Queens read manifests when
they replicate a core and expose `GET /api/directory`. No central source list
lives in the repo.

All source adapters implement the same `ForagerSource` interface (`seed`,
`fetch`, `normalize`, `owns`, `partitions`, `isInPartition`). The generic
forager owns queue + visited + dedup + budgeting + claims. Adding a source =
one file.

### Scope partitions (v0.7.6, still current)

The coordination unit is `(source_id, partition_key)` where the partition
lives **inside** the scope — so three Medicine bees can pick Pharmacology /
Surgery / Oncology and never overlap while staying `exclusive`. Opt-in via
`HIVE_PARTITION`; bees without it run full-scope.

---

## 8. Durability model

A queen does two things with each bee it follows: keeps a full read-replica of
the bee's Hypercore on disk (signed, append-only, durable) and upserts new
fragments into LanceDB as a derived index. **The cores are the source of
truth; LanceDB is rebuildable from them.** If every queen disappeared, bees
still hold their own signed cores; one operator restarting a queen rebuilds the
index from scratch.

---

## 9. Repo layout

```
packages/
  core/            — KnowledgeStore (Hypercore+Hyperbee), P2P node, PeerRegistry,
                      ClaimRegistry, ed25519 identity, Fragment v0.8 schema +
                      buildSignedFragmentV08 + content_hash, topic assignment
  agent/           — Autonomous extractor + crawl queue + ForagerSources
  embeddings-node/ — e5-base ONNX embedder, deterministic chunker, fp16 codec,
                      QueenIndex (LanceDB), retrieval gate
  api/             — Fastify :8080 + UI server, runtime-env loader, version badge
  ui/              — Web UI (vanilla HTML/JS)

data/
  topic_tree.json    — committed taxonomy (95 topics, 9 domains)
  identity/          — runtime ed25519 keypair per node (gitignored)
  corestore/         — Hypercore data: fragments + claims cores (gitignored)
  lancedb/           — queen vector index (gitignored)
  repl_cursors/      — last-processed Hyperbee seq per remote peer (gitignored)
  crawl_queue.jsonl  — persistent BFS queue of titles to fetch (gitignored)
```

---

## 10. Configuration reference

```bash
# Role
HIVE_MODE=bee                # bee | queen | hive (default: bee)

# LLM (queen/hive only — bee skips it). Canonical queen names in v0.8:
QUEEN_LLM_PROVIDER=groq      # groq | gemini | claude | openai | ollama
QUEEN_LLM_API_KEY=your_key   # AGGREGATOR_LLM_* still works as a fallback
# Bee/hive extraction reuses LLM_PROVIDER / LLM_API_KEY (optional; extraction is LLM-free)

HIVE_PORT=8080               # single port per node (embedder is in-process)
HIVE_DATA_DIR=/path/to/data

# Source declaration (BeeManifest)
HIVE_SOURCES=wikipedia-en           # comma-separated: wikipedia-en, arxiv, rss, common-crawl
HIVE_POLICY=drift-ok                # drift-ok | exclusive
HIVE_SCOPE='{"category_tree":"Category:Medicine"}'
HIVE_LANGUAGES=en
HIVE_BEE_REPLICATE=all              # all | neighbors | none

# Scope partitioning (opt-in multi-bee coordination)
HIVE_PARTITION='Category:Pharmacology'
# OR per-source: HIVE_PARTITION='{"wikipedia-en":"Category:Pharmacology","arxiv":"cs.LG"}'

# Extraction tuning
HIVE_EXTRACT_MAX_FRAGMENTS=9        # fragments per cycle, split across topics
HIVE_EXTRACT_INTERVAL_MS=60000      # pause between cycles
HIVE_EXTRACT_BUDGET_MINUTES=20      # wall-clock budget per cycle
```

**Bee throughput** depends only on `MAX_FRAGMENTS`, `INTERVAL_MS`, the source's
response time, and local embedding speed — no LLM in the loop.

**Query latency** (queen `/api/query`) is dominated by the LLM synthesis call:
Groq ~1–2 s, Gemini Flash Lite ~2–3 s, OpenAI/Claude ~2–4 s, Ollama
qwen2.5:1.5b ~15–30 s.

---

## 11. Logs

```bash
tail -f /tmp/hive_api.log     # node activity (extract + embed + sign, or queen sync + upserts)
tail -f /tmp/hive_queen.log   # queen P2P + sync + LanceDB upserts
```

Docker: `docker compose logs -f <service>` (`bee-1`, `queen`, `caddy`).
