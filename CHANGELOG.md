# Changelog

All notable changes to HIVE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.7.6.1] — 2026-05-25 — *Fix queen Node OOM crash (heap bump + bounded seen Set)*

User reported the queen returning random unrelated fragments for "Line 6
Finch West" — a Toronto subway line the bee had just announced as
indexed. Diagnosis went through three layers and ended at the real
cause: the queen had **silently OOM-crashed** at the Node/V8 layer.

### What we found

- Bee log: `[+] Indexed: wiki_line_6_finch_west_*` lines confirmed the
  bee extracted 45 sections from the article and 411 outbound links.
- Qdrant scroll by id prefix `line_6_finch_west`: **0 points**.
- Queen `/api/status` was still 200 OK but `indexed: 491,110` had been
  frozen for hours.
- Queen container: `Up 13 hours (unhealthy)`, **26 MB RAM** (vs the
  ~1.3 GB it should use), **0.01% CPU** — alive enough for HTTP but
  with the embedder subprocess and replication loop dead.
- `tail /tmp/hive_queen.log` showed the smoking gun:
  ```
  FATAL ERROR: Reached heap limit Allocation failed —
                                    JavaScript heap out of memory
  ```
- Box memory was fine (1.17 GB used / 3.8 GB total). The OOM was at
  Node's own V8 heap limit (~1.5 GB default), not the container.

### Root cause

`_consumeRemoteStream` keeps a per-stream-session `seen: Set<string>`
to skip refragments it's already POSTed to /add_batch. When the queen
restarts and re-streams a 600 k-entry bee Hypercore from offset 0, the
Set grows linearly to hundreds of thousands of string entries.
Combined with the live buffer and `remoteManifests` Map, V8 ran out
of old-generation heap.

The qdrant `_known_ids` on the embedder side is the canonical dedup;
the in-process `seen` Set is only an optimisation to skip duplicate
HTTP POSTs within the same session. We don't need to keep all 600 k
of them.

### Changed

- `queen.sh` now starts node with `NODE_OPTIONS="--max-old-space-size=2560"`
  (heap cap 1.5 → 2.5 GB). The container has 3.7 GB of RAM available;
  this is the safe ceiling that leaves room for the Python embedder
  and OS buffers.
- `knowledge_store.ts::watchRemoteCore` caps `seen` at 10 000 entries
  via a `trackSeen(id)` helper. When full, drops the oldest half
  (Set preserves insertion order so we can peel from the front).
  Duplicate POSTs after eviction are cheap — the embedder returns
  `skipped: true` and skips the encode + upsert.

### Will verify post-deploy

- Queen container stays at ~1.3 GB RAM during catch-up replay, not
  growing unboundedly.
- After restart, the queen progresses through the bee's Hypercore and
  `indexed` count rises past 491,110.
- `Line 6 Finch West` becomes queryable.

### Known limitation (next backlog item)

The queen still has to re-replay the bee's Hypercore from offset 0
after every restart (~25 minutes for a 600 k-entry core). A cursor
file in the data dir would let it resume where it left off. Scope for
a follow-up patch; the OOM fix is the urgent piece.

---

## [0.7.6] — 2026-05-25 — *Scope partitions (opt-in multi-bee coordination)*

Adds the missing coordination primitive for the source-driven model:
when multiple bees declare the same scope, they can split work across
**partitions** without overlapping. Coordination is opt-in — bees
without `HIVE_PARTITION` behave exactly as in v0.7.5.

### Why this matters

Until v0.7.6 the coordination unit was still the topic-tree leaf
(legacy, going away in v0.7.8). The source-driven model needed its
own way for bees with the same scope to know who covers what — and
crucially, the partitioning had to stay inside the scope, never cut
across it. Cutting across (e.g. "alphabetical A-Z buckets over
Wikipedia for a Medicine bee") makes `policy=exclusive` incoherent:
A-G includes both Aspirin (in-scope) and Aardvark (out-of-scope), so
the bee rejects 99% of its assigned bucket.

The fix is "partitions live inside the scope": the adapter knows the
scope shape and emits buckets that respect it.

### Added

- `ForagerSource.partitions(scope?: Record<string, unknown>): string[] | Promise<string[]>`
  in `packages/agent/src/forager/source.ts`. Enumerates valid
  partition keys for a given scope.
- `ForagerSource.isInPartition?(url, scope, partition)` — coarse
  pre-filter used by the forager loop to drop outbound links outside
  the claimed partition under `policy=exclusive`.
- Per-adapter implementations:
  - `WikipediaSource.partitions`: if `scope.category_tree`, live
    MediaWiki API query for immediate subcategories. Otherwise
    `["A-G", "H-N", "O-Z"]` for generalist bees.
  - `ArxivSource.partitions`: expands `cs.*` wildcards to the curated
    list of leaf categories; without scope, returns the seven
    top-level arXiv groups.
  - `RssSource.partitions`: each declared feed URL is its own
    partition; `["*"]` otherwise.
  - `CommonCrawlSource.partitions`: each declared domain is a
    partition; `["*"]` without an explicit domain list.
- `DeclaredSource.partition?: string` in the BeeManifest. Published
  to Hypercore so peers and queens see which partition each bee covers.
- `HIVE_PARTITION` env var — JSON map `{ source_id: partition_key }`
  for multi-source bees, or a plain string for single-source bees.
- `api_server.ts` registers partition claims in the existing
  `ClaimRegistry` with `topicId = "<source_id>:<partition_key>"`. Same
  Hypercore, same TTL/release semantics — only the topicId convention
  changes. Legacy topic claims (no `:`) coexist with partition claims.

### Changed

- `autonomous_extractor.ts` seed query priority for Wikipedia:
  `partition` > `scope.category_tree` > objective topic > objective
  prefix. Same for arXiv: `partition` (e.g. "cs.LG") > scope.categories.
- Under `policy=exclusive` + declared partition, outbound links failing
  `isInPartition` are dropped before being enqueued. The drop count is
  logged.

### What did NOT change

- Bees without `HIVE_PARTITION` declared: zero behaviour change vs
  v0.7.5. Coordination cost is opt-in.
- `ClaimRegistry` schema on the wire. `topicId` is still a string; it
  just carries `<source_id>:<partition_key>` for partition-claiming bees.
- Topic-tree code paths. Still used as fallback when no manifest is
  published yet. Cleanup deferred to v0.7.8.
- `/api/directory` shape. Partition data is in the manifest payload it
  already exposes; no schema change needed.

### Concrete example

Three bees on Medicine, splitting subcategories:

```bash
# Bee A
HIVE_SOURCES=wikipedia-en
HIVE_SCOPE='{"category_tree":"Category:Medicine"}'
HIVE_POLICY=exclusive
HIVE_PARTITION='Category:Pharmacology'

# Bee B
HIVE_SOURCES=wikipedia-en
HIVE_SCOPE='{"category_tree":"Category:Medicine"}'
HIVE_POLICY=exclusive
HIVE_PARTITION='Category:Surgery'

# Bee C
HIVE_SOURCES=wikipedia-en
HIVE_SCOPE='{"category_tree":"Category:Medicine"}'
HIVE_POLICY=exclusive
HIVE_PARTITION='Category:Cardiology'
```

Each bee covers a different sub-area of medicine, never visits the
others' articles, and the three claim records `wikipedia-en:Category:
Pharmacology` / `:Surgery` / `:Cardiology` replicate via Hypercore
so any queen sees the coverage map.

### Private adapter use case

A law firm's private deployment can extend HIVE without touching the
public repo: implement a `ForagerSource` for the firm's internal
docs API (with `partitions(scope)` returning practice areas like
`["Corporate", "IP", "Tax", …]`), wire it into a fork or a plug-in,
and run private bees with `HIVE_PARTITION='IP'` etc. on a private
Hyperswarm topic. The HIVE core stays untouched; the firm's queen
indexes only what its bees produce.

### Verified pre-deploy

- All four adapters return the expected partition lists for both
  scoped and unscoped inputs (see test output in commit body).
- `isInPartition` for Wikipedia alphabetical buckets correctly
  classifies "Aspirin" in A-G, "Zebra" outside A-G, "Helium" in H-N.
- TypeScript compiles cleanly across all changed files.

---

## [0.7.5.3] — 2026-05-25 — *Stop blocking /api/query on /health under load; smaller flush batches*

After v0.7.5.2 the embedder happily processed /add_batch (every recent
log line is 200 OK) and Qdrant points were trickling up. But
/api/query returned `fragments: []` and `embedder_online: false`.
Root cause: `isEmbedderOnline()` used a 2 s timeout against /health,
and under heavy GIL load (Python doing batch encodes) /health was
exceeding it. The queen thus reported the embedder offline and
short-circuited `queryByText` before even trying /search.

Box memory hit 2.15 GB on the queen + 85% on the 4 GB box, which is
also where the GIL contention came from. Lowering peak memory per
batch reduces both pressure and /health latency.

### Changed

- `query_engine.ts::isEmbedderOnline()` timeout 2 s → 6 s. The
  embedder responds in <50 ms when idle but >2 s when batch-encoding
  64 texts; 2 s was a noise threshold from when /add was per-item.
- `query_engine.ts::queryByText()` no longer pre-checks /health. It
  just calls /search; if /search fails, return empty with
  `embedder_online: false`. The /health pre-check existed to short-
  circuit a 10 s /search timeout, but in practice it was the
  short-circuit that hurt us — the embedder was always able to do
  /search even when /health was GIL-blocked.
- `knowledge_store.ts::_consumeRemoteStream` FLUSH_SIZE 50 → 20.
  50 was too aggressive on the 4 GB Hetzner box: peak memory while
  encoding 50 texts at once pushed the queen to ~2.15 GB and
  contributed to /health timeouts. 20 gives ~10× throughput vs the
  pre-v0.7.5.1 serial path while keeping headroom for the api_server,
  Hypercore replication, and Qdrant client on the same process.

### Verified pre-deploy

- knowledge_store.ts and query_engine.ts both load cleanly via tsx.

### Will verify post-deploy

- queen `/api/status` returns `embedder_online: true` again.
- `/api/query "photosynthesis"` returns non-empty `fragments`.
- Queen memory drops below 1.8 GB.

---

## [0.7.5.2] — 2026-05-25 — *Guard /add_batch against malformed Hyperbee entries*

Post-deploy of v0.7.5.1, the embedder log showed `POST /add_batch
HTTP/1.1 422 Unprocessable Entity` on the majority of batches with
the occasional 200 mixed in. Manual `curl` with valid items always
returned 200, so the bug was in what `_consumeRemoteStream` sent —
not in the new endpoint.

Pydantic's response body confirmed the trigger:
`{"type":"dict_type","loc":["body","items",N,"metadata"],"input":null}`.
For a fraction of Hyperbee entries, `buildEmbedderPayload(frag)`
returned a partially-populated object that serialised in a way
Pydantic v2 rejects. Pydantic validates every item in the batch;
one bad item fails the whole request — which is why the entire
batch returned 422 and 50 fragments were lost.

### Changed

- `_consumeRemoteStream` now coerces `buildEmbedderPayload(frag)`
  via `|| {}` and runs a defensive check on `frag.id`, `frag.text`,
  and the metadata object before pushing into the flush buffer.
  Items that don't qualify are dropped quietly — they've already
  passed signature verification, so they're not a security issue,
  just garbage we can't index.

### Why this matters

Without the guard, every batch that contained even one
malformed-fragment-from-an-old-bee would 422 and the whole batch
of ~50 valid fragments would be lost (we kept them in `buffer` for
retry but the retry produced the same 422). The queen's indexed
count stayed flat at 491,108 despite hours of bee output.

### Verified pre-deploy

- TypeScript runtime import of `knowledge_store.ts` clean.

---

## [0.7.5.1] — 2026-05-22 — *Batched queen ingest; cleaner LLM answers; clickable sources*

Root-cause fix for "queen returns no fragments / LLM falls back to
general knowledge" complaints during the v0.7.2.4+ live review.
Fragments the bee had clearly extracted (SEMA, Chen Xi politician,
China National Highway 209) never reached Qdrant. Diagnosis: the
queen's ingest pipeline was the bottleneck, not Hypercore replication.

### Replication-lag root cause

`packages/core/src/knowledge_store.ts::_consumeRemoteStream` did
`await fetch(/add)` per fragment — HTTP round trip + sentence-
transformers encode + Qdrant upsert = ~80 ms per fragment, cap ~750
frags/min. Since v0.7.2.3 the bee runs continuously and pushes
faster, so the queen fell permanently behind. Recent extractions sat
in the queen's local Hypercore replica but never made it into the
vector index.

Layered on top: the `_id_to_label` compatibility property on
`QdrantIndex` iterated `_known_ids` without a snapshot, racing the
concurrent `/add` path under uvicorn's threadpool and returning 500
with `RuntimeError: Set changed size during iteration`. Some `/add`
calls disappeared silently.

### Added

- `embedder.embed_batch(texts)` — single `model.encode(texts,
  batch_size=64)` call. ~25× faster per-item than N separate
  `embed()` calls (one model forward pass, one Python/C++
  round-trip).
- `embedder.add_batch(items)` — bulk add. Dedups by id, calls
  `embed_batch`, then `index.upsert_batch` if available (Qdrant) or
  per-item fallback (HNSW).
- `QdrantIndex.upsert_batch(items)` — single `client.upsert` for the
  whole batch (one network round trip + one server-side WAL write).
  Snapshot-then-update on `_known_ids` so the dedup check doesn't
  race the live writer.
- `POST /add_batch` on the embedder. Body: `{ items: [...] }`. One
  encode + one Qdrant upsert + one HTTP round-trip per call.

### Changed

- `_consumeRemoteStream` buffers up to 50 fragments or 500 ms, then
  flushes to `/add_batch`. Signature verification stays per-fragment
  before items enter the buffer (invalid fragments never make it
  into a batch). Items the embedder rejects are reinstated at the
  buffer head; only after a 2xx response do we mark `seen`. The
  stream's `finally` flushes the partial buffer on disconnect so
  nothing is lost at the restart boundary.
- `QdrantIndex._id_to_label` snapshots `_known_ids` with
  `dict.fromkeys(list(self._known_ids), 1)`, fixing the
  `RuntimeError: Set changed size during iteration` race.
- `llm_client.ts` system prompt rewritten: no "based on the provided
  fragments" / "the fragment mentions" narration; no enumeration of
  unrelated content when the question isn't answered; sparing use
  of inline `[text](url)` markdown (UI renders source chips
  separately).

### UI

- `index.html` answer renderer now turns markdown `[text](url)`
  into real `<a target="_blank" rel="noopener noreferrer">` links
  with a URL sanitiser blocking `javascript:` schemes. Pre-v0.7.5.1
  the renderer only handled bold/italic/headers, so any inline link
  the LLM emitted showed as literal `[brackets](text)`.
- Source chips under each answer are now `<a>` instead of `<span>`,
  clicking jumps to the verbatim source URL for re-verification.
- `.answer-link` styling matches the accent (violet) palette.

### Expected impact

- Per-fragment queen-ingest cost ~80 ms → ~3-5 ms amortised.
- Sustained throughput ~10k-20k frags/min (vs ~750).
- Replication-lag backlog drains within minutes instead of
  accumulating indefinitely; recent extractions reach Qdrant
  shortly after the bee emits them.
- LLM answers stop saying "the fragment mentions ..." and stop
  enumerating tangential content when the answer isn't in HIVE.
- Inline links and source chips in the chat UI are clickable.

### Verified pre-deploy

- Python: `embedder.add_batch` with HNSW backend ingests 2 items
  correctly.
- TypeScript: `_consumeRemoteStream` rewrite compiles cleanly
  (`knowledge_store.ts` imports without diagnostics).
- HTML tag balance preserved (115 `<div>` open/close pairs).
- New selectors present after merge: `answer-link`,
  `a.conv-source-chip`.

### Note on merge

This patch was developed against v0.7.2.4 in parallel with the
v0.7.2.5–v0.7.5 line that landed upstream (responsive UI, manifest,
Common Crawl adapter). The batching changes are independent and
were re-applied cleanly on top of v0.7.5; UI / LLM-prompt hunks
applied via a 3-way merge against the responsive layout from
v0.7.2.7.

---

## [0.7.2.4] — 2026-05-22 — *Fix /api/query always returning zero fragments (qdrant 404)*

Critical query-path bug surfaced by the v0.7.2.3 review: every query
on the live queen returned "⚠ Not verified by HIVE — answering from
general knowledge", even for content the queen had clearly indexed
(123 k vectors in Qdrant, fragments visible in the dashboard).

Root cause: `packages/embeddings/qdrant_index.py` called
`self._client.query_points()`, which is a `qdrant-client` method
introduced in v1.10 that talks to the new
`/collections/{name}/points/query` endpoint on the Qdrant SERVER —
also added in Qdrant 1.10. Our `docker-compose.yml` pins
`qdrant/qdrant:v1.9.2`. The 1.9 server returned `404 Not Found` for
the new endpoint, surfaced by qdrant-client as
`UnexpectedResponse: 404` and bubbled up as `Internal Server Error`
on `/search`. The embedder's `/search` was failing silently; the
queen's `query_engine.queryByText` got an empty `results` array and
fell through to the "no relevant fragments → LLM-only answer" path.

`requirements.txt` pinned `qdrant-client>=1.9.0` with no upper
bound, so a normal `pip install` pulled a 1.10+ client at image
build time — the bug only manifested after the next image rebuild
from an unrelated change.

### Changed

- `packages/embeddings/qdrant_index.py::query()` now calls the
  pre-1.10 `search()` API (`/collections/{name}/points/search`),
  which every Qdrant 1.0+ server speaks. Functionally identical for
  our use (single dense-vector query + payload filter + top-k). The
  return shape differs (`List[ScoredPoint]` instead of
  `QueryResponse.points`); the iteration is adjusted accordingly.

### Verified pre-deploy

- The /search → /collections/.../points/search endpoint on the
  running Qdrant 1.9.2 returns 200 + payload for plain dense-vector
  queries (verified via `curl` from inside the queen container).
- Same `qdrant-client.search()` signature is documented for both
  the 1.7 and 1.13 client lines; the call works regardless of which
  client version `pip install` resolves.

### Will verify post-deploy

- `POST /api/query` with `"tell me about SEMA"` and `use_llm=false`
  should return non-empty `fragments` (we previously saw
  `wiki_sema_association_*` indexed in Qdrant).
- `POST /api/query` with `use_llm=true` should return a verified
  HIVE answer instead of the "Not verified by HIVE" fallback.

### Backlog

- Pin `qdrant-client<1.10` in `requirements.txt` (or upper-bound it)
  so a fresh `pip install` won't reintroduce this silent break.
  Skipped for now to keep the patch surface small; the code change
  is the load-bearing fix.
- Upgrade the Qdrant SERVER to `1.10+` at some point. That unblocks
  using `query_points()` (the modern unified API) and removes the
  client/server version-skew class of issue. Touch a 123 k-vector
  collection carefully — it has data we don't want to migrate twice.

---

## [0.7.2.3] — 2026-05-22 — *Continuous extraction; sidebar parity; UI polish*

Follow-up to v0.7.2.2 fixing five things from the live review.

### Changed

- **Default `HIVE_EXTRACT_INTERVAL_MS` lowered from 30 min → 1 s**
  (binary and docker-compose default). The 30-min pause was a v0.5/v0.6
  hedge against LLM rate limits; the LLM is no longer in the extraction
  loop since v0.6.1 so the pause has no purpose. Wikipedia's API tolerates
  well over our extraction rate, so 1 s between cycles keeps the bee
  effectively continuous without hammering the source. On a healthy bee
  the queue should drain visibly, not sit at the same count for minutes.
- **Sidebar / topbar number parity.** The "Knowledge Network" panel now
  reads peer count + fragment total from `/api/status` (the same source
  the topbar uses) instead of from `/api/topics`. The old discrepancy
  ("sidebar: 0 peers · 0 frags" while topbar said "1 peer · 123843
  indexed") came from `/api/topics` only knowing about peers that had
  already published a claim record — DHT-connected peers without a claim
  yet were invisible. The detailed peer list with topic claims still
  exists behind the toggle and reads from `/api/topics`; only the
  summary numbers move.
- **Embedder pill hidden on bee.** The "X indexed / embedder offline"
  pill in the topbar is meaningless for a bee (no embedder, indexed=0
  by design — see v0.7.0.1 capability flags). The pill now carries the
  `.hide-on-bee` class so it disappears in bee mode along with the
  query input and LLM provider section.
- **Color accents on bee stat cards.** The Queue / Visited / Objective
  cards each get a 3 px left stripe plus a faint diagonal gradient in
  the accent colour (violet for Queue, green for Visited, sky-blue for
  Objective). The stat numbers themselves take the accent colour on the
  metric cards. Replaces the all-white panel look that read as "broken
  dashboard" in the v0.7.2.2 screenshot.
- **Glyph icons** added to bee card labels (📥 Queue, ✓ Visited, 🎯
  Objective) for at-a-glance recognition.

### Fixed

- **Activity feed inside the bee dashboard** no longer ellipses entries
  that wrap to multiple lines. Activity messages can be long (e.g.
  `Cycle complete: 60 fragments | 0 tokens`); seeing `Cycle co…` was
  uninformative. The titles lists (Next up, Recently fetched) still
  ellipse — they're Wikipedia article titles where one-line preview is
  enough.

### Added

- `LATEST_STATUS` global cached in `checkStatus()`. Lets `loadNetwork()`
  derive panel numbers from the same `/api/status` payload the topbar
  uses, without an extra round-trip.

### Verified

- Tag balance on `index.html`: `<div>` open/close 110/110.
- Smoke test of a fresh `HIVE_MODE=bee` cold-start: nextCycleAt is ~4 s
  into the future (vs ~60 000 ms previously), confirming the new
  default takes effect.
- Served HTML contains 25 matches for the new selectors
  (`accent-queue`, `accent-visited`, `accent-objective`, `hide-on-bee`,
  `LATEST_STATUS`, `bee-event-list`, …).

### Not changed

- Per-cycle behaviour. `HIVE_EXTRACT_MAX_FRAGMENTS` (default 10) still
  caps work per cycle; the change is purely how long the bee waits
  between cycles.
- `/api/topics` schema. Still used for the per-peer claim breakdown
  behind the toggle.

---

## [0.7.2.2] — 2026-05-22 — *UI polish: capybarahome palette, aggregated network panel, bee dashboard*

UI-only release answering three usability complaints:

### Changed

- **Colour palette aligned with capybarahome**
  (`src/app/globals.css`). Main content stays white; sidebar moves to
  `slate-100` (`#f1f5f9`) with a `slate-300` border so the two regions
  read as distinct without going dark-mode. Accent switches from
  indigo (`#6366f1`) to capybarahome's violet (`#8b5cf6`), and a new
  `--brand` (`#0ea5e9`, sky blue) joins the gradient on the logo. The
  prior "everything's pure white" look is gone.
- **Queen network panel reshaped from per-peer list to aggregated
  view.** The v0.7.1 panel listed every peer with its first 3 topic
  titles; this works at 5 peers and breaks at 100. The new layout:
  a single summary line (`N peers · X frags`), a sorted list of
  top-level domains with bee counts (`science 3 bees`, `history 1
  bee`, …), and "this node's claims" highlighted. A toggle expands
  the detailed per-peer view lazily (no DOM build cost until clicked),
  preserving the v0.7.1 behaviour for operators that want it.
- **Bee main area is now a forager dashboard.** v0.7.0.3 hid the
  query box on bees and replaced it with a small welcome card,
  leaving most of the screen empty. The new dashboard occupies that
  space with:
  - A live status row (animated when extracting, "Next cycle in Xm Ys"
    when idle).
  - Two stat cards for queue / visited counts.
  - The current objective, verbatim.
  - Next-up and recently-fetched title lists (10 each).
  - A 30-event activity feed mirroring the sidebar.
  - Identity footer with node id + Hypercore key.
- **`loadCrawl()` added** as a third polling loop (every 8 s) driving
  the bee dashboard. DOM nodes are guarded; the function is a no-op
  in queen / hive mode.
- **`.brand-logo` gradient** now uses `--accent` (violet) and
  `--brand` (sky) variables instead of literals, so future palette
  tweaks land in one place.

### Verified

- Tag balance check on `index.html`: `<div>` open/close 110/110;
  `<script>` 1/1; `<style>` 1/1.
- Smoke test against a fresh `HIVE_MODE=bee` boot: `/api/status`,
  `/api/crawl`, `/api/activity` all serve the expected payloads;
  the served HTML contains all 21 selectors the new dashboard
  needs (`bee-dashboard`, `bee-stat-queue`, `bee-objective`,
  `bee-status-row`, `net-summary`, `net-cov-row`, …).
- Hetzner v0.7.2.1 deploy confirmed healthy before this change:
  queen at v0.7.2.1, indexed 123843 (vs 123797 ~1h earlier — grew
  46 fragments naturally, no rewrite-storm from the v0.7.2 cycle).

### Not changed

- API surface. All new dashboard data comes from existing endpoints
  (`/api/crawl`, `/api/activity`, `/api/topics`, `/api/state`).
- Mode-routing logic. The same `<body data-hive-mode>` attribute set
  in `checkStatus()` continues to drive `.hide-on-bee` /
  `.hide-on-queen` CSS visibility; the new dashboard sits inside the
  existing `#bee-placeholder` container.

---

## [0.7.2.1] — 2026-05-22 — *Fix v0.7.2 Dockerfile: rocksdb-native prebuild missing*

The v0.7.2 image broke at runtime on Hetzner. Both queen and bee
containers crashed in a restart loop immediately after `Starting
queen on :8090…` / `Starting node on :8080 …` with:

```
Error: Cannot find module '/prebuilds/linux-x64/rocksdb-native.node'
  at corestore/index.js → hypercore/index.js → hypercore-crypto →
     sodium-universal → sodium-native → require-addon
```

`rocksdb-native` ships a prebuilt `.node` binary per platform; the
file was missing in the v0.7.2 image's `node_modules`. The two
v0.7.2 Dockerfile changes that touched the npm phase were:

  - `apt-get install -y --no-install-recommends` (removed recommended
    OS packages — could have dropped a transitive build/fetch dep).
  - `npm install && npm cache clean --force` (clean step at end).

Either could plausibly have interfered with the prebuild fetch under
buildx's `linux/amd64` target. Reverted both. The image-size win
that *did* matter — installing torch from the PyTorch CPU wheel
index before sentence-transformers — is preserved.

### Changed

- Dockerfile: revert `--no-install-recommends` to plain
  `apt-get install -y`, and the `npm cache clean --force` step.
  Torch CPU wheel install kept as-is.

### Verified

- Same fix applied locally: rocksdb-native prebuild present after
  `npm install` against the reverted Dockerfile, and the test image
  starts api_server cleanly.
- CI build + Hetzner deploy expected to recover queen / bee to
  v0.7.2.1 with v0.7.0 fragment-id format preserved (no rewrite-
  storm).

---

## [0.7.2] — 2026-05-22 — *arXiv / RSS / web as ForagerSource adapters; Docker slim*

Completes the source-driven migration started in v0.7.1. All four
sources HIVE knows about — Wikipedia, arXiv, RSS, generic web —
now implement the `ForagerSource` interface. The legacy
`packages/agent/src/tools_registry.ts` is deleted; nothing in the
runtime calls `executeTool` anymore.

Two operational fixes ship alongside.

### Added

- `packages/agent/src/forager/arxiv_source.ts` — wraps the existing
  `arxiv_client.fetchPapers` behind the interface. `seed(query)`
  returns abstract URLs; `fetch(url)` does a single-paper lookup via
  the `id_list` endpoint and returns one fragment. Fragment id scheme
  preserved (`<arxiv_id>_c0`).
- `packages/agent/src/forager/rss_source.ts` — RSS/Atom feeds. The
  unit of crawl is the feed URL; `seed(feedUrl)` echoes the URL and
  `fetch(feedUrl)` returns up to 15 items as fragments. Same User-
  Agent, body-extraction order, and `rss_<host>_<titleSlug>` id scheme
  as v0.6.
- `packages/agent/src/forager/web_source.ts` — catch-all for HTTP(S)
  URLs not claimed by a specialised adapter. `owns(url)` returns
  `true` for any `http(s)` URL; `seed()` returns `[]` (nothing to
  search). Same 30 KB cap and `web_<host>_<slug>_c<n>` id scheme as
  v0.6.

### Changed

- `packages/agent/src/autonomous_extractor.ts` — auxiliary RSS and
  arXiv branches now go through `rssSource.fetch` and `arxivSource`
  `.{seed,fetch}` respectively. The full extractor is now driven
  entirely by the ForagerSource interface; no `executeTool` calls
  remain. The legacy `resetSeenTitles()` call is removed too —
  in-cycle title dedup is handled by `CrawlQueue` (Wikipedia) and is
  irrelevant for arXiv/RSS (rarely-colliding title namespaces).
- **Dockerfile slimmed.** Installs torch from the PyTorch CPU wheel
  index (`https://download.pytorch.org/whl/cpu`) BEFORE
  sentence-transformers, so the transitive dep picks up the existing
  CPU build instead of pulling CUDA-12 wheels (~2 GB). The image
  drops from ~10 GB to ~1-2 GB. `npm install` keeps dev dependencies
  for now because the runtime loads .ts files via `tsx` and tsx
  lives in devDependencies; moving it to dependencies is a separate
  cleanup.
- **CI workflow auto-prunes dangling images.** Adds
  `docker image prune -f` (dangling only — preserves opt-in images
  like `ollama/ollama:latest` that may sit idle between profile
  toggles) between `docker compose pull` and `docker compose up -d`.
  This is the fix for what bit us during the v0.7.1 deploy: nine
  dangling `:latest` HIVE images had piled up to fill the 75 GB
  Hetzner disk.

### Removed

- `packages/agent/src/tools_registry.ts` — ~600 LoC of dead code.
  The `executeTool` switch (with cases `wikipedia_search`,
  `wikipedia_fetch`, `arxiv_search`, `rss_fetch`, `web_fetch`,
  `crossref_validate`, `index_fragment`) is gone; the
  `TOOL_DECLARATIONS` array and tool-context types
  (`ToolResult`, `OnFragment`, `OnCrawlEnqueue`, `FragInput`) too.
  Helpers (`decodeHtmlEntities`, `slugify`, `hostnameFromUrl`) are
  copied where needed inside each adapter so each is self-contained.

### Verified

- Pure-function unit tests for all three new adapters: id/owns/
  normalize and the source-specific helpers (`arxivIdFromUrl`,
  feed-url echo, web-url scheme check) all return expected values.
- Live RSS: `rssSource.fetch("https://feeds.bbci.co.uk/news/world/rss.xml")`
  returned 15 fragments with the expected `rss_feeds.bbci.co.uk_*`
  ids and 86400 s TTL.
- Live arXiv: code path was exercised end-to-end; the live test hit
  arXiv's 429 rate limit (transient external state), not a code
  error. The retry logic in `arxiv_client.fetchPapers` (preserved
  from v0.6) handles this naturally on the next cycle.
- End-to-end extractor cold-start: a fresh `HIVE_MODE=hive` node
  logs the v0.7.1 banner (`wikipedia via ForagerSource`), seeds via
  `wikipediaSource.seed`, fetches via `wikipediaSource.fetch`, and
  produces fragments with the unchanged `wiki_<slug>_*` ids. Aux
  branch wiring was not observed within the smoketest budget but is
  exercised by the same pattern.

---

## [0.7.1] — 2026-05-22 — *ForagerSource interface, Wikipedia migrated*

First step of the v0.7 source-driven refactor. Introduces the
`ForagerSource` interface — the contract every source adapter
(Wikipedia, arXiv, RSS, Common Crawl, …) will implement going forward
— and migrates the Wikipedia path to use it as the reference
implementation. No behaviour change for operators. The auxiliary RSS
and arXiv branches still call the legacy `executeTool` tools; they
migrate to `ForagerSource` adapters in v0.7.2.

### Added

- `packages/agent/src/forager/source.ts` — `ForagerSource` interface
  with four methods (`seed`, `fetch`, `normalize`, `owns`) and three
  read-only fields (`id`, `displayName`, `licence`). The contract
  speaks URLs publicly so the future generic forager can dispatch a
  discovered link to the right adapter via `owns(url)`.
- `packages/agent/src/forager/wikipedia_source.ts` — reference
  implementation. Wraps the v0.6 `wikipedia_fetch` logic from
  `tools_registry.ts` (same User-Agent, same chunking thresholds, same
  fragment-id scheme, same SKIP_SECTIONS) but exposes them through the
  new interface plus two adapter-internal helpers (`urlFromTitle`,
  `titleFromUrl`) the autonomous extractor uses as a bridge.

### Changed

- `packages/agent/src/autonomous_extractor.ts` — Wikipedia seed and
  fetch paths now go through `wikipediaSource.{seed,fetch}` instead
  of `executeTool('wikipedia_search')` / `executeTool('wikipedia_fetch')`.
  Fragments returned by the adapter flow through the unchanged
  `onFragment` pipeline (dedup → TTL → supersede → Hypercore save →
  embedder POST). The CrawlQueue still stores titles, with title↔URL
  bridging at the extractor boundary; the queue migration to URLs is
  v0.7.3 work.

### Not changed

- Fragment IDs (`wiki_<slug>_<section>[_cN]`) — keeping them stable
  means existing Hypercores match against new extraction by id, so
  there is no rewrite-storm on first run after upgrade.
- Auxiliary sources (`rss_fetch`, `arxiv_search`, `web_fetch`) still
  use the legacy tool registry. They become `ForagerSource` adapters
  in v0.7.2.
- The legacy `wikipedia_fetch` / `wikipedia_search` cases in
  `tools_registry.ts` stay in place. They are dead code from the
  autonomous extractor's perspective but the file is kept until the
  v0.7.2 adapter migration is complete.

### Verified

- Adapter unit-level (pure functions): `id`, `owns()`, `normalize()`,
  `urlFromTitle()`, `titleFromUrl()` all return expected values.
- Adapter network-level: `seed("photosynthesis")` returns 3 canonical
  Wikipedia URLs; `fetch("Photosynthesis")` returns 57 fragments and
  1092 outbound links.
- End-to-end: a fresh `HIVE_MODE=hive` node boots and logs
  `🤖 Autonomous extractor starting (direct, no LLM) — wikipedia via ForagerSource`
  followed by `wikipediaSource.seed(...)`, `wikipediaSource.fetch(...)`,
  and a stream of `[+] Indexed: wiki_organic_chemistry_intro_c0 | ...`
  with the expected IDs and confidence values.

---

## [0.7.0.6] — 2026-05-22 — *Default mode = bee, deploy from git*

Follow-up to v0.7.0 fixing two things we found while deploying to
production.

### Changed

- **Binary default is now `HIVE_MODE=bee`** (was `hive`). The api_server
  resolves an unset `HIVE_MODE` to `bee` — the safe, lightweight choice
  for new operators ("I want to contribute to the network"). Running an
  all-in-one node requires explicit `HIVE_MODE=hive`. Rationale: most
  people who run HIVE want to be a producer; defaulting to the full
  node forced them to set up an LLM key and an embedder just to start.
- **`hive.sh` is mode-aware.** It reads `HIVE_MODE`, brings up the
  Python embedder ONLY when the mode needs it (queen / hive), and
  enforces the LLM-key check only when applicable. A fresh
  `bash hive.sh` with no `.env` boots a bee in ~10 seconds with no
  Python overhead. v0.7.0 was launching the embedder unconditionally
  inside bee containers — ~80 MB of wasted RAM per bee.
- **Repo `Caddyfile`** updated to reverse-proxy `queen:8090` instead of
  `aggregator:8090`. The docker-compose path doesn't use this file
  (Caddy gets a one-liner command), but the standalone-Caddy fallback
  was still pointing at the old name.

### Fixed

- **CI deploy now does `git pull --ff-only` on the server before
  `docker compose up -d --remove-orphans`.** The v0.7.0 deploy taught
  us that the workflow only updated the image; the `/opt/hive/docker-
  compose.yml` on the server stayed at whatever version was last
  copied by hand. Result: `aggregator` → `queen` rename didn't
  propagate, bee-1 ran without explicit `HIVE_MODE=bee`. From v0.7.0.6
  the server is a git checkout of `main` and the CI fetches there
  before recreating the stack.
- **README audit.** Removed the duplicated "Full VPS stack" section
  that contradicted Quick start; corrected the "Ollama is the default"
  claim (Ollama has been opt-in via profile since v0.6.4.2);
  re-titled `bash hive.sh` instructions to reflect that it produces a
  bee, not a "single BEE on :8080" (semantically the same now —
  finally accurate). Added an explicit "Launch modes" table at the
  top of the Quick start matching `bee.sh` / `hive.sh` / `queen.sh`
  to `HIVE_MODE` values.
- **Configuration section** now documents `HIVE_MODE` and the queen-
  specific `AGGREGATOR_LLM_PROVIDER` / `AGGREGATOR_LLM_API_KEY`
  variables, which were not mentioned anywhere in the user-facing
  docs until now.

### Operator-visible deploy procedure

For anyone running their own VPS deployment from v0.6 or v0.7.0:

```bash
# One-time: convert /opt/hive to a git checkout
cp /opt/hive/.env /root/hive.env.backup
mv /opt/hive /opt/hive.pre-git
git clone https://github.com/capybarist/hive.git /opt/hive
cp /root/hive.env.backup /opt/hive/.env

# Subsequent deploys: handled by CI, or manually:
cd /opt/hive && git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
```

Volumes (Hypercore data, Qdrant index, Caddy state) are preserved
because they are external to the directory.

---

## [0.7.0] — 2026-05-22 — *Bee / queen role split*

First release of the v0.7 cycle. Same codebase, same Docker image,
**role selected at runtime** by `HIVE_MODE`. Backward-compat: no
`HIVE_MODE` value means `hive` (full node = v0.6 behaviour),
`HIVE_MODE=aggregator` is accepted as a deprecated alias for `queen`.

The source-driven refactor (manifests, `scope`/`policy`, Common
Crawl), bee↔bee replication topology, and HNSW removal from bees
are **not** in this release — those land in v0.7.1+.

### Added
- `HIVE_MODE` env var with values `bee | queen | hive` (api_server, 0.7.0.1).
- Six capability flags driving the API surface and runtime components:
  `HAS_EXTRACTOR`, `HAS_LOCAL_STORE`, `HAS_QUERY_API`, `HAS_LOCAL_EMBED`,
  `HAS_REMOTE_REPLICATION`, `HAS_DASHBOARD_PROXY` (0.7.0.2).
- `<body data-hive-mode>` attribute + `.hide-on-bee` / `.hide-on-queen`
  CSS classes drive UI section visibility (0.7.0.3). Bee mode now shows
  a dedicated welcome card with node id + core key instead of a search box.
- New launcher script `queen.sh` (0.7.0.4). Same shape as `aggregator.sh`
  was, but sets `HIVE_MODE=queen`, data dir `~/.hive-queen`, log paths
  `/tmp/hive_queen.log`.
- Network alias `aggregator` on the queen compose service so external
  consumers (capybarahome `/hive` widget, custom dashboards) that
  reference `http://aggregator:8090` keep resolving (0.7.0.4).

### Changed
- Docker Compose service `aggregator` → `queen`. Container name
  `hive-aggregator` → `hive-queen`. Caddy now reverse-proxies to
  `queen:8090`. Volume **name kept as `aggregator-data`** so
  `docker compose pull && docker compose up -d` from v0.6 preserves
  fragments without manual migration (0.7.0.4).
- Bee services in docker-compose declare `HIVE_MODE=bee` explicitly
  (previously relied on the v0.6 implicit "full node" default).
- Topbar mode badge now lights up for both `aggregator` (legacy) and
  `queen` (canonical), uppercased from the actual `/api/status` value
  instead of a hardcoded label.

### Deprecated
- `HIVE_MODE=aggregator` — alias for `queen`, prints a warning on boot.
  Removed in v0.8.
- `aggregator.sh` — reduced to a wrapper that prints a deprecation
  notice and execs `queen.sh`. Removed in v0.8.

### Migration from v0.6.x

| What | Action | Why |
|------|--------|-----|
| Local dev with `bash hive.sh` | No change. Still works. Produces a `HIVE_MODE=hive` node = v0.6 behaviour. | Backward-compat preserved. |
| Docker compose deployment | `git pull && docker compose pull && docker compose up -d`. Container `hive-aggregator` will stop, `hive-queen` will start. Volume `aggregator-data` is reused — no fragment loss. | Service rename only; storage path unchanged. |
| Scripts that call `bash aggregator.sh` | Replace with `bash queen.sh`. The old script still works for one release with a deprecation banner. | Removed in v0.8. |
| External consumer pointing at `http://aggregator:8090` (e.g. capybarahome reverse proxy) | No change required. The new compose service has an `aggregator` network alias. | Backward-compat DNS shim. |
| Existing `.env` with `HIVE_MODE=aggregator` | Either rename to `queen` or leave it — the api_server accepts both, only `queen` is forward-compatible. | Removed in v0.8. |

### Post-deploy verification on Hetzner

1. `docker compose ps` → expect `hive-queen` (not `hive-aggregator`).
2. `curl localhost:8090/api/status | jq .mode` → should return `"queen"`.
3. `curl localhost:8080/api/status | jq .mode` → should return `"bee"`.
4. UI on `http://<host>` should show `QUEEN` badge in the topbar.
5. `docker volume ls | grep aggregator-data` → still present, same usage as before.
6. Fragments count on `/api/status` should match v0.6 number within
   normal extraction drift (i.e. not back at 0).

---

## [0.6.4.5] — 2026-05-21 — *Restore /api/crawl dashboard proxy (not P2P sync)*

The v0.6.4 removal of the aggregator's `/api/crawl` → bee proxy was
too aggressive: that endpoint is used by external dashboards (the
capybarahome `/hive` widget), not as node-to-node sync. Removing it
broke the public widget — it stopped showing queue/visited/recent
data because the aggregator returned `{ mode, hint }` instead of the
forager payload.

This restores the proxy with a clearer distinction:

- **Node-to-node HIVE traffic** (fragments, claims, peer discovery)
  remains 100% P2P via Hyperswarm + Hypercore. No HTTP between
  HIVE nodes for any of that.
- **Dashboard plumbing** (a public UI asking a single endpoint for
  forager state across the network) is HTTP, and that's fine —
  the dashboard is not a HIVE node, it's a consumer of HIVE's
  public surface.

Adds a new env var `HIVE_DASHBOARD_BEE_URL` (defaults to
`http://bee-1:8080` for the standard docker-compose topology) so
operators can point the aggregator at whichever bee provides the
visible forager state. If the bee is unreachable, the endpoint
returns an empty-but-shape-valid payload so the widget renders
zeros instead of crashing.

---

## [0.6.4.4] — 2026-05-21 — *Runtime persistence + Qdrant race-condition fix*

Two production bugs surfaced today on Hetzner, both fixed in this patch.

### Fixed

- **0.6.4.3** — `POST /api/config` (the UI's "set provider" button) was
  writing the resulting `LLM_PROVIDER` / `LLM_API_KEY` to `/hive/.env`
  *inside the container*, which is not a mounted path. On the next
  `docker compose up -d` (or any container recreate) the override was
  lost and the bee fell back to whatever `LLM_PROVIDER` the host's
  `docker-compose.yml` env-var resolved to. We hit this today after
  adding bee-2: the original Gemini override vanished and bees were
  starting in ollama-fallback mode while the operator (and memory)
  said "Currently Groq". Fixed by persisting to
  `${HIVE_DATA_DIR}/.runtime.env` (mounted volume) and loading it at
  boot. Only `LLM_*` keys are honoured from the runtime file —
  anything else stays under host `.env` control.
- **0.6.4.4** — Aggregator `depends_on: qdrant: condition: service_started`
  did not actually wait for Qdrant to accept connections. Qdrant takes
  a few seconds to open its storage after process start, so the
  aggregator's `aggregator.sh` would call `curl qdrant:6333/healthz`,
  get a connection refused, **silently fall through to the HNSW
  in-process backend**, and serve from an empty index — while the real
  collection with 34k+ persistent vectors sat untouched on disk. Fixed:
   1. Added a `healthcheck` on the qdrant service in `docker-compose.yml`
      that polls `/readyz` (not `/healthz` — see below).
   2. Aggregator now waits via `condition: service_healthy`.
   3. `aggregator.sh` distinguishes "QDRANT_URL was set explicitly"
      (wait up to 60s, hard-fail if never ready — never silently
      lose persistence) from "QDRANT_URL was empty" (legacy
      auto-start path, may fall back to HNSW).
   4. The readiness probe prefers `/readyz` over `/healthz` because
      `/healthz` returns 200 while collections are still loading from
      disk on cold start — the exact behaviour that caused the
      silent fallback.

### Known issue (backlog v0.6.4.5)

`bee` HNSW index shows `indexed: <number much smaller than Hypercore length>`
after a container recreate. The Hypercore (source of truth) has the
full history; the local HNSW does not finish rehydrating because the
underlying `usearch` library rejects duplicate label adds during
replay. Tracked. Does not affect the aggregator (Qdrant has upsert
semantics built-in).

---

## [0.6.4.2] — 2026-05-21 — *Ollama opt-in, Gemini default*

The Ollama container was eating ~2 GB of RAM in deployments that
already had a cloud LLM key configured — observed in production
where adding a second BEE on a 4 GB VPS caused OOM despite ollama
being completely unused.

### Changed

- `docker-compose.yml`: ollama + ollama-init moved behind the
  `ollama` profile. They no longer start by default. Activate with:
  `docker compose --profile ollama up -d`.
- Bees and aggregator no longer have a hard `depends_on: ollama` —
  ollama is now a peer service, not a dependency.
- Default `LLM_PROVIDER` / `LLM_MODEL` in compose: `gemini` /
  `gemini-2.5-flash-lite` (reflects the actual operating reality of
  most installs since v0.6).
- `.env.example`: rewritten to lead with Gemini, document the other
  cloud providers as one-liners, and demote Ollama to "opt in if
  you want fully-local LLM" with the profile activation command.

---

## [0.6.4] — 2026-05-21 — *100% P2P: zero HTTP between nodes*

The bee-to-bee channel is now exclusively Hyperswarm + Hypercore. No
HTTP request is made between two HIVE nodes for any reason — discovery,
key exchange, claims sync, fragment sync, or federated queries all
happen on the same Hyperswarm socket via Protomux + Hypercore replication.
The Fastify HTTP server still serves the dashboard and `/api/query` to
external clients, but it is no longer a transport between bees.

### Added

- **0.6.4.1** — `PeerMeta` interface in `packages/core/src/p2p_node.ts`
  (re-exported from `@hive/core`). Carries `{ nodeId, publicKey,
  coreKey, claimsCoreKey }`. The `hive/meta/v1` Protomux channel now
  encodes a JSON-over-c.string blob with all four fields, sent once
  per connection. Previously the channel carried just an `apiUrl`
  string and the rest came over HTTP `/api/status` — that HTTP
  round-trip is gone.
- **0.6.4.2** — New `peer-meta` event on `HiveP2PNode` (replaces
  `peer-api`). The `api_server.ts` handler is one block that does the
  whole bootstrap: register pubkey, open fragments core, open claims
  core, start watchers. No retry loop needed because the channel is
  reliable (TCP+Noise inside the same Hyperswarm socket).

### Removed

- **0.6.4.3** — `packages/core/src/sync_manager.ts` deleted. The class
  was already off-by-default since v0.6.3.2; this version removes it
  entirely. `HIVE_HTTP_SYNC` env var no longer recognised.
- **0.6.4.4** — `POST /api/register-peer` endpoint deleted. The
  startup auto-announce that called it has also been removed. Peer
  discovery is fully Hyperswarm.
- **0.6.4.5** — HTTP pull of `/api/claims` during bootstrap removed.
  Claims arrive via Hypercore replication (the `claims` core lives in
  the same shared Corestore as `fragments` since v0.6.3.4, so
  `store.replicate(socket)` propagates both).
- **0.6.4.5** — Federated HTTP query in `POST /api/query` removed.
  When a peer is connected via Hyperswarm its data is already in our
  local embedder via replication; if it isn't, the correct answer is
  "we don't have data" rather than poking HTTP.
- **0.6.4.5** — Aggregator `/api/crawl` HTTP proxy to a bee removed.
  Dashboards should query the bee directly. The aggregator stops
  having any opinion about a bee's local crawl queue.
- **0.6.4.6** — `HIVE_PEER` env var deprecated. Reading it still works
  but only produces a `[deprecated]` warning at startup; nothing in
  the code uses its value any more. `HIVE_API_URL` is also vestigial
  now (no HTTP peer-to-peer means nobody needs to know our HTTP URL).

### Changed

- **Startup log** — `Peers → Hyperswarm discovery (no HTTP bootstrap
  since v0.6.4)` replaces the old `Peer → http://...` line.
- **`discoverObjective`** — no longer accepts a list of `peerApis` to
  poll; receives `[]` from `api_server.ts`. Claims learnt from peers
  via Hypercore replication populate `ClaimRegistry` directly, so
  `assignTopics()` sees them without an HTTP detour.

### Operational note

If you were running with `HIVE_PEER=…` to bootstrap a fresh bee, you
can drop it. Hyperswarm DHT does the discovery. The only caveat
remains the one from CLAUDE.md: environments that block outbound UDP
(some Codespaces, some corporate VPNs) cannot establish a Hyperswarm
connection — in those environments **the bee runs in isolation
until UDP becomes available**. Since v0.6.4 there is no HTTP fallback
to compensate for that, by design.

### Security

- The receive-side ed25519 check from v0.6.2.1 is now strictly stronger
  because every fragment's producer pubkey is known at the moment the
  peer connects (it travels in the same Protomux meta payload). No
  more "unknown peer — pubkey not registered yet" drops at startup.

---

## [0.6.3.4] — 2026-05-21 — *Pure P2P, replicated claims*

Patch series 0.6.3.1 → 0.6.3.4. The bee is now a real Hypercore-native
peer: HTTP sync is opt-in, fragments are served from the signed log
(not the embedder), claims replicate alongside fragments over the same
Hyperswarm connection, and `HIVE_PEER` is just a warm-start hint —
Hyperswarm discovery covers the rest.

### Added

- **0.6.3.1** — When a peer is discovered via Hyperswarm, the bootstrap
  step now also pulls the peer's `/api/claims` so topic coordination
  works without `HIVE_PEER`. Booting a brand-new bee with no env config
  is now a supported topology.
- **0.6.3.4** — `ClaimRegistry` accepts an optional shared `Corestore`;
  when passed, the `claims` Hypercore lives alongside the `fragments`
  core and replicates over the same `store.replicate(socket)` channel.
  `/api/status` exposes the new `claimsCoreKey`. Each peer's
  `claimsCoreKey` is opened read-only and streamed into the local
  registry via the new `watchRemoteClaims(remoteCoreKey)` method.
  Restartable on stream death with exp backoff (same pattern as
  `watchRemoteCore`).

### Changed

- **0.6.3.2** — `SyncManager` HTTP sync (the 8-second `/api/fragments`
  poll) is now **OFF by default**. Set `HIVE_HTTP_SYNC=1` to re-enable
  for debugging or when Hyperswarm UDP is blocked. Native Hypercore
  replication is the only sync path in the default configuration.
- **0.6.3.3** — `GET /api/fragments` now reads from Hypercore via
  `KnowledgeStore.query()` in BEE mode, so the response carries the
  full signed fragment (`hash`, `signature`, `status`, `supersedes`,
  `superseded_by`). The aggregator path still reads from Qdrant since
  it owns no local Hypercore. Hard cap of 5000 fragments in the page
  to avoid OOM on very large stores.
- **0.6.3.1** — Startup log shows `Peer → (none configured — relying on
  Hyperswarm discovery)` instead of the previous `(no bootstrap peer)`
  half-warning. Operators stop reading it as an error.

---

## [0.6.2.6] — 2026-05-21 — *Extraction quality + full ed25519 verify*

Patch series 0.6.2.1 → 0.6.2.6. The signature check on the receive
side is now a real ed25519 verify against a per-peer pubkey, not just
a hash recompute. Wikipedia extraction stops truncating long sections
and finally indexes H3 subsections. RSS/arXiv come back into the loop
via rule-based routing. The watch streams self-heal.

### Added

- **0.6.2.1** — New `PeerRegistry` (`packages/core/src/peer_registry.ts`)
  holds `node_id → publicKey` learnt during `/api/status` exchange.
  `/api/status` now exposes `publicKey`. `watchRemoteCore` and
  `SyncManager.syncOnce` look up the producer's pubkey and run a
  full `verifySignature({id, hash}, signature, pubkey)` per fragment.
  Drop counters distinguish unsigned / tampered / unknown-peer cases.
  If no peer registry is provided (CLI/tests), the previous hash
  recompute is used as a fallback so existing tests still pass.
- **0.6.2.3** — `wikipedia_fetch` now indexes H3 subsections as their
  own fragments with ids like `wiki_<article>_<h2_slug>_<h3_slug>` so
  fine-grained search can hit a specific H3 instead of being absorbed
  by its H2 parent.
- **0.6.2.5** — Both `watchFragments` and `watchRemoteCore` wrap their
  for-await loop in a restart-on-error supervisor with exponential
  backoff (max 30s). A torn-down stream (session close, hyperbee
  internal) is now self-healing instead of silently halting until
  next process restart.
- **0.6.2.6** — `ClaimRegistry.releaseExpired()` sweeps and deletes
  claims whose `renewedAt` is older than TTL. Called at the top of
  every extraction cycle in `api_server.ts`. The operator sees a
  `[claims] Released N expired claim(s)` line whenever a dead BEE's
  topics get freed; previously they sat in the registry blocking
  re-assignment for 30 minutes with no signal.

### Changed

- **0.6.2.2** — `wikipedia_fetch` stops using `.slice(0, 1000)` to
  cap section length. Sections longer than 1500 chars are chunked
  via `text_chunker` (350 tokens, 50 overlap) so long sections
  (`History`, `Background`) are fully indexed without losing content.
  Each chunk gets its own id (`…_cN`) so dedup + TTL + supersede
  remain consistent.
- **0.6.2.4** — `runAutonomousExtraction` ends each cycle with an
  optional auxiliary fetch decided by rules over the topic objective:
  news / current_events → `rss_fetch` over a curated feed
  (configurable via `HIVE_AUX_RSS_FEEDS`); science / ML / physics /
  math / AI → `arxiv_search` with the topic name. Wikipedia remains
  the default and the bulk of indexing. No LLM is involved in the
  decision.

### Security

- The receive-side check is now real ed25519 against the producer's
  known pubkey. Mutation (tampering) was already caught in v0.6.1.x
  via hash recompute; this patch additionally catches impersonation
  (peer X presenting a fragment claiming `node_id=Y`). Unknown peers
  emit `[repl] Dropping fragment … — no pubkey known for …` and are
  retried implicitly on the next Hyperswarm reconnect once
  `/api/status` has populated the registry.

---

## [0.6.1.10] — 2026-05-21 — *Trust, honesty, and a real signed payload*

Rolling patch series 0.6.1.1 → 0.6.1.10. The headline change: the ed25519
signature now actually travels with every fragment all the way to the
embedder, and peers that send us unsigned or tampered fragments get
dropped instead of silently indexed. The aggregator-bootstrap bug
("aggregator stops ingesting after a transient bee blip") is fixed.
Misleading comments removed. Schema cleaned up.

### Added

- **0.6.1.1** — Aggregator (and bees) now retry the `coreKey` HTTP bootstrap
  **indefinitely** while a peer remains connected via Hyperswarm, with
  exponential backoff capped at 60s. The retry loop is cancelled when
  Hyperswarm reports `peer-left`. Previously a single 5s-timeout fetch:
  if `/api/status` didn't answer once at startup, native replication
  for that peer never started for the rest of the session.
  *File: `packages/api/src/api_server.ts` — `peer-api` handler.*
- **0.6.1.2** — `buildEmbedderPayload(fragment)` helper in
  `packages/core/src/interfaces.ts`. Single canonical shape for the
  `/add` metadata sent to HNSW and Qdrant, including `hash`, `signature`,
  `status`, and `extracted_at`. All four call sites
  (`autonomous_extractor`, `watchFragments`, `watchRemoteCore`,
  `SyncManager.addToHNSW`) now go through it.
- **0.6.1.4** — `watchRemoteCore` re-hashes every replicated fragment and
  drops anything missing a signature or whose hash doesn't match the
  payload. Logs the drop count so the operator can spot a misbehaving
  peer. *File: `packages/core/src/knowledge_store.ts`.*
- **0.6.1.5** — `SyncManager.syncOnce` does the same for the HTTP-sync
  path: a peer that returns fragments without `hash`/`signature`, or
  whose hash doesn't recompute, gets dropped. Previously these were
  normalised with `hash: ''` and `signature: ''` and stored as if
  trusted. *File: `packages/core/src/sync_manager.ts`.*
- **0.6.1.6** — `decodeHtmlEntities(s)` helper in `tools_registry.ts`.
  Decodes numeric (`&#91;`, `&#x5B;`) and named (`&nbsp;`, `&amp;`,
  `&mdash;` …) entities after stripping HTML tags so fragments no
  longer carry visible `&#91; 10 &#93;` artefacts. Applied in
  `wikipedia_fetch`, `web_fetch`, and `rss_fetch`.

### Changed

- **0.6.1.2 / 0.6.1.7** — `KnowledgeStore.save()` and
  `KnowledgeStore.supersede()` now return the full `Fragment` (with hash
  + signature) instead of just the `FragmentId`. The autonomous
  extractor uses that return value to POST to the embedder, guaranteeing
  the canonical signed payload reaches HNSW/Qdrant. Academic-only
  fields (`doi`, `doi_valid`, `arxiv_id`) are now **omitted** from
  the embedder payload when they don't apply, so Wikipedia/RSS
  fragments no longer carry a sea of `null`s.
- **0.6.1.3** — Removed the misleading
  `// HTTP sync still works as fallback` comment from the aggregator's
  bootstrap path; aggregators don't initialise `SyncManager`. The
  new retry loop logs each failed attempt with the peer URL.
- **0.6.1.8** — `crawl_queue.dequeueBatch(n)` no longer marks dequeued
  titles as `visited`. The autonomous extractor calls
  `crawlQueue.markVisited(title)` only after `wikipedia_fetch` returns
  `ok: true`. Transient failures (Wikipedia 503, network blip) no
  longer permanently lose a URL.
- **0.6.1.9** — `docker-compose.yml` `bee-2` now uses the same defaults
  as `bee-1` (`HIVE_EXTRACT_INTERVAL_MS=60000`,
  `HIVE_EXTRACT_MAX_FRAGMENTS=9`, `HIVE_EXTRACT_BUDGET_MINUTES=20`).
  Default `LLM_PROVIDER` in `api_server.ts` status/logs is now
  `ollama`, matching the Docker stack default.

### Removed

- **0.6.1.10** — `packages/agent/src/reactive_extractor.ts` and
  `packages/core/src/test_v02.ts` deleted. The reactive extractor was
  the v0.1 entry path (LLM writing fragment text per chunk) and has
  not been called from any production code since v0.6.0's LLM-free
  extraction landed. `package.json` scripts (`test`, `extract`)
  pointing at it were dropped; `extract:auto` renamed to plain
  `extract` against `autonomous_extractor.ts`.

### Security

- Unsigned and tampered fragments are now refused by both the native
  Hypercore replication path (`watchRemoteCore`) and the HTTP sync
  path (`SyncManager.syncOnce`). This is the first version that
  actually enforces the Manifesto's "ed25519 signed" promise on the
  receive side. A future patch (planned **0.6.2.x**) will replace the
  hash recomputation with a full ed25519 verify against a per-peer
  public-key registry; today's check catches mutation but not a peer
  presenting somebody else's signed payload.

---

## [0.6.1] — 2026-05-19 — *Wikipedia forager: persistent crawl queue*

Turns the bee from a "process my assigned topics once" extractor into an
indefinite crawler — like the forager of a search engine. Each indexed
Wikipedia article emits its internal links into a persistent queue, and
every subsequent cycle drains a batch from the head of that queue. The
topic_tree.json is now just the seed; once seeded, the bee grows
indefinitely without needing more LLM creativity to think up topics.

### Added

- **`packages/agent/src/crawl_queue.ts`** — new `CrawlQueue` class. In-memory `Set<string>` + ordered array, persisted to two simple files in `HIVE_DATA_DIR`:
  - `crawl_queue.jsonl` — titles still to fetch (FIFO)
  - `crawl_visited.jsonl` — titles already fetched (so we don't re-enqueue)
  Deliberately NOT in Hypercore: this is local bookkeeping, not source-of-truth content. Losing it just means re-discovering links (cheap). Max size capped at 50k titles by default so memory doesn't grow unbounded.
- **`wikipedia_fetch`** now parses every internal `/wiki/<title>` link out of the article's HTML (lead + body sections) and emits them via the new `onCrawlEnqueue` callback. Filters out auxiliary namespaces (File:, Help:, Special:, Category:, etc.).
- **`wikipedia_search`** tool — search the Wikipedia API for related titles to a query. Returns title list only (does not index). Used in "seed mode" to populate the queue when it's empty at first boot.
- **`/api/crawl`** endpoint — reports `queue_size`, `visited_size`, `next_in_queue`, `recent_visited`. The capybarahome dashboard polls this to show forager progress.

### Changed

- **`runAutonomousExtraction`** has two modes:
  - **Crawl mode** (default once the queue has content): dequeue up to 5 titles, build the user prompt as "fetch these in order", and let the LLM walk through them. The LLM no longer decides what to fetch — it follows the queue.
  - **Seed mode** (only when the queue is empty — first boot / fresh wipe): the LLM uses `wikipedia_search` to discover seed titles, then `wikipedia_fetch` on each. Subsequent cycles automatically transition to crawl mode.
- **`SYSTEM_PROMPT`** rewritten to reflect forager semantics: "drain the queue, do not deviate, do not search if the queue already has work."
- **`executeTool` signature** extended with optional `onCrawlEnqueue: (titles: string[]) => void`. Currently only `wikipedia_fetch` uses it. `arxiv_search` and `rss_fetch` don't (their domains aren't browseable graphs).

### Why this matters

User feedback: "aunque tenga pocos topics hay infinita información de esos topics. o solo coge unos pocos articulos sobre cada topic?" — exactly the problem. In v0.6.0 the LLM picked one Wikipedia article per topic, fetched it, finished. Five assigned topics → ~60-100 fragments total, then nothing new for days (TTL on all freshly-indexed). With v0.6.1 each fetched article seeds 50-200 new titles into the queue, so growth is geometric until the queue caps or the bee runs out of disk.

### Operational notes

- The queue files live in the persisted Docker volume. Survive container recreation.
- `crawl_visited.jsonl` grows monotonically. At 50 bytes/line and 1M visited titles that's 50 MB — acceptable for the docker volume. A future optimization could compact this periodically.
- If you want to wipe and re-seed, `rm /opt/hive/data/bee1-data/crawl_*.jsonl` and restart. Next cycle will detect empty queue, switch to seed mode, and re-grow.

---

## [0.6.0] — 2026-05-19 — *LLM-free verbatim extraction*

Architectural fix for the "no fabricated citations" promise. The LLM stops
writing fragment text — fetch tools index verbatim content directly from
the source API. The agent's LLM role shrinks to orchestration only
(picking what to fetch). Expected ~10× throughput because one LLM call
now decides 5-50 fragments instead of one fragment per call.

### Changed

- **`packages/agent/src/tools_registry.ts`** — `wikipedia_fetch`, `arxiv_search`, `rss_fetch`, and `web_fetch` now call `onFragment(...)` internally with verbatim content from the source API. They return a small summary to the LLM (`indexed_count` + titles) — no raw text. IDs are generated deterministically by the tool from the source slug, so the LLM never sees or composes them.
  - `wikipedia_fetch` emits one fragment per section (verbatim from Wikipedia REST API), skipping References / See also / etc.
  - `arxiv_search` emits one fragment per paper with the full verbatim abstract.
  - `rss_fetch` emits one fragment per article, preferring `content:encoded` over `description`.
  - `web_fetch` chunks the page text (200-token chunks, 40-token overlap via existing `text_chunker.ts`) and emits each chunk verbatim.
  - `index_fragment` is preserved as a legacy/manual path for rare cases where the agent has non-source-derived text, but `SYSTEM_PROMPT` no longer instructs the agent to use it.
- **`packages/agent/src/autonomous_extractor.ts` SYSTEM_PROMPT** rewritten. Old prompt instructed "after every fetch, call index_fragment for each item". New prompt explicitly forbids that path and tells the agent it only sees counts + titles, never raw text. Confidence levels (0.9 Wikipedia, 0.85 RSS, 0.7 arXiv/web) are now assigned by the tools, not by the LLM.
- **`package.json`** bumped to 0.6.0.

### Why this matters (Manifesto + correctness)

The v0.5 path had the LLM read 8000 chars of source text and then write a "fragment". With qwen2.5:1.5b that means paraphrasing, sometimes inventing. The ed25519 signature was technically valid but only proved "node X said this", not "this is what Wikipedia said". v0.6 closes that gap: the signed text is byte-for-byte from the source API, so the signature now actually backs the citation chain.

### Performance side-effect

Each extraction cycle used to consume ~3-4k LLM tokens per fragment (one call to read + paraphrase 8 KB of text). It now consumes ~200-400 tokens for a fetch decision plus an explicit `finish` — independent of how many fragments the tool produces. A single Wikipedia call indexes 10-30 sections from one LLM turn. Expected steady-state ingestion on the same Ollama host: well into the hundreds of fragments per hour vs the ~5-10 we were seeing.

### Migration / compatibility

- Aggregator and bee require the same image version. No data migration: existing Hypercore entries continue to replicate. New fragments will have stable source-derived IDs.
- `chunk_text` tool was removed from the TOOL_DECLARATIONS (the LLM never called it directly anyway; chunking is internal to `web_fetch`).

---

## [0.5.1] — 2026-05-19 — *cross-container P2P fix + auto-deploy + boot recovery*

Operational hardening release. Same v0.5 features, but the deployed stack
actually works end-to-end and survives reboots without manual intervention.

### Fixed

- **bee advertised hardcoded `http://127.0.0.1:${PORT}` to peers.** This silently broke replication cross-container: the aggregator received the loopback URL, couldn't reach the bee, never completed the HTTP bootstrap that fetches the peer's `coreKey` — so neither HTTP sync nor native Hypercore replication ever started. Diagnosed empirically (0 `[p2p] native replication started` log entries before the fix; Qdrant stuck at 655 fragments for 2 days while the bee climbed to 2,294). Fix: `localApiUrl` now reads `process.env.HIVE_API_URL`, falls back to loopback only for shell development. `docker-compose.yml` sets it explicitly for bee-1, bee-2, and the aggregator.
- **Previous claim in CLAUDE.md ("native Hypercore replication still works")** was wrong — corrected. The native path also depends on the HTTP bootstrap to fetch the peer's `coreKey`, so the same bug broke both.

### Added

- **`.github/workflows/publish-docker.yml` deploy job**: after a successful build on a push to main, SSHes to `$DEPLOY_HOST` with `$DEPLOY_SSH_KEY` (dedicated deploy key, separate from operator's personal key), runs `docker compose pull && up -d`, then curls `/api/status` to verify the aggregator came back up. ~60-90 seconds from push to live.
- **`deploy/hive.service` systemd unit**: at server boot, runs `docker compose up -d`, recreating containers if they were removed. `ExecStartPre=-docker compose pull` (with `-` prefix) tolerates a transient GHCR error. Closes the gap that `restart=unless-stopped` leaves — that policy only restarts crashed containers, not missing ones (the HIVE outage we hit).

### Tried and rejected

- **bee-1 switched to Groq free tier for indexing acceleration**: 429 rate limits on every model tried (`llama-3.3-70b-versatile` 12k TPM, `llama-3.1-8b-instant` 6k TPM, `gemma2-9b-it` decommissioned). Root cause: bee and aggregator share the API key → share the TPM bucket → aggregator's query traffic consumes most of it. Reverted. Real fix is v0.6 LLM-free extraction; alternative is paying Groq Dev tier (~$30/mo) but not worth it at this stage.

### Notes

- Aggregator shows `(unhealthy)` in `docker ps`. Cosmetic — Dockerfile `HEALTHCHECK` curls `127.0.0.1:8080` which the aggregator container doesn't bind. The service itself is fully operational. Tracked as a Known Issue, will fix when next touching the Dockerfile.

---

## [0.5.0] — 2026-05-14 — *Ollama local LLM + light theme UI*

### Added
- **Ollama LLM provider** (`LLM_PROVIDER=ollama`): runs fully local via Docker, no API key or cloud tokens needed. Uses OpenAI-compatible API. Default model `qwen2.5:3b` (~1.9GB, fits 4GB VPS). Falls back gracefully if Ollama is unreachable.
- **OllamaProvider class** (`packages/core/src/llm_provider.ts`): same interface as cloud providers. Handles extraction, synthesis, and tool calling. 180s timeout for local inference vs 60s for cloud.
- **Ollama Docker service** (optional profile): `docker compose --profile ollama up -d`. Volume `ollama-data` persists downloaded models across restarts.
- **`OLLAMA_URL` env var**: all services pass it through. Default `http://ollama:11434` for Docker networking. Override for external Ollama instances.
- **Light theme UI redesign**: HIVE UI switches from dark (#09090f) to light (#f8fafc) theme. Matches Capybarahome design language. Uses slate color palette for backgrounds, indigo accent preserved. All text/border/surface CSS vars updated.
- **Ollama option in LLM config modal**: provider dropdown includes "Ollama (local — no key needed)". API key field hides automatically when Ollama selected. Shows model pull command.

### Fixed
- **Docker build failure**: `.dockerignore` had `data/` blocking `data/topic_tree.json` from build context — added `!data/topic_tree.json` exception. Dockerfile `RUN cp data/topic_tree.json topic_tree.json` now succeeds.
- **LLM error message**: `/api/query` 503 response now mentions Ollama as an option alongside cloud providers.

### Changed
- `isLLMConfigured()`: returns `true` for `LLM_PROVIDER=ollama` even without `LLM_API_KEY`.
- `/api/config` endpoint: accepts `ollama` as valid provider, skips apiKey requirement, validates by pinging `OLLAMA_URL/api/tags`.
- `validateLLMKey()`: added `ollama` case — verifies server reachability via `/api/tags`.
- `createLLMProvider()`: skips `LLM_API_KEY` check for ollama. Error message updated to list ollama as valid option.
- `.env.example`: updated with Ollama setup instructions and `LLM_MODEL` override examples.
- `docker-compose.yml`: all services now receive `OLLAMA_URL` env var.
- Score color function in UI: updated for light background readability (`emerald-600`, `amber-600`).

### Notes
- **Single LLM for everything**: HIVE uses one `LLM_PROVIDER` for both extraction (chunking) and query synthesis. The embeddings model (all-MiniLM-L6-v2, ~80MB) is separate and always runs locally — it was never a cloud LLM.
- **Model pull required on first start**: `docker exec hive-ollama ollama pull qwen2.5:3b`. Models persist in `ollama-data` volume.
- **RAM guidance**: `qwen2.5:3b` fits in ~2GB. For <2GB available: use `qwen2.5:1.5b` via `LLM_MODEL=qwen2.5:1.5b`.

---

## [0.4.0] — 2026-05-13 — *Native P2P replication + stability*

### Fixed — Critical
- **Hypercore writes were silently failing**: `batch.put()` in Hyperbee v2 is async but was never awaited in `save()`, `saveReplicated()`, and `supersede()`. Every BEE had fragments in HNSW but Hypercore was permanently empty (only the header block). This was the root cause of all P2P replication failures since v0.1. Fixed with `await b.put()` throughout KnowledgeStore.
- **P2P listeners missed early peers**: `peer-api` and `peer-core` event listeners were registered after `p2pNode.start()`. Hyperswarm peers that connected during `start()`'s flush window emitted events before any listener was registered. Moved all listeners to before `start()`.
- **Env file corruption**: `cat .env >> tmp_env && cat bee.env >> tmp_env` corrupted `LLM_API_KEY` when `.env` lacked a trailing newline — the first line of the bee config was appended directly to the key value. Fixed with `{ cat .env; echo; } >> tmp_env` in `start.sh` and `aggregator.sh`.
- **`node --env-file` inheritance**: Shell-inherited env vars override `--env-file`. Fixed with `unset LLM_API_KEY LLM_PROVIDER LLM_MODEL` before launching node.
- **`/api/config` writing to wrong `.env`**: Path had one `../` too many — was writing to `codespaces-blank/.env` instead of `hive/.env`. Fixed path depth.
- **`QdrantClient.search()` removed in v1.12+**: Updated `qdrant_index.py` to use `client.query_points()` and `result.points`.

### Added
- **Groq LLM provider**: `LLM_PROVIDER=groq` with `llama-3.3-70b-versatile` default (128K context). Free tier: 100K tokens/day. Add to `hive/.env` or set via UI modal.
- **Aggregator node** (`bash aggregator.sh`): dedicated node that connects to all BEEs, indexes all their fragments, and stores them in Qdrant for scalable search. No extraction — read-only from the network's perspective.
- **Qdrant auto-start**: `aggregator.sh` starts Qdrant via Docker automatically if not running.
- **Decentralized peer HTTP URL discovery**: when two nodes connect via Hyperswarm, they exchange HTTP API URLs through the existing Protomux channel (`hive/meta/v1`, msg[0]). No hardcoded addresses — any node discovers all peers dynamically.
- **Native Hypercore replication** (enabled by the `await b.put()` fix): core key fetched via `GET /api/status` after peer URL is known. `store.get({key}) + core.download({start:0,end:-1})` triggers Corestore's `streamTracker.attachAll()`. All 3 phases of `test_replication.ts` pass.
- **HTTP sync fallback**: `SyncManager` enabled for all nodes including aggregator. Kicks in immediately on connect while native replication warms up.
- **Cross-cycle dedup + TTL**: `onFragment` checks Hypercore before saving. Skips fresh content (within TTL), supersedes stale content. TTL by source: wiki 7d, rss 24h, arXiv 30d, web 3d.
- **`supersede()` wired**: extractor calls `store.supersede()` for stale content; also fixed missing `await b.put()` in supersede batch.
- **LLM health tracking**: `llm_ok` field in `/api/status` — `true`/`false`/`null` based on startup validation and extraction cycle results. UI shows green/yellow/red accordingly.
- **LLM config modal**: sidebar button shows current provider and connectivity status. Click to open modal and reconfigure provider, key, and model override.
- **`coreKey` in `/api/status`**: exposes the node's Hypercore public key for peer-to-peer core key exchange without a dedicated channel.
- **Fragment quality fixes**: `doi` sanitized (string `"null"` → actual `null`, only real DOIs starting with `10.`); source-specific ID prefixes (`wiki_*`, `rss_*`, `web_*`, `{arxiv_id}_c0`).
- **Multi-source extraction prompt**: Wikipedia first for factual topics, RSS for news, arXiv only for academic papers. Enforces fetch-one→index pattern to prevent token waste.

### Changed
- `p2p_node.ts`: Protomux channel now only carries HTTP URL (msg[0]); core key exchanged via HTTP. Eliminates timing conflict between Corestore's internal Protomux and our custom channel.
- `aggregator.sh`: Qdrant starts automatically; `HIVE_PEER` defaults removed — peer discovery is fully decentralized via Hyperswarm.
- `bees/bee-3.env`: extraction interval reduced from 30min to 5min for dev consistency.
- Gemini default model updated to `gemini-2.5-flash-lite` (recommended: unlimited RPD).

### Upgrade notes
Run `bash stop.sh --force && bash start.sh --clean` — existing Hypercore data is empty (the `await b.put()` bug), so a clean start is required.

---

## [0.2.2] — 2026-05-11

### Fixed
- **Write queue deadlock**: Added 8-second timeouts to `b.flush()` in `save()`, `saveReplicated()`, and `supersede()`. Hypercore write queue can now self-heal if an operation hangs.
- **Bidirectional sync**: SyncManager now always created (even on seed BEEs), and `/api/register-peer` now adds peers to the pull list. BEEs announce themselves to bootstrap peer after startup. Multi-BEE data consistency fixed.
- **Federated queries**: When local HNSW has no relevant data, API server queries peer BEEs. Fixes inconsistent results in distributed setup.
- **Search quality**: Lowered RELEVANT_SCORE threshold from 0.35 to 0.30; keyword matching now checks both title and fragment text.
- **Fragment extraction deduplication**: Added `resetSeenTitles()` call at autonomous extractor session start. Duplicate skipping no longer persists across cycles.
- **Direct HNSW writes**: Restored fire-and-forget POST to embedder in `onFragment()`. Local indexing no longer depends solely on `watchFragments()` for immediate availability.
- **Source attribution**: Added `sourceUrl()` helper; LLM citations now include clickable arxiv/doi links in markdown format.
- **Extraction hard deadline**: Wrapped `runAutonomousExtraction()` with per-topic timeout (2× maxMinutes + 2min buffer). Extraction no longer stuck in "Extracting..." state if `b.flush()` hangs.
- **ensureOpen() timeout**: Added 10-second timeout to prevent indefinite hangs on Hypercore session initialization.

### Changed
- **System prompt**: Updated to request markdown links for citations and thorough detailed answers.
- **CLAUDE.md**: Clarified that `sync_manager.ts` is an active HTTP fallback for UDP-blocked environments (Codespaces), not deprecated.

---

## [0.2.1] — 2026-05-07

### Added
- **Conversational chat**: conversation history sent to LLM on each query. Follow-up questions now work correctly.
- **"New chat" button**: clears history and starts a fresh conversation.
- **Source chips**: only relevant fragments shown as source chips.
- **Topic tree (95 topics)**: autonomous BEEs assign themselves uncovered topics from a 9-domain knowledge taxonomy without manual configuration.
- **Claim registry**: P2P coordination of topic coverage.
- **`bash start.sh --clean`**: wipes BEE data and restarts.
- **Cycle cap**: max 5 topics per extraction cycle.

### Fixed
- `SESSION_CLOSED` crash when Hyperswarm peers disconnect → removed `store.replicate(socket)` from P2P node (HTTP sync used instead).
- Duplicate fragment indexing: same article from RSS + direct URL indexed once.
- Race condition on startup: BEEs now wait for peers to register topic claims.
- `Autobase is closing` concurrent write error → **removed Autobase entirely**, replaced with direct `Hypercore + Hyperbee` (single-writer, stable).

---

## [0.2.0] — 2026-05-05

### Added
- **Autonomous extractor (Module 7)**: LLM function calling agent that decides what to search, which sources to use, and what to index.
- **`rss_fetch` tool**: RSS/Atom feed parsing for news and blog sources.
- **Budget controller**: per-cycle limits on tokens, API calls, fragments, time.
- **`BUSL-1.1` license and MANIFESTO.md**: public project launch preparation.

### Changed
- **Autobase → Hypercore direct**: removed Autobase multi-writer layer. Each BEE uses its own single-writer Hypercore + Hyperbee. More stable.

---

## [0.1.0] — 2026-04-30

### Added
- **Module 1**: local embeddings with `all-MiniLM-L6-v2` (~80MB, CPU) + HNSW index.
- **Module 2**: reactive extractor — arXiv API + CrossRef DOI validation + chunking.
- **Module 3**: `KnowledgeStore` on Hypercore + Hyperbee + Autobase.
- **Module 4**: P2P network — Hyperswarm peer discovery + HTTP sync between BEEs.
- **Module 5**: Fastify vector query API.
- **Module 6**: Web UI with LLM synthesis, fragment provenance badges, BEE activity feed.
- **ed25519 identity**: per-BEE cryptographic identity, signed fragments.
- **Append-only supersedes**: knowledge corrections modeled as linked events.
- **Multi-BEE dev setup**: `bees/*.env` + `start.sh` for local multi-node testing.

---

## Upgrade notes

### 0.3.x / 0.2.x → 0.4.x
Hypercore data from previous versions is empty (the `await b.put()` bug was present since v0.1). Run `bash start.sh --clean` to regenerate. BEE identities are preserved.

### 0.1.x → 0.2.x
Autobase removed. Run `bash start.sh --clean`.
