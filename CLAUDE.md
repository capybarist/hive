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
4. **Shell scripts** — `hive.sh`, `queen.sh`, `aggregator.sh` (and any
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

## Post-demo state — 2026-05-26 evening

Demo is done. Production is at v0.7.7.12 (graceful shutdown to prevent
Hypercore forks; see CHANGELOG). The v0.7.7.x line stabilized
retrieval gating, the LLM grounded-verdict badge, and a fork-recovery.

> **NEXT MAJOR: v0.8 unified migration** — all-Node stack (drop Python +
> Qdrant), `multilingual-e5-base` (ONNX int8) embeddings, **producer-side
> vectorization** (bees embed; vector signed inline in the Hypercore;
> thin queen), LanceDB, deterministic chunking, new Fragment schema. One
> coordinated hard reset. Full plan: [`docs/V0.8-MIGRATION.md`](docs/V0.8-MIGRATION.md).
> The v0.7.8/.9 items below are folded into it.

### Open items
- **v0.7.7** — Retrieval gating (raise `RELEVANT_SCORE` 0.30→0.45 in
  `query_engine.ts`, multi-token keyword check) + dead-end recovery
  ladder for queries that fall below the new threshold.
- **v0.7.8** — Remove topic-tree code paths (`loadTree()`,
  `topic_tree.json`) — superseded by BeeManifest declared_sources.
- **v0.7.9** — Score-by-corroboration (`cos_sim × log(1 +
  corroboration_count)`).
- **Discovery glitch under investigation**: on the Hetzner box,
  local bee-1 (same docker network as queen) is NOT a Hyperswarm
  peer of the queen — the queen replicates from external "ghost"
  bees discovered via DHT instead. Probably a NAT/holepunch
  topology issue with two containers behind the same host IP.
  Doesn't break the demo (the ghosts ARE valid HIVE bees with
  shared topic) but is unintuitive.

---

## Current state: v0.7.6 — opt-in scope partitions for multi-bee coordination

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
