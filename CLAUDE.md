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

## ⚠️ DEMO FREEZE — 2026-05-26

Product presentation today. **Production is at v0.7.6.2 (system-prompt
patch for depth) and stable**. No further code changes until after the
demo. Any backlog work resumes after.

The v0.7.6.2 patch is a single-string edit in `llm_client.ts` to fix
the "four-line answers when fragments support twenty" regression
caused by the v0.7.2.5 prompt rewrite — see CHANGELOG.

### What works for the demo
- Bee on Hetzner extracts continuously from Wikipedia.
- Queen indexes via the v0.7.5.1 batched ingest path; embedder responds.
- `/api/query` returns verified fragments with clickable source chips.
- UI: bee dashboard, queen aggregated network panel, capybarahome
  palette, conditional rendering by mode.

### Known limitations to manage during the demo

1. **Catch-up replay after queen restart (~25-30 min).** If the queen
   is restarted, it re-streams the bee's Hypercore from offset 0;
   newly-extracted articles (last hour) won't appear in `/api/query`
   until the cursor reaches the tail. **Don't restart the queen
   during or before the demo.** Fix is the v0.7.6.2 cursor-persistence
   patch on the post-demo backlog.

2. **Retrieval precision below ~0.45 score.** For obscure queries
   (specific Toronto subway lines, brand names that share words with
   indexed articles), the queen may return loosely-related fragments
   with the "In HIVE · N sources" badge even when the LLM's answer
   admits no real match. Fix is the v0.7.7 retrieval gating patch on
   the post-demo backlog. Workaround for the demo: prefer broad-topic
   questions (photosynthesis, evolution, mitochondria, SEMA
   association) where the bee has high-confidence coverage.

3. **Bee↔queen replication lag** under heavy bee output is bounded by
   the embedder's batch throughput (~10-20 k frags/min post v0.7.5.1).
   The bee currently produces faster than that during catch-up; recent
   articles appear after a delay of minutes to tens of minutes.
   Working as designed for v0.7.6; not blocking the demo.

### Post-demo immediate backlog
- **v0.7.6.2** — Cursor persistence in `${DATA_DIR}/repl_cursors/`.
  Queen resumes Hypercore stream where it left off after restart.
- **v0.7.7** — Dead-end recovery ladder + retrieval gating
  (`SHOW_THRESHOLD` and `RELEVANT_SCORE` tightened, multi-token
  keyword check).

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
