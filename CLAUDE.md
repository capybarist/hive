# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

---

## Operating rule: usage docs must always match the shipped version

**Whenever the project introduces or renames anything an operator sees
or types** — env vars, service names, scripts, ports, `HIVE_MODE`
values, docker-compose commands, deployment topology — the change
**must be propagated in the same commit** (or, at worst, the same
session) to:

1. **`README.md`** — public-facing install/run/deploy section.
2. **`packages/ui/index.html`** — labels, tooltips, mode badges in the
   shipped node UI.
3. **`capybarahome` website** — the `/hive` page (`src/app/hive/page.tsx`)
   carries `installSteps`, tech-stack copy, and the version label
   tooltip. Whatever a visitor copy-pastes to bring up a node has to
   work against the current image.
4. **Shell scripts** — `hive.sh`, `queen.sh`, `start.sh` (and any
   future launcher) must agree on env-var names and `HIVE_MODE`
   defaults.
5. **`docker-compose.yml`** — service names, container names, volume
   names, env vars must match the launcher scripts.

Things that drift first when this rule is broken: capybarahome `/hive`
showing `bash hive.sh` while the README has moved to `queen.sh`; the
UI badge saying `aggregator` while `/api/status` returns `queen`; a
fresh operator following the README, hitting a "service not found"
error, and assuming the project is broken.

When in doubt, grep the repo (and `capybarahome/`) for the old name
before you decide a rename is harmless. The compatibility shims we
ship in code (e.g. `HIVE_MODE=aggregator` alias, `aggregator.sh`
deprecation wrapper, `aggregator` network alias on the queen service)
exist precisely because docs drift in the wild — they don't replace
the obligation to update the docs.

---

## Current state — v0.9.5 (productised on the v0.8 all-Node core)

The **v0.8 architecture below is still the engine** (all-Node, producer-side
vectorization, LanceDB, schema v2) — v0.9 layered productisation on top without
changing it. Per-version detail in CHANGELOG; v0.8 cutover runbook in
[`docs/V0.8-MIGRATION.md`](docs/V0.8-MIGRATION.md).

What v0.9 added on top of v0.8 (all SHIPPED):
- **Distribution**: published to npm — `@capybaralabs/hive` (full node via
  `npx`, per-package esbuild bundles, v0.8.15) and `@capybaralabs/hive-mcp`
  (MCP server: `hive_query` returns raw fragments, `hive_list_sources`). Claude
  Skill at `skills/hive-research/`.
- **Auth + HTTPS**: optional bearer-token gate on write/expensive `/api/*`
  (v0.8.7–8.12, read-only metadata stays public); HTTPS via Caddy + sslip.io
  with no domain needed (v0.8.13, direct host ports dropped).
- **Settings UI** (v0.9.0): operator panel — graphical manifest builder
  (sources/scope/policy), role prompt, first-run gate (v0.9.1–9.2; an
  unconfigured node won't extract or join any swarm — privacy gate, v0.9.3).
- **Topics** (v0.9.4): a topic = a specialised knowledge domain; Public Topics
  Registry for discovery; a queen is public-XOR-private.
- **ForagerRegistry** (v0.9.5): single source of truth for "what HIVE can
  extract" — adding a connector no longer means editing 5 disconnected places.
  Connectors: `wikipedia-en`, `arxiv`, `rss`, `common-crawl`, `pubmed` (NCBI
  E-utilities). Generic `web` is passive by design (non-deterministic crawl
  breaks corroboration). Specialized connectors first; Common Crawl is the
  arbitrary-domain backup.
- **Ops** (queen): periodic LanceDB `optimize()` compaction loop with a
  post-boot first run + OOM-survival ordering (`oom_score_adj`) — see the
  2026-06-09 disk/RAM incident in CHANGELOG.

What v0.8 is (the still-current engine), in one screen:
- **Bees embed; the queen does not.** Each bee chunks deterministically,
  embeds every chunk with `intfloat/multilingual-e5-base` (ONNX int8, 768-d)
  in-process, and **signs the vector inline** in its Hypercore fragment
  (`schema_version = 2`). The queen replicates bee cores and upserts the
  pre-computed vectors into an embedded **LanceDB** — no passage embedding,
  no transformer forward pass per fragment. It embeds only the *query*.
- **No Python, no Qdrant.** The whole stack is Node. `packages/embeddings`
  (Python) is deleted; `packages/embeddings-node` owns the embedder
  (`@huggingface/transformers`), the deterministic chunker, the fp16 vector
  codec, the `QueenIndex` (LanceDB) and the retrieval gate.
- **Retrieval gate** recalibrated for e5: `RELEVANT_SCORE = 0.82` (was 0.45
  for MiniLM). Same logic (score AND majority-keyword) + LLM grounded-verdict.
- **Fragment schema v2** is source-agnostic: `identifiers` map replaces
  `doi`/`arxiv_id`; `content_hash` (NFC + trim + collapse-ws, no lowercase)
  enables corroboration across bees that share `chunker_version`.

Key files:
- `packages/core`: `schema_v08.ts`, `fragment_v08.ts`
  (`buildSignedFragmentV08`/`verifyFragmentV08`), `content_hash.ts`,
  `knowledge_store.ts` (`save(FragmentV08)`, `watchRemoteCoreV08`,
  `watchLocalCoreV08`).
- `packages/embeddings-node`: `embedder.ts`, `chunker.ts`, `vector_codec.ts`,
  `lance_index.ts`, `queen_index.ts`, `retrieval_gate.ts`.
- `packages/api/src/api_server.ts`: instantiates `QueenIndex` for queen/hive,
  routes `/api/query` through it, pipes replicated + local cores into it.
- `packages/agent/src/autonomous_extractor.ts`: chunk → embed → sign → save.

### Open items (post-v0.8)
- **Topic-tree cleanup**: `loadTree()` / `topic_tree.json` are still the
  fallback when no manifest is published. BeeManifest `declared_sources` is the
  replacement; finish removing the topic-tree path.
- **Score-by-corroboration**: `cos_sim × log(1 + corroboration_count)` using
  the v0.8 `content_hash` corroboration signal.
- **Fragment id hygiene**: the Wikipedia adapter leaks long heading text
  (incl. `_edit_`) into chunk ids — cosmetic, worth slugging tighter.
- **Distributed model migration** (designed-in, not built): re-embed on bee
  startup from local text when the network model changes — see migration §9.

---

## Feature reference — opt-in scope partitions for multi-bee coordination (since v0.7.6, still in effect)

### v0.7.6 — Scope partitions
Adds an opt-in `partition` field per declared source so multiple bees on
the same scope can split work without overlapping. The unit of
coordination is `(source_id, partition_key)` where the partition lives
**inside** the scope — never cuts across it, so `policy=exclusive`
stays coherent.

Concretely:

- `ForagerSource.partitions(scope)` enumerates valid partitions for a
  given scope. Per-adapter:
  - **WikipediaSource**: if `scope.category_tree` is set, returns the
    immediate subcategories (live MediaWiki API query); otherwise
    falls back to alphabetical buckets `["A-G", "H-N", "O-Z"]` for
    generalist bees.
  - **ArxivSource**: if `scope.categories` includes wildcards like
    `cs.*`, expands to the curated list of cs.* leaf categories;
    otherwise returns the seven top-level arXiv groups.
  - **RssSource**: each feed URL in `scope.feeds` is its own partition.
  - **CommonCrawlSource**: each domain in `scope.domains` is a
    partition; without explicit domains, returns `["*"]` (not
    partitionable).
- `ForagerSource.isInPartition(url, scope, partition)` — coarse
  pre-filter the forager uses to drop outbound links outside the
  claimed partition under `policy=exclusive`. Wikipedia checks
  alphabetical first letter; arXiv parses the legacy ID prefix; CC
  matches the hostname; RSS compares the URL to the feed URL.
- `DeclaredSource.partition?: string` in the BeeManifest. Encoded in
  the published manifest so peers and queens see what each bee covers.
- `HIVE_PARTITION` env var — JSON map `{ source_id: partition_key }` or
  a plain string (single-source bees). Optional. Bees without it
  behave exactly as in v0.7.5.
- `autonomous_extractor.ts` uses the declared partition as the seed
  query priority — for Wikipedia, the partition (`Category:Pharmacology`)
  overrides the broader scope (`Category:Medicine`) for `seed()`. Under
  `policy=exclusive`, outbound links outside the partition are dropped
  before enqueueing.
- `ClaimRegistry` claims encoded as `<source_id>:<partition_key>` in
  the existing `topicId` field — same Hypercore, same TTL/release, just
  a richer string convention. Legacy topic claims (no `:`) coexist
  with partition claims.

What did NOT change:
- Bees without a partition declared run identically to v0.7.5
  (full scope, no coordination overhead).
- The ClaimRegistry schema on the wire — `topicId` is still a string;
  it just carries more structured content for partition-claiming bees.
- Topic-tree code paths (still used as fallback when no manifest is
  published yet). Their cleanup is v0.7.8.


---

## History

Detailed changelog of v0.7.5 through v0.6.0 (architecture migrations,
each subversion's rationale, deprecated paths, design discussions)
lives in [`docs/HIVE-HISTORY.md`](docs/HIVE-HISTORY.md) — NOT
auto-loaded into Claude context. Read it explicitly when you need
historical detail.

The user-facing CHANGELOG.md has the per-version summaries.
