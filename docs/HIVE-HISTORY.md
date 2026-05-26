### v0.7.5 — Manifest→extractor wiring
`autonomous_extractor.ts` now reads `store.getLocalManifest()` at the start
of every extraction cycle. `declared_sources` from the BEE's own manifest
determines which source adapters run and in what configuration:

- **wikipedia-en**: Wikipedia BFS crawl (existing). If `scope.category_tree`
  is set (e.g. `"Category:Medicine"`), that string is used as the seed
  query instead of the LLM objective.
- **arxiv**: arXiv abstract fetch. If `scope.categories` is set
  (e.g. `["cs.AI", "stat.ML"]`), those are passed as seed query.
- **rss**: RSS feed fetch. If `scope.feeds` is set, those feed URLs are used
  instead of `HIVE_AUX_RSS_FEEDS` env var or the BBC default.
- **common-crawl**: Common Crawl CDX+WARC fetch. Requires `scope.domains`
  and optionally `scope.snapshot`. Never runs as a heuristic — explicit
  declaration required.

Fallback (no manifest published yet): `[{id:"wikipedia-en", policy:"drift-ok"}]`
— bit-for-bit identical to v0.6 behaviour.

Backward-compat: arXiv and RSS still run as objective-text heuristics when
no manifest is present (pre-v0.7.3 bees). Once a manifest is published both
heuristics are disabled — the manifest is the sole authority on sources.

### v0.7.4 — Common Crawl CDX + WARC adapter
`packages/agent/src/forager/common_crawl_source.ts` — first non-curated
open-web source. Implements `ForagerSource` via:

1. **CDX API** (`index.commoncrawl.org/{snapshot}-index`) — domain query
   returns NDJSON with `{ filename, offset, length, url }` WARC entries.
2. **WARC range fetch** (`data.commoncrawl.org/{filename}`) — HTTP `Range:
   bytes=offset-end` retrieves a single independently-gzip-compressed record.
3. **WARC parse → HTML strip → chunk** — `parseWarcBody()` extracts HTML
   body from WARC headers + HTTP headers; `stripHtml()` removes tags; text
   is chunked via `chunkText()` at 350-token / 50-token overlap.

Fragment IDs: `cc_{slugify(url)}[_cN]`. Confidence: 0.65 (lower than
Wikipedia 0.9 — CC pages are unvetted public web).

Scope: `{ domains: ["pubmed.ncbi.nlm.nih.gov"], snapshot: "CC-MAIN-2025-08" }`.
Two BEEs with the same snapshot + domains reach the same URL set
independently → satisfies the reproducibility rule.

### v0.7.3 — BeeManifest: source-driven identity
`packages/core/src/bee_manifest.ts` — `BeeManifest` type + `DeclaredSource`
interface. Every BEE publishes its manifest to Hyperbee at startup
(`bee:manifest` key). Queens read remote manifests in `watchRemoteCore` →
`getRemoteManifests()`. `GET /api/directory` endpoint returns all known
BeeManifests. New env vars: `HIVE_SOURCES`, `HIVE_POLICY`, `HIVE_SCOPE`,
`HIVE_BEE_REPLICATE`, `HIVE_LANGUAGES`. `topic_tree.json` deprecation
warning added in `loadTree()`.

### v0.7.2 — arXiv / RSS / web migrated to ForagerSource adapters
Completes what v0.7.1 started. `tools_registry.ts` is deleted (~600
LoC of dead code); `autonomous_extractor.ts` no longer imports
`executeTool`. Four adapters now live in `packages/agent/src/forager/`:
`wikipedia_source` (v0.7.1), `arxiv_source`, `rss_source`,
`web_source`. Behaviour is bit-for-bit identical to v0.6 — same ids,
same chunking, same TTLs, same user-agents — but the seam is now
the interface contract instead of a switch statement.

Two operational fixes shipped alongside:

- **Dockerfile slim**: torch installed from PyTorch CPU wheel index
  before sentence-transformers. Image drops from ~10 GB to ~1-2 GB
  on disk per build. Stops nine dangling `:latest` layers from
  filling a 75 GB VPS in nine deploys.
- **CI auto-prune**: `docker image prune -f` between pull and up,
  dangling-only so opt-in images like `ollama/ollama:latest`
  survive across profile toggles.

### v0.7.1 — `ForagerSource` interface + WikipediaSource adapter
First step of the source-driven refactor. The Wikipedia path inside
`autonomous_extractor.ts` no longer calls `executeTool('wikipedia_*')`;
it calls `wikipediaSource.seed()` / `wikipediaSource.fetch()` which
return `FetchResult { fragments, outboundLinks, refreshPolicy }`. The
adapter speaks URLs publicly so a future generic forager can dispatch
a discovered link via `owns(url)`.

What did NOT change: fragment IDs (`wiki_<slug>_<section>[_cN]`) are
identical to v0.6, so existing Hypercores dedup against new extraction
correctly. Aux RSS/arXiv branches still use `executeTool` — they
migrate to adapters in v0.7.2. CrawlQueue still stores titles; v0.7.3
migrates the queue to URL storage when it grows the manifest format.

### v0.7.0.6 — Default mode is `bee`; CI deploys from git checkout
Two production lessons from the v0.7.0 deploy:

- The binary's default `HIVE_MODE` is now **`bee`** (was `hive`). Most
  operators just want to contribute to the network, not run a full
  node. Defaulting to `hive` meant a fresh `bash hive.sh` demanded an
  LLM key the operator may not have. Bee mode boots in ~10 s, no key
  required, joins the network and starts indexing. To get an
  all-in-one node, set `HIVE_MODE=hive` explicitly.
- `hive.sh` reads `HIVE_MODE` and only starts the Python embedder when
  the mode needs it (queen / hive). v0.7.0 was launching the embedder
  unconditionally inside bee containers — ~80 MB of wasted RAM per
  bee. Fixed.
- CI now does `git pull --ff-only` on the server before
  `docker compose up -d --remove-orphans`. v0.7.0's CI only pulled the
  image, leaving `/opt/hive/docker-compose.yml` stale on the server —
  the `aggregator` → `queen` rename never reached production. From
  now on `/opt/hive` is a git checkout of `main`.

### v0.7.0 — `HIVE_MODE` lands (bee | queen | hive)
The architectural split documented in the v0.7.0 roadmap section is
now shipped. `HIVE_MODE=bee` runs a producer-only node (extractor +
own Hypercore, no `/api/query`, no peer-core replication). `queen`
(renamed from `aggregator`) runs the consumer-only node (Qdrant
index + `/api/query` + LLM synthesis). `hive` (the default when
`HIVE_MODE` is unset) keeps v0.6 behaviour — everything in one
process — and is what `bash hive.sh` and the legacy
single-container quickstart produce.

Shipped pieces:
- **v0.7.0.1** — `HIVE_MODE` env + six capability flags
  (`HAS_EXTRACTOR`, `HAS_LOCAL_STORE`, `HAS_QUERY_API`,
  `HAS_LOCAL_EMBED`, `HAS_REMOTE_REPLICATION`, `HAS_DASHBOARD_PROXY`).
  `aggregator` accepted as a v0.6 alias with a deprecation warning.
- **v0.7.0.2** — flags wired through `api_server.ts`: peer-meta
  handler, `watchFragments`, `/api/query` registration,
  `/api/fragments` source selection, extractor lifecycle, startup
  logs.
- **v0.7.0.3** — UI conditional rendering. `<body data-hive-mode>`
  drives `.hide-on-bee` / `.hide-on-queen` CSS. Bee gets a
  producer-identity welcome card; queen lights up the topbar badge.
- **v0.7.0.4** — `docker-compose.yml` rename `aggregator` → `queen`
  (container `hive-queen`). Volume `aggregator-data` preserved for
  zero-loss migration. Network alias `aggregator` on the queen
  service for backward-compat with external consumers. Bees get
  explicit `HIVE_MODE=bee`. `queen.sh` is the new launcher;
  `aggregator.sh` reduced to a deprecation wrapper.
- **v0.7.0.5** — docs alignment: this entry, CHANGELOG, README
  migration table, capybarahome `/hive` page updated.

What v0.7.0 explicitly does **not** ship yet (planned for v0.7.1+):
the source-driven refactor (`ForagerSource` interface, manifests,
`scope`/`policy`), `HIVE_BEE_REPLICATE`, the recovery ladder, and
HNSW removal from bees.

### v0.6.4.4 — Qdrant readiness + runtime persistence (previous stable)
The last v0.6 line. The v0.7.0 release-candidate inherits all of
v0.6.4's properties (zero HTTP between nodes, Protomux v2,
ed25519-verified replication, persistent runtime config) and adds
the role split on top.

### v0.6.4 — Zero HTTP between nodes
The bee↔aggregator channel is exclusively Hyperswarm + Hypercore.
The Protomux `hive/meta/v2` channel carries `{nodeId, publicKey,
coreKey, claimsCoreKey}` in a single message at connection time.
`SyncManager`, `/api/register-peer`, `/api/claims` pull, federated
HTTP query, and the aggregator's `/api/crawl` proxy are all gone.
`HIVE_PEER` and `HIVE_API_URL` are deprecated (warned on boot,
otherwise ignored). The only HTTP from node-to-node anywhere in
the codebase since v0.6.4 is **none**.

### v0.6.4.1 — Protomux protocol bump + decode safety
A bug surfaced live: pre-v0.6.4 peers on the public Hyperswarm DHT
(e.g. the old Hetzner aggregator) send the old string `apiUrl`
payload over `hive/meta/v1`. New nodes opening `hive/meta/v2`
don't see those peers and old peers don't see new ones — clean
split. Decoder is `try/catch`ed so a malformed payload never
crashes the bee.

### v0.6.4.2 — Ollama opt-in, Gemini default
Ollama + ollama-init moved behind the `ollama` Docker profile.
Default LLM is Gemini Flash Lite. `docker-compose.yml` ships
without Ollama by default; activate with
`docker compose --profile ollama up -d`. Frees ~2 GB on
cloud-LLM deployments.

### v0.6.4.3 — Runtime config persistence
`POST /api/config` (the UI's provider switcher) now writes to
`${HIVE_DATA_DIR}/.runtime.env` (mounted) instead of `/hive/.env`
(ephemeral). Loaded at boot before any LLM check. Fixes the bug
where UI-set provider was lost on every container recreate —
production found this today after adding bee-2: original Gemini
override vanished, bees fell back to whatever the host's
docker-compose env-var resolved to (which was `ollama`).

### v0.6.4.4 — Qdrant race-condition fix
`depends_on: qdrant: condition: service_started` did NOT wait until
Qdrant accepted connections. Aggregator on cold start would
silently fall through to the in-process HNSW backend and serve
queries from an empty index while the 34k-vector persistent
collection sat untouched in the qdrant-data volume. Fixed by:
- Adding a `healthcheck` to qdrant polling `/readyz` (not
  `/healthz` — the latter returns 200 while storage is still
  being opened on cold start).
- Changing aggregator's `depends_on: qdrant` to
  `condition: service_healthy`.
- `aggregator.sh` distinguishes "QDRANT_URL was set explicitly"
  (wait, hard-fail if never ready — never silently lose
  persistence) from "QDRANT_URL was empty" (legacy auto-start
  path, may fall back to HNSW).

### v0.6.2.x — Trust + extraction quality
- `PeerRegistry` (`packages/core/src/peer_registry.ts`) holds
  `node_id → publicKey` learnt during the meta exchange.
  `watchRemoteCore` and (former) `SyncManager` run a full
  `verifySignature({id, hash}, signature, pubkey)` on every
  replicated fragment. Drop counters distinguish unsigned /
  tampered / unknown-peer.
- `wikipedia_fetch` now indexes H3 subsections as their own
  fragments. Long sections chunked via `text_chunker` (350
  tokens, 50 overlap) — no more `slice(0, 1000)`.
- `watchFragments` + `watchRemoteCore` self-heal: for-await
  loop wrapped in restart-on-error with exp backoff.
- `ClaimRegistry.releaseExpired()` called at the top of each
  extraction cycle to free topics from dead BEEs.
- Auxiliary fetch by rule: news/current_events → `rss_fetch`,
  science/ML/physics → `arxiv_search`. Wikipedia remains the
  bulk source.

### v0.6.3.x — Replicated claims + Hypercore-served fragments
- `ClaimRegistry` accepts a shared `Corestore` (v0.6.3.4): the
  `claims` Hypercore lives alongside the `fragments` core and
  replicates over the same Hyperswarm socket. `/api/status`
  exposes `claimsCoreKey`. Each peer's claims core is opened
  read-only and streamed via `watchRemoteClaims`.
- `GET /api/fragments` reads from Hypercore in BEE mode
  (signed payload with hash + signature). Aggregator still reads
  from Qdrant since it owns no local Hypercore.

### Wikipedia forager (carried over from v0.6.1)
The bee is an indefinite crawler. Every `wikipedia_fetch` emits
the internal `/wiki/` links it finds into a persistent queue
(`crawl_queue.jsonl` in the data volume). Each cycle dequeues a
batch of 5 titles from the head. The LLM stops choosing topics
— it walks the queue. `topic_tree.json` is only the seed; once
seeded, growth is geometric.

`/api/crawl` exposes `queue_size`, `visited_size`,
`next_in_queue`, `recent_visited` for the dashboard.

### Two modes inside `runAutonomousExtraction`

- **Crawl mode** (default, queue non-empty): user prompt is "fetch these
  titles in order: A, B, C, D, E". No exploration. No LLM creativity.
    Just walk the forager's BFS frontier.
    - **Seed mode** (queue empty, first boot or post-wipe): LLM uses
      `wikipedia_search` to find 5-10 seed titles, fetches them, finishes.
        The fetches populate the queue → next cycle is in crawl mode.

        ## Previous state: v0.6.0 — LLM-free verbatim extraction

        v0.6.0 is the architectural fix promised in the v0.5 changelog: the LLM
        stops writing fragment text. Fetch tools (`wikipedia_fetch`, `arxiv_search`,
        `rss_fetch`, `web_fetch`) now call `onFragment` internally with content
        taken byte-for-byte from the source API. The agent's LLM is reduced to
        orchestration (choosing what to fetch). Expected throughput jumps from
        ~5-10 fragments/hour on Ollama CPU to hundreds, because one LLM turn
        now produces 5-50 fragments instead of one.

        The Manifesto's "no fabricated citations" promise is finally enforceable:
        the ed25519 signature now actually backs verbatim source content, not a
        paraphrase the LLM invented.

        ### What v0.6.0 changed (see CHANGELOG for full detail)

        - `packages/agent/src/tools_registry.ts` — all four fetch tools call
          `onFragment(...)` internally with verbatim content; their return value
            to the LLM is a short summary (`indexed_count`, titles), never raw text.
            - `packages/agent/src/autonomous_extractor.ts` — `SYSTEM_PROMPT` rewritten.
              Old workflow ("after each fetch, call `index_fragment` for every
                section") is explicitly forbidden. The LLM only sees counts and titles,
                  not text. `index_fragment` is kept as a legacy/manual path but the
                    prompt steers the agent away from it.

                    ### Carried over from v0.5.1

                    ### What v0.5.1 shipped

                    | Item | Why | Where |
                    |------|-----|-------|
                    | `HIVE_API_URL` env var | bee was hardcoding `http://127.0.0.1:${PORT}` as its peer-reachable URL. In Docker that resolves to *the peer's* loopback, so neither HTTP sync nor the HTTP-bootstrap of native Hypercore replication ever connected cross-container → aggregator stayed at 655 fragments while bee climbed to 2,294+ over 2 days | `packages/api/src/api_server.ts` + 3 places in `docker-compose.yml` |
                    | Auto-deploy on push to main | Mirror of what cAPY has. Workflow SSHes to server (dedicated `DEPLOY_SSH_KEY` secret), pulls image, recreates stack, verifies `/api/status` | `.github/workflows/publish-docker.yml` |
                    | `deploy/hive.service` systemd unit | Stack returns at boot even if containers were removed (the outage we hit: `restart=unless-stopped` doesn't save you from missing containers, only from crashed ones). `ExecStartPre=-docker compose pull` tolerates GHCR hiccups | `deploy/hive.service` |

                    ### Empirical validation after the v0.5.1 fix (2026-05-19)

                    Before fix: aggregator `peers=0`, `[sync] Peer http://127.0.0.1:8080 unreachable` looping forever in logs, Qdrant stuck at **655** for days.
                    After fix (within 90s of redeploy): `[p2p] Peer connected: b70fdf81575eab07 (total: 1)`, `Got API URL from b70fdf81575eab07: http://bee-1:8080`, `Core key fetched ... native replication started`. Qdrant went **655 → 1540** in the first 90 seconds as the backlog drained over Hypercore replication. Continues catching up live thereafter.

                    ### What v0.5.1 did NOT fix

                    - **Indexing rate stays ~5-10 fragments/hour on Ollama CPU**. Tried switching bee-1 to Groq free tier as an acceleration, but free-tier Groq is unsuitable for this workload because (1) `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` have only 6k-12k TPM on free tier, and (2) the bee and aggregator share the same API key → they share the TPM bucket → the aggregator's query traffic eats into the bee's extraction budget, every extractor cycle 429s on rate limits. Reverted bee-1 to Ollama. The real fix is v0.6 (LLM-free extraction), not throwing more LLM at it.
                    - **Aggregator's `(unhealthy)` status in `docker ps`** is cosmetic — the Dockerfile `HEALTHCHECK` curls `127.0.0.1:8080` which doesn't exist inside the aggregator container. The aggregator itself is fully operational (peers=1, replication active, queries served). Leave it; fixing the healthcheck doesn't change behaviour.

                    All 7 modules complete. Native P2P replication fixed in v0.4. Ollama + major extraction improvements added in v0.5.

                    | Module | Description | Status |
                    |--------|-------------|--------|
                    | 1 | Embeddings + HNSW (all-MiniLM-L6-v2, 80MB CPU) | ✅ |
                    | 2 | Extractor: wikipedia_fetch (sections API) + rss_fetch + arxiv_search + web_fetch | ✅ |
                    | 3 | KnowledgeStore — Hypercore + Hyperbee, ed25519-signed | ✅ |
                    | 4 | P2P — Hyperswarm discovery + native Hypercore replication | ✅ fixed v0.4 |
                    | 5 | Vector query API (Fastify) + federated queries | ✅ |
                    | 6 | UI with LLM synthesis (Groq / Gemini / Claude / OpenAI / Ollama) — light theme | ✅ |
                    | 7 | Autonomous extractor + topic tree + claim registry + TTL/supersede | ✅ |
                    | — | Aggregator node + Qdrant backend | ✅ added v0.4 |
                    | — | Ollama local LLM provider (no API key) | ✅ added v0.5 |
                    | — | wikipedia_fetch tool using Wikipedia sections REST API | ✅ added v0.5 |
                    | — | HIVE_EXTRACT_BUDGET_MINUTES — configurable per-topic time budget | ✅ added v0.5 |

                    **Added beyond original spec:**
                    - Aggregator node + Qdrant backend
                    - Multi-provider LLM: Groq, Gemini, Claude, OpenAI, Ollama (local)
                    - TTL + supersede wired in extractor
                    - Light theme UI
                    - `wikipedia_fetch` tool with Wikipedia REST API (sections, not HTML scraping)
                    - `HIVE_EXTRACT_BUDGET_MINUTES` env var

                    **In original spec, not yet implemented:**
                    - `Autobase` multi-writer → **abandoned** (see decision below)
                    - `IConsensus` multi-agent fragment quality voting → **replaced by score-by-corroboration in v0.7** (lighter, non-bizantine alternative)
                    - Signature verification on receive → **✅ done v0.6.2.1** (full ed25519 against peer's pubkey)
                    - Replication factor ≥ 3 → **v0.7+**
                    - LLM-free verbatim extraction → **✅ done v0.6** (see architectural decision below)
                    - Semantic routing / VecDHT → **v0.7+** (requires role split first)
                    - Token economics (WDK) → **v0.7+**

                    **Architectural changes planned but not yet implemented:**
                    - **v0.7.0 role separation** (bee = producer, aggregator = consumer, full = both) — see Roadmap below.
                    - **Drop HNSW from bees** (after v0.7.0) — bees no longer host queries, no need for local vector index. -200 MB Docker image.

                    ---

                    ## Roadmap

                    ### v0.6.4.x — In-flight (current)
                    Already shipped: 0.6.4.1 (protocol bump + decoder safety),
                    0.6.4.2 (ollama opt-in + Gemini default), 0.6.4.3 (runtime
                    config persistence), 0.6.4.4 (qdrant race-condition fix).

                    Open patches:

                    | Item | Why | Notes |
                    |------|-----|-------|
                    | **v0.6.4.5** — HNSW wrapper upsert semantics | After container recreate, bee's `indexed` count is far below the Hypercore length because `usearch` rejects duplicate-label adds during replay. Hypercore is fine, queries via the aggregator are fine, but the bee dashboard misreports its own coverage. | Fix in `packages/embeddings/hnsw_index.py`: dedupe by id before re-adding, or rotate labels deterministically. ~20 LoC. |

                    ### v0.7.0 — `bee` vs `queen` (architectural separation)
                    The biggest design change planned. The framing: this
                    split amplifies Hypercore's single-writer pattern, it
                    does not break it.

                    **Today (v0.6.x)**: a single bee binary does everything —
                    extract + sign + serve queries + LLM synthesis + embedder
                    + HNSW. The bee Docker image drags Python +
                    sentence-transformers (200 MB) + HNSW + LLM config just
                    to answer queries that 99% of users won't issue directly
                    to a bee anyway.

                    **v0.7.0**: same codebase, same image, **mode selected at
                    runtime** by `HIVE_MODE`:

                    | Mode | Role | Components active | RAM | Use case |
                    |------|------|-------------------|-----|----------|
                    | `bee` (NEW DEFAULT) | producer | extractor + Hypercore + Hyperswarm | ~150 MB | publisher-only, Raspberry-Pi friendly, contribute to the network |
                    | `queen` (renamed from `aggregator`) | consumer / indexer | + Qdrant + embedder + LLM | ~600 MB | consumer-facing query endpoint; can be public or private/vertical |
                    | `hive` (NEW, backward-compat) | both | both in one process | ~700 MB | single-machine quickstart — preserves v0.6 behaviour |

                    **Practical impact on a 4 GB VPS** (the Hetzner instance):

                    | Stack | Today (v0.6.x) | After v0.7 |
                    |-------|----------------|------------|
                    | 1 bee + 1 queen + qdrant + caddy + capy services | ~2.0 GB (works) | ~1.4 GB (very comfortable) |
                    | 2 bees + 1 queen + qdrant + caddy + capy services | ~2.7 GB (apretado, hit OOM today) | ~1.6 GB (comfortable) |
                    | 4 bees + 1 queen + qdrant + caddy + capy services | OOM | ~1.9 GB (still room) |

                    The whole point of the split is "make it cheap to be a
                    producer". Today the producer Docker image carries an
                    embedder + a vector index it doesn't need, which is the
                    main reason a 4 GB VPS can't host more than one bee.

                    #### UI in v0.7

                    Same `index.html`, **conditional rendering by mode**.
                    The UI distinguishes *operational* views (does my
                    node work?) from *consumer* views (what does the
                    network know?):

                    | Section | `bee` | `queen` | `hive` |
                    |---------|:-:|:-:|:-:|
                    | Logo + version + mode badge | ✓ | ✓ | ✓ |
                    | LLM provider config | ✗ | ✓ | ✓ |
                    | Extraction activity feed | ✓ | ✗ | ✓ |
                    | Forager / crawl-queue state | ✓ | ✗ | ✓ |
                    | Connected peers list | ✓ | ✓ | ✓ |
                    | Search box + LLM synthesis | ✗ | ✓ | ✓ |
                    | Fragments listing | ✓ (from Hypercore) | ✓ (from Qdrant) | ✓ |

                    No code duplication — about 50 LoC of JS to hide
                    sections based on the `mode` field of `/api/status`.
                    Zero runtime cost (UI is static files served by
                    Fastify); the only thing we'd gain by removing the
                    UI entirely is ~150 KB in the Docker image.

                    A future `HIVE_NO_UI=1` env flag could disable the
                    static plugin for headless flotilla deployments
                    (v0.8+).

                    The terminology change `aggregator` → `queen` keeps the
                    bee metaphor consistent: in nature, the queen organises
                    the hive, doesn't forage. Operators may run a queen for
                    their own vertical (science / news / private corp) and
                    point it at whichever bees they want to index.

                    Why this is Holepunch-native, not a betrayal of P2P:

                    - **Hypercore is single-writer by design**. The bee=producer
                      / queen=consumer split *amplifies* that, doesn't break
                      it.
                    - **Holepunch's own apps follow this pattern**: Keet has
                      one Hypercore per user (write your own); other users
                      open it read-only; the Keet client itself is the
                      "consumer" that follows N hypercores. We replicate that
                      shape with `bee` + `queen`.
                    - **No mandatory queen**: anyone can run `HIVE_MODE=queen`
                      indexing whatever subset of bees they care about. No
                      "HIVE Inc." middle layer.
                    - **The only thing the split loses** is "single binary
                      auto-everything" — i.e., the convenience that today
                      `bash hive.sh` gives you a node that also answers
                      queries. We preserve that as `HIVE_MODE=hive` for
                      backward compat. It's not a regression, it's an
                      honest split for operators who want lean producers.
                    - **Enables VecDHT properly** (v0.7+ next item). Routing
                      queries semantically to relevant bees only makes sense
                      when the consumer-node is a distinct entity, not just
                      another producer that happens to also have a vector
                      index.

                    ### v0.7 — Architectural refactor: from topic-driven to source-driven

                    #### Motivation

                    v0.6.x ships a working but architecturally inconsistent topic system:

                    - `data/topic_tree.json` is a static, committed taxonomy (95 nodes, 9 domains) — a soft point of centralisation in an otherwise P2P system.
                    - Since v0.6.1 the Wikipedia forager has reduced the topic tree to a seed file: after first boot, growth is link-driven, not topic-driven. The tree is read once and effectively bypassed.
                    - The previously-planned "expand topic tree to 5000+ nodes" TODO assumes the tree governs indexing. It doesn't anymore. The TODO is obsolete.
                    - Per-source fetch tools (`wikipedia_fetch`, `arxiv_search`, `rss_fetch`, `web_fetch`) implement heterogeneous logic. Only Wikipedia has a real forager. Adding a new source today means writing both an adapter and ad-hoc orchestration.

                    The v0.7 refactor replaces topic-as-unit-of-coordination with **source-as-unit-of-coordination**, and unifies extraction behind a generic forager that treats every source through the same interface.

                    This reframes what HIVE is:

                    > HIVE does not decide what topics exist or which sources matter. HIVE provides a mechanism for any publicly-identifiable, objectively-reproducible source to be extracted by any BEE that chooses to cover it, with cryptographic traceability of the process.

                    #### Why source-driven, not topic-driven

                    - **Topics are subjective.** "Is paediatric oncology under paediatrics or oncology?" has no canonical answer. Imposing one is editorial.
                    - **Sources are objective.** "Does pubmed.ncbi.nlm.nih.gov exist?" has a yes/no answer. So does "is this Common Crawl snapshot 2026-04 reachable?".
                    - **Sources align with single-writer + manifest self-declaration.** A BEE declares the sources it covers as part of its identity. A topic claim is a promise; a source declaration is an operational commitment.
                    - **Sources enable real corroboration.** Two BEEs extracting from the same source produce comparable fragments. Two BEEs claiming the same "topic" may be extracting from incompatible places. Cross-source corroboration only becomes meaningful with source diversity, and source diversity requires the architecture to treat sources as first-class.
                    - **Symmetry test for "is this proposal centralising?":** if HIVE ships a curated list of sources in code, we have reproduced the topic-tree problem under a different name. The refactor must avoid that.

                    #### Architectural pieces

                    **1. Unified ForagerInterface.** A single interface every source adapter implements:

                    ```ts
                    interface ForagerSource {
                      readonly id: string;                    // e.g. "wikipedia-en", "arxiv", "common-crawl-2026-04"
                      readonly displayName: string;
                      readonly licence: string;               // e.g. "CC-BY-SA-4.0", "public-domain"
                      seed(opts: SeedOptions): Promise<string[]>;
                      fetch(url: string): Promise<{
                        fragments: VerbatimFragment[];
                        outboundLinks: string[];
                        refreshPolicy: { ttlSeconds: number };
                      }>;
                      normalize(url: string): string;         // canonical URL
                      owns(url: string): boolean;             // does this URL belong to this source?
                    }
                    ```

                    The generic forager owns the queue, visited set, dedup, budgeting, claims coordination, and supersede logic. Source adapters only know how to talk to their respective source. Adding a source = one file implementing the interface. The crawl-mode/seed-mode dynamic from v0.6.1 generalises to all sources. `wikipedia_fetch`, `arxiv_search`, `rss_fetch` etc. are reduced to thin wrappers during transition.

                    **2. Source declaration in BEE manifest.** Each BEE publishes a self-declared manifest at the start of its Hypercore:

                    ```json
                    {
                      "bee_id": "<ed25519 pubkey>",
                      "operator": "<free-text>",
                      "declared_sources": [
                        {
                          "id": "wikipedia-en",
                          "config": { "language": "en" },
                          "scope":  { "category_tree": "Category:Medicine" },
                          "policy": "exclusive"
                        },
                        {
                          "id": "arxiv",
                          "config": { "categories": ["q-bio.QM"] },
                          "scope":  { "categories": ["q-bio.QM"] },
                          "policy": "exclusive"
                        }
                      ],
                      "declared_languages": ["en", "es"],
                      "replication": "neighbors",
                      "version": "0.7.0"
                    }
                    ```

                    Declaration is self-sovereign: no central registry approves anything. Queens read manifests from the BEEs they replicate and build a directory of "which BEEs cover which sources". Reputation per source emerges from observation — does this BEE actually publish what it declares? Discrepancy is a signal, not enforced.

                    **Fields explained:**

                    - `id` — canonical source identifier. Must match a `ForagerSource` adapter shipped in the binary (or loaded as a plug-in).
                    - `config` — adapter-specific runtime config (language, API key for premium feeds, etc.).
                    - `scope` *(optional)* — constraint *within* the source. Per-adapter shape:
                      - Wikipedia: `category_tree` root (e.g. `"Category:Medicine"`) — forager only follows links inside the transitive closure of that tree.
                      - arXiv: `categories` list (e.g. `["q-bio.QM", "stat.AP"]`).
                      - Common Crawl: `domains` list, `language` filter, snapshot ID.
                      - RSS: feed URL whitelist.
                    - `policy` — what the forager does with out-of-scope links it discovers:
                      - `"exclusive"` — drop them. Bee stays focused. Best for specialists ("medicine bee", "ML papers bee").
                      - `"drift-ok"` — follow anyway, marking the fragment with `out_of_scope: true`. This is the v0.6 behaviour — link-driven BFS without constraints.
                    - `replication` — see "Bee replication topology" below. Values: `"none" | "neighbors" | "all"`.

                    **How a BEE picks its scope.** In v0.7.0/.1/.2 the scope comes from env vars or a manifest file the operator writes. In v0.7.x+ a bee can auto-discover an under-covered scope by reading neighbouring queens' directories. Either way, **the scope is operator-declared, not network-imposed.**

                    **Drift control.** Without a `scope`, a Wikipedia BEE that starts on "Aspirin" will, via BFS, reach "Michael Jackson" within ~6 hops. That is the v0.6 reality. `policy: "exclusive"` solves it: the adapter's `isInScope(url, scope)` runs before every fetch; out-of-scope links never enter the queue.

                    **Dead-end recovery.** A bee with `policy: "exclusive"` *will* eventually exhaust its scope (forager metric: `new_links_per_cycle → 0` and queue depth at floor). The bee should not sit idle. Recovery ladder, applied automatically:

                    1. **Expand scope to parent** — Wikipedia category tree has parents; arXiv categories have super-categories. One step up, retry.
                    2. **Switch to a sibling scope** — if the bee declared multiple sources, rotate to the one with most remaining frontier.
                    3. **Temporarily relax `policy` to `drift-ok`** — finite TTL, logs the relaxation.
                    4. **Announce "scope-exhausted"** in the manifest — neighbouring queens see it; a human operator (or future auto-discovery) can assign a new scope.

                    The recovery ladder is configurable per bee (`on_exhausted: ["expand", "rotate", "drift", "announce"]`). Default is the full ladder. A research-grade "stay focused or die" bee can set `["announce"]` only.

                    **3. No source tree in code.** This is the architectural commitment. The repo must not contain a `sources.json` analogous to today's `topic_tree.json`. Three layers cover the legitimate needs:

                    - `docs/suggested-sources.md` — human-readable, non-authoritative. Lists sources that make sense to cover, with example adapter configs. **Code never reads this.** Pure orientation for new operators.
                    - **Quickstart defaults** — `docker compose up` starts a BEE pre-configured for Wikipedia EN as a sensible default. Starting example, not doctrine. Operator changes it via env vars or manifest.
                    - **Per-BEE manifest** (above) — the actual operational source of truth, declared by each BEE for itself.

                    This resolves the symmetry problem: a curated source tree would just be the topic tree under another name. Code depends on nothing committed in the repo, docs orient without dictating, quickstart works without locking anyone in.

                    **4. Source-driven coordination replaces topic claims.** Today's `ClaimRegistry` allocates **topic-tree leaves** to BEEs. In v0.7 it allocates **(source, partition)** pairs.

                    - For sources with natural partitioning (Wikipedia: alphabetical ranges; arXiv: categories; Common Crawl: shard files), BEEs claim partitions to avoid duplicating work.
                    - For sources without natural partitioning (small RSS feeds, specialised domains), claims become trivial.
                    - Same per-BEE claims Hypercore, same TTL renewal logic, same release-on-expiry semantics. Only the unit changes.

                    **5. Open web as a first-class source via Common Crawl.** The forager must support "the open web" without Google or proprietary search:

                    - Publicly hosted, versioned snapshots (each snapshot has a stable ID).
                    - Open licence, no rate limits comparable to web scraping.
                    - Reproducible: two BEEs starting from the same snapshot ID reach the same URL set.
                    - Composable with the forager: a Common Crawl adapter implements `ForagerSource` with `seed()` returning URLs from the snapshot, `fetch()` retrieving page content, `normalize()` and `owns()` for routing.

                    **Explicitly not supported as sources:**
                    - Google / Bing / proprietary search APIs. Non-reproducible, non-deterministic, ToS-incompatible with systematic extraction, central dependency that contradicts the P2P model.
                    - Anything that requires authentication or scraping bypass. If two BEEs cannot independently reach the source, corroboration is meaningless.

                    **Rule of thumb for source legitimacy:** *"Can two BEEs in different jurisdictions, with no coordination, reach the same content independently?"* If yes, it is a valid source. If no, it is not.

                    **6. Forager guarantees (carried over from Wikipedia forager and formalised).** The generic forager enforces, for every source:

                    - **URL normalisation before dedup.** Strip fragments, normalise casing per source convention, resolve redirects to canonical form, drop tracking params.
                    - **Persistent `visited` set.** Survives restarts. Per-source namespace to avoid cross-contamination.
                    - **Loop detection.** A→B→A cycles must terminate via `visited`. Logging: count of "skipped, already visited" per cycle. Zero on a busy crawler = bug.
                    - **Queue cap.** Configurable per source. Overflow policy: drop oldest, drop random, or refuse new — operator choice.
                    - **Stagnation detection.** When `new_links_discovered / urls_processed` drops below a threshold, log it. Optional: pause that source's crawl cycle and let others advance.
                    - **Exhaustion → recovery ladder.** When the queue is empty *and* stagnation triggers persistently, the forager runs the dead-end recovery ladder (expand scope → rotate source → relax policy → announce). See "Dead-end recovery" under item #2 above. A specialist bee never sits idle silently — it either keeps producing or it tells the network it ran out.

                    Today's Wikipedia forager implements most of this implicitly. v0.7 makes it the contract every source obeys.

                    **7. Bee replication topology (opt-in).** In v0.6.x every bee replicates every other bee's Hypercore it can find — the v0.6.4 sync-everything default. That doesn't scale: a 100-bee network would have each bee carrying 100 cores, undoing the RAM savings of the bee/queen split. v0.7 makes peer replication **operator-controlled** via the `replication` manifest field (or `HIVE_BEE_REPLICATE` env var):

                    | Value | Behaviour | Use case |
                    |-------|-----------|----------|
                    | `none` | Bee only authors its own core. Never downloads peer cores. Lightest, most isolated. | Producer-only nodes on tiny hardware; raspberry-pi flotilla. |
                    | `neighbors` *(default)* | Bee replicates peers whose declared `scope` overlaps with its own (same Wikipedia category subtree, same arXiv super-category, etc.). | Specialist resilience: medicine bees back each other up; nobody hauls Michael Jackson articles. |
                    | `all` | v0.6.4 behaviour — replicate every peer found via the DHT. | Small networks (< ~20 bees); single-machine multi-bee dev setups. |

                    **What "neighbours" means.** A queen's `/api/directory` exposes the full source-scope graph it has observed. A bee with `replication: "neighbors"` reads this directory and replicates peers whose `scope` is within K hops in the source-specific scope tree (Wikipedia: K=2 category levels; arXiv: same primary super-category; Common Crawl: same language + ≥ 50% domain overlap). The exact K is per-adapter and tunable. **A bee with no declared scope has no neighbours** — it falls back to `replication: "none"` automatically.

                    **Why opt-in not always-on.** Replication factor ≥ 3 is a network-level goal, not a per-bee obligation. Five medicine bees with `neighbors` replication produce the same `RF ≥ 3` for medicine fragments that today's "everyone replicates everyone" produces globally, but at 1/20 the RAM cost. Queens always replicate the bees they index (that is their job), so durability does not depend on bee↔bee replication — bee↔bee is a *resilience bonus*, not a correctness requirement.

                    **8. Queen storage model — read replicas + Qdrant index.** A queen does two distinct things with each bee it follows:

                    1. **Downloads the bee's Hypercore as a read replica.** Hypercore replication semantics require a local on-disk copy of the data the queen reads. This is durable storage of signed, append-only fragments. The queen cannot mutate it. If the originating bee disappears, the queen still has the full signed history of what that bee published.
                    2. **Indexes new fragments into Qdrant** as they arrive on the replicated core. Qdrant is a *derived* index — a vector projection of the fragments. Qdrant is not the source of truth; it can be rebuilt from the replicated cores at any time by running the indexer over them.

                    Two corollaries:

                    - **Queens are durability nodes, not just query nodes.** A network of 1000 bees and 0 queens loses the convenience of semantic query but keeps cryptographic integrity (every bee has its own core). Add one queen and you regain query *plus* a read replica of every bee it follows. Lose all bees but keep a queen and you have a frozen-in-time read-only archive of every fragment that queen ever indexed — still signed, still verifiable, still queryable.
                    - **Disk-cost scaling differs from bee disk-cost.** A bee carries its own append-only core (small — its own writes). A queen carries N replicated cores (large — N bees worth of fragments). A queen with `HIVE_QUEEN_FOLLOW=medicine-bees-only` only replicates those, capping its disk-cost. This is the operator's lever, not network-imposed.

                    **What the queen does NOT store locally**: its own producer fragments (it has none — `HAS_LOCAL_STORE = false`). The capability flags from v0.7.0.1 enforce this at startup.

                    #### Migration path

                    1. ✅ **v0.7.0 — Role split (bee / queen / hive).** `HIVE_MODE` env, six capability flags, `queen.sh`, docker-compose rename.
                    2. ✅ **v0.7.1 — ForagerInterface introduced, Wikipedia migrated.** Wikipedia uses `ForagerSource` seam.
                    3. ✅ **v0.7.2 — Existing fetch tools refactored as adapters.** `arxiv_search`, `rss_fetch`, `web_fetch` → `ForagerSource`. `tools_registry.ts` deleted.
                    4. ✅ **v0.7.3 — BeeManifest published at startup.** `bee:manifest` key in Hyperbee. `GET /api/directory`. `topic_tree.json` deprecation warning. New env vars: `HIVE_SOURCES`, `HIVE_POLICY`, `HIVE_SCOPE`, `HIVE_BEE_REPLICATE`, `HIVE_LANGUAGES`.
                    5. ✅ **v0.7.4 — Common Crawl CDX + WARC adapter.** `common_crawl_source.ts` — CDX API + range-fetch WARC → HTML strip → chunk. Scope: `{domains, snapshot}`. Reproducibility guaranteed.
                    6. ✅ **v0.7.5 — Manifest→extractor wiring.** `autonomous_extractor.ts` reads `store.getLocalManifest()`. `declared_sources` drives which adapters run, with scope-aware seeding. Fallback: wikipedia-only (v0.6 behaviour). Heuristic RSS/arXiv only fires when no manifest is published.
                    7. ✅ **v0.7.6 — Scope partitions (opt-in).** `ForagerSource.partitions(scope)` enumerates valid sub-units of a scope; `DeclaredSource.partition` declares which one a bee claims; `ClaimRegistry` registers `<source_id>:<partition_key>` claims via the existing `topicId` field. Partitions live INSIDE the scope (never cut across it) so `policy=exclusive` stays coherent: a Medicine bee picks `Category:Pharmacology` not `A-G`. Generalist bees can still use alphabetical / TLD buckets when no scope is declared. `HIVE_PARTITION` env var. Bees without it run identically to v0.7.5.
                    8. **v0.7.7 — Dead-end recovery ladder.** Forager-level. `new_links_per_cycle → 0` triggers: expand scope → rotate source → relax policy → announce-exhausted. Configurable per bee via manifest `on_exhausted` field.
                    9. **v0.7.8 — Topic-tree code paths removed.** `loadTree()` deprecation warning removed; `topic_tree.json` becomes `examples/seed-topics.json`. Full cleanup of `topic_assignment.ts`.
                    10. **v0.7.9 — Score-by-corroboration.** `cos_sim × log(1 + corroboration_count)` where `corroboration_count` = distinct sources that independently produced fragments with the same content hash. Requires source diversity (v0.7.4+) to be meaningful.

                    #### Decisions explicitly made

                    - **No source tree in code.** Symmetry with topic-tree centralisation. Documentation and per-BEE manifest cover the legitimate needs.
                    - **Source *adapters* live in code; source *scopes* do not.** This is the curation line. The repo ships a finite set of `ForagerSource` implementations (Wikipedia, arXiv, RSS, Common Crawl) because each one requires real code to talk to a heterogeneous endpoint. That is engineering, not editorial centralisation — equivalent to a Mastodon client speaking ActivityPub. What each bee covers *within* those adapters (the `scope` field) is operator-declared and never approved by any central authority. A third party can add a new adapter without asking permission: implement the `ForagerSource` interface, ship as a plug-in or a fork. There is no `sources.json` that gates which adapters exist at runtime.
                    - **Google and proprietary search not supported as sources.** Non-reproducible, ToS-hostile, recentralising. Common Crawl is the open-web vehicle.
                    - **Topic-tree expansion to 5000+ nodes — abandoned.** The forager has made it unnecessary. The original roadmap TODO is removed.
                    - **Source diversity is a v0.7 dependency, not a v0.8 nice-to-have.** Score-by-corroboration only becomes meaningful with multiple sources.
                    - **Bee↔bee replication is opt-in, not always-on.** Default `neighbors`, configurable to `none` or `all`. Queens always replicate the bees they index — durability is a queen-side guarantee, not a per-bee obligation.
                    - **Queens are durability nodes, not just query nodes.** They keep full read-replicas of every bee they follow. Qdrant is a derived index, rebuildable from the cores.
                    - **Specialist bees auto-recover from forager exhaustion.** Default ladder: expand scope → rotate source → relax policy → announce. A bee that runs out of in-scope work never sits idle silently.

                    #### Open questions

                    - **Manifest mutability.** Does `declared_sources` evolve over time? Likely yes (BEE may add a new source). How does this interact with the append-only Hypercore? Probably as a new manifest entry that supersedes the previous, leaving history.
                    - **Source identity collisions.** Two BEEs declaring `id: "wikipedia-en"` should refer to the same source. Soft registry of canonical source IDs in `docs/suggested-sources.md` — non-authoritative, human-readable.
                    - **Partition granularity for claims.** Sensible default partition for Wikipedia EN? Alphabetical 26 buckets? Hash-based? Per-language only? Empirical experimentation before committing.
                    - **What happens to URLs discovered in source A that belong to source B?** (Example: a Wikipedia article links to an arXiv paper.) Probably: the generic forager routes the URL to the adapter whose `owns()` returns true. Requires multiple sources enabled in the same BEE. Open design point.
                    - **Common Crawl snapshot freshness vs reproducibility.** Snapshots are monthly-ish. A BEE pinned to a snapshot has reproducibility but loses freshness. Probably: declare the snapshot in the manifest, allow operators to choose.
                    - **Neighbour-distance constant K per adapter.** Wikipedia at K=2 categories, arXiv at "same super-category", Common Crawl at "language + 50% domain overlap" are starting guesses. Need empirical data once v0.7.3 ships manifests.
                    - **Recovery-ladder defaults.** Is `["expand", "rotate", "drift", "announce"]` the right out-of-the-box ladder? Some operators may want `["announce"]` only (research-grade). Probably ship the full ladder and document how to override.

                    #### What this refactor does NOT change

                    - Single-writer per BEE (each BEE owns its Hypercore).
                    - Per-BEE claims Hypercore (already correct, just changes the unit of claim).
                    - ed25519 signature on every fragment.
                    - HNSW/Qdrant as derived index, not source of truth.
                    - The bee/queen role split planned in v0.7.0 (orthogonal; both ship in the same v0.7 cycle).
                    - Multi-agent voting / Byzantine consensus — already abandoned in favour of score-by-corroboration.
                    - Autobase / multi-writer — already abandoned in v0.2.1, not revisited.

                    #### Strategic framing

                    - **v0.6:** "a P2P network of BEEs that extract content from configured fetch tools, organised by a shared topic taxonomy."
                    - **v0.7+:** "a P2P network of BEEs that extract from objectively-identifiable public sources they self-declare, organised by what each BEE chose to cover."

                    The v0.7 framing is closer to what HIVE has always wanted to be — Wikipedia for machines — and removes the last vestige of editorial centralisation the v0.6 architecture still carried.

                    ### v0.7.x — Scale & economics (orthogonal to the source-driven refactor)

                    | Item | Why |
                    |------|-----|
                    | **Drop HNSW from bees** | Once roles are split, bees no longer need an in-process vector index. Removes 200 MB of `sentence-transformers` weight from the bee Docker image and eliminates the upsert-on-rehydrate bug entirely. Queen keeps Qdrant. |
                    | BulkImporter — Wikipedia dump | Direct chunking of Wikipedia XML dumps into Hypercore. Becomes a `ForagerSource` adapter in the v0.7 model: source id `wikipedia-dump`, seed returns article IDs from the XML index, no LLM involved. |
                    | Semantic routing / VecDHT | All BEEs reply to all queries; should route to relevant nodes only. Requires v0.7.0 role split + source-driven model first. |
                    | QVAC integration | `LLM_PROVIDER=qvac` for on-device inference without Ollama overhead. |
                    | Token economics (WDK) | Extractors earn USD₮ per query served; consumers pay per query. Source declaration in manifest provides the natural unit for fee attribution. |
                    | Replication factor ≥ 3 | Fragments may exist on only 1 BEE — single point of failure. |

                    ### v0.8 — Open question: AI-synthesis tier on top of verbatim corpus

                    A real tension we noticed during the v0.7.0 README review:
                    the v0.6 architectural commitment is *no LLM in the
                    extraction path* — bees are mechanical mirrors of public
                    sources, signed verbatim. That keeps the ed25519
                    signature meaningful ("this is what the source said")
                    but it also means HIVE today is closer to "verifiable
                    Wikipedia mirror queried by AIs" than to the manifesto's
                    framing of "knowledge built by machines for machines".
                    The bee is a crawler with a signature; the only LLM in
                    the system is the queen's `/api/query` synthesis.

                    The argument *for* keeping it this way: HIVE's
                    intelligence is in the **network**, not in any single
                    LLM call. Multiple bees independently extracting the
                    same content from different sources, score-by-
                    corroboration weighting fragments by source diversity
                    (v0.7.5), and per-bee scope specialisation (v0.7.3) all
                    produce something no single LLM and no human-edited
                    Wikipedia can produce — cryptographic + statistical
                    confidence in a fact. That's the differentiator.

                    The argument *against* — and the v0.8 design space — is
                    that "by AIs for AIs" was always part of the framing.
                    The v0.6 line ruled out LLM-written *fragments*, but
                    didn't say anything about a **separate tier** of
                    LLM-generated content sitting on top of the verbatim
                    base. A coherent shape:

                    ```
                    Fragment.provenance ∈ {
                      "verbatim",       // direct from source. v0.6 contract.
                                        //   ed25519-signed; consumer can
                                        //   re-fetch the URL and verify the
                                        //   text matches.
                      "synthesis"       // generated by an LLM from N>=2
                                        //   verbatim fragments. Carries the
                                        //   parent fragment IDs as citations;
                                        //   consumer can re-verify by reading
                                        //   the parents. Marked clearly in
                                        //   the UI.
                    }
                    ```

                    The two tiers are queried independently. A consumer
                    asking for an audit-grade answer filters
                    `provenance: "verbatim"`; one asking for a richer
                    cross-source synthesis allows `"synthesis"` too. The
                    verbatim base never gets contaminated by LLM
                    paraphrasing; the synthesis tier never claims to be
                    primary source.

                    Open questions to resolve before committing:

                    - **Who produces synthesis fragments?** A queen-side
                      service? A new role `HIVE_MODE=synth`? Per-query
                      on-demand vs persistent in Hypercore?
                    - **Whose key signs them?** The synthesiser's own
                      ed25519. The signature is *not* a claim about the
                      source; it's a claim about the LLM process that
                      produced this synthesis from cited parents.
                    - **How does corroboration interact with synthesis?**
                      A synthesis fragment from 5 verbatim parents is
                      *not* "5x more trusted" — it inherits trust from
                      the parents but adds the LLM's interpretive risk.
                      The scoring needs care.
                    - **Hallucination guard.** Synthesis must cite parent
                      fragment IDs; a synthesis with no parents is
                      rejected. Some form of "every claim in the
                      synthesis must be backed by at least one parent"
                      check is needed but expensive.
                    - **Naming and UI surfacing.** "Synthesis" vs
                      "interpretation" vs "derived". The wire-format
                      field name matters — once it's in Hypercores,
                      changing it is a migration.

                    Sequencing: revisit after v0.7.5 ships (score-by-
                    corroboration), because the corroboration count is
                    what makes synthesis-from-N-parents meaningful in
                    the first place. Until then, the verbatim base is
                    the right thing to focus on.

                    ---

                    ## Critical architectural decision: LLM-free extraction (v0.6)

                    ### The problem
                    Currently the extraction agent uses an LLM to:
                    1. Decide **what** to fetch (correct — this requires intelligence)
                    2. **Write the text** of each fragment (wrong — small models hallucinate)

                    With qwen2.5:1.5b, the LLM paraphrases or invents content instead of extracting verbatim. The ed25519 signature only guarantees "node X said this" — it does NOT guarantee the fragment text matches the source URL. This violates the Manifesto's "no fabricated citations" guarantee.

                    ### The fix (v0.6)
                    Separate orchestration from extraction:

                    ```
                    Current (v0.5):
                      LLM → web_fetch(url) → sees 8000 chars → writes fragment text → index_fragment()
                        Problem: LLM invents / paraphrases the text

                        Target (v0.6):
                          LLM → wikipedia_fetch(title) → tool auto-indexes sections verbatim → returns "indexed N sections"
                            LLM only decides WHAT to fetch and WHEN to move to the next source
                              Fragment text = verbatim from source API, never LLM-generated
                              ```

                              `wikipedia_fetch`, `rss_fetch`, and `arxiv_search` tools will call `onFragment()` internally with verbatim content, bypassing the LLM for text generation entirely. The LLM receives only a summary ("indexed 12 sections of Astrophysics") and decides next steps.

                              Benefits: zero hallucination, 10x+ throughput (no LLM per fragment), source fidelity guaranteed.

                              The LLM remains responsible for: topic selection, source discovery, query synthesis in `/api/query`.

                              ---

                              ## Autobase decision

                              The original spec calls for Autobase (multi-writer linearisation). Removed in v0.2.1 — `Autobase is closing` concurrent write errors were unresolvable. The current model (each BEE owns its single-writer Hypercore, peers open it read-only) is architecturally cleaner for HIVE: each BEE is the sole authority on its own knowledge. Not planned for reinstatement.

                              ---

                              ## How data flows (v0.6.4+)

                              ```
                              BEE-A extracts a fragment
                                → buildFragment(): hash + ed25519 sign with BEE-A's key
                                  → store.save(): append to local Hypercore + local Hyperbee
                                    → indexInEmbedder(): POST /add to local HNSW (bee) with
                                       buildEmbedderPayload(frag) — carries hash + signature

                              BEE-A meets AGGREGATOR via Hyperswarm DHT
                                topic = sha256("hive-network-v0.1")
                                → swarm.on('connection', socket): store.replicate(socket)
                                  → Protomux channel hive/meta/v2 on noiseStream.userData
                                    → metaMessage.send({nodeId, publicKey, coreKey, claimsCoreKey})
                                      → peer-meta event fires on the other side
                                        → peerRegistry.register(nodeId, publicKey)
                                          → corestore.get({key: coreKey}).download() → replication started
                                            → watchRemoteCore: live history stream → verify ed25519
                                              → if OK: POST to aggregator embedder (Qdrant)
                                            → corestore.get({key: claimsCoreKey}).download() → claims sync

                              Before indexing any fragment locally:
                                → store.get(id) — check Hypercore for existing fragment
                                  → Fresh (within TTL): skip (saves LLM/network cost)
                                  → Stale (past TTL): supersede() — old marked, new appended
                                  → New: save() + embedder /add
                              ```

                              **Zero HTTP between two HIVE nodes.** External clients (dashboard,
                              `/api/query`) still hit HTTP endpoints, but no node ever calls
                              another node's HTTP API since v0.6.4.

                                                          **TTL by source:** wiki 7 days · rss 24h · arXiv 30 days · web 3 days

                                                          **HNSW is a derived index**, always reconstructable from Hypercore history.

                                                          ---

                                                          ## File structure

                                                          ```
                                                          hive/
                                                          ├── hive.sh              ← production launcher (zero-config, single BEE)
                                                          ├── aggregator.sh        ← aggregator node launcher (starts Qdrant via Docker)
                                                          ├── start.sh             ← dev launcher (multiple BEEs from bees/*.env)
                                                          ├── stop.sh              ← kills all processes by port
                                                          ├── docker-compose.yml   ← full VPS stack (Caddy + BEE + Aggregator + Qdrant + Ollama)
                                                          ├── bees/                ← dev configs: bee-1.env, bee-2.env, bee-3.env
                                                          ├── data/
                                                          │   ├── topic_tree.json  ← 95-topic knowledge taxonomy (committed)
                                                          │   └── bee-*/           ← runtime data (gitignored)
                                                          └── packages/
                                                              ├── core/src/
                                                                  │   ├── knowledge_store.ts   ← KnowledgeStore: save/get/supersede/watchFragments/watchRemoteCore
                                                                      │   ├── p2p_node.ts          ← Hyperswarm + Protomux URL exchange + store.replicate()
                                                                          │   ├── sync_manager.ts      ← HTTP sync fallback (8s interval)
                                                                              │   ├── claim_registry.ts    ← topic claim coordination via HTTP
                                                                                  │   ├── topic_assignment.ts  ← assigns topic tree leaves to BEEs
                                                                                      │   └── node_identity.ts     ← ed25519 identity per BEE
                                                                                          ├── agent/src/
                                                                                              │   ├── autonomous_extractor.ts ← LLM orchestration agent + dedup/TTL/supersede logic
                                                                                                  │   ├── tools_registry.ts       ← wikipedia_fetch, arxiv_search, rss_fetch, web_fetch, index_fragment
                                                                                                      │   ├── budget_controller.ts    ← token/fragment/time limits per cycle
                                                                                                          │   └── text_chunker.ts         ← overlapping chunk splitting utility
                                                                                                              ├── embeddings/
                                                                                                                  │   ├── api_server.py        ← FastAPI :7700, HNSW + Qdrant backends
                                                                                                                      │   └── qdrant_index.py      ← Qdrant client (aggregator backend)
                                                                                                                          ├── api/src/
                                                                                                                              │   ├── api_server.ts        ← Fastify :8080, all endpoints + extraction loop
                                                                                                                                  │   └── llm_client.ts        ← LLM synthesis for /api/query
                                                                                                                                      └── ui/
                                                                                                                                              └── index.html           ← vanilla JS UI, light theme
                                                                                                                                              ```

                                                                                                                                              ---

                                                                                                                                              ## How to run

                                                                                                                                              ```bash
                                                                                                                                              # Docker — full stack (recommended for VPS):
                                                                                                                                              docker compose up -d
                                                                                                                                              # Model pulls automatically on first start via ollama-init container

                                                                                                                                              # Production (single BEE, from source):
                                                                                                                                              bash hive.sh

                                                                                                                                              # Dev (3 BEEs, from source):
                                                                                                                                              bash start.sh
                                                                                                                                              bash start.sh --clean        # wipe data and restart
                                                                                                                                              bash stop.sh --force         # kill all processes

                                                                                                                                              # Aggregator (from source, starts Qdrant via Docker automatically):
                                                                                                                                              bash aggregator.sh
                                                                                                                                              ```

                                                                                                                                              ---

                                                                                                                                              ## Key environment variables

                                                                                                                                              | Variable | Default | Description |
                                                                                                                                              |----------|---------|-------------|
                                                                                                                                              | `LLM_PROVIDER` | `gemini` (since v0.6.4.2) | `gemini` · `claude` · `openai` · `groq` · `ollama` |
                                                                                                                                              | `LLM_API_KEY` | — | Required for cloud providers. Not needed for `ollama`. |
                                                                                                                                              | `LLM_MODEL` | `gemini-2.5-flash-lite` (since v0.6.4.2) | Optional override per provider |
                                                                                                                                              | `OLLAMA_URL` | `http://localhost:11434` | Ollama server. In Docker Compose: `http://ollama:11434` |
                                                                                                                                              | `OLLAMA_MODEL` | `qwen2.5:1.5b` | Model to pull on first start (Docker only, profile `ollama`) |
                                                                                                                                              | `HIVE_PORT` | 8080 | API server port |
                                                                                                                                              | `HIVE_EMBEDDER_PORT` | 7700 | Python embeddings server port |
                                                                                                                                              | `HIVE_DATA_DIR` | `~/.hive` (prod) | BEE data directory. Also where `.runtime.env` lives (UI-set overrides). |
                                                                                                                                              | ~~`HIVE_PEER`~~ | — | **DEPRECATED v0.6.4** — Hyperswarm discovery is automatic |
                                                                                                                                              | ~~`HIVE_API_URL`~~ | — | **DEPRECATED v0.6.4** — no HTTP between nodes anymore |
                                                                                                                                              | ~~`HIVE_HTTP_SYNC`~~ | — | **REMOVED v0.6.4** — `SyncManager` deleted |
                                                                                                                                              | `BEE_TOPIC_DOMAIN` | — | Domain hint (e.g. `current_events`, `health`) |
                                                                                                                                              | `HIVE_EXTRACT_MAX_FRAGMENTS` | 9 (Docker) / 10 (shell) | Max fragments per extraction cycle |
                                                                                                                                              | `HIVE_EXTRACT_INTERVAL_MS` | 60000 (Docker) / 1800000 (shell) | Pause between cycles (ms) |
                                                                                                                                              | `HIVE_EXTRACT_BUDGET_MINUTES` | 20 (Docker) / 8 (shell) | Total LLM time budget per cycle, split across topics |

                                                                                                                                              **LLM architecture note:** ONE `LLM_PROVIDER` for both extraction orchestration and query synthesis. The embeddings model (all-MiniLM-L6-v2, ~80MB) always runs locally via Python — never a cloud LLM.

                                                                                                                                              **Throughput guidance with Ollama:**
                                                                                                                                              - `qwen2.5:1.5b` on CPU: ~5-10 tokens/sec → ~630 fragments/day (1 BEE, 3 topics)
                                                                                                                                              - `qwen2.5:3b` on CPU: slower, needs 4GB+ free RAM
                                                                                                                                              - Groq free tier: ~500 tokens/sec → ~6,400 fragments/day
                                                                                                                                              - Fragment quality warning: small models (1.5b) paraphrase instead of extracting verbatim. Use Groq/Gemini for production quality. v0.6 will fix this architecturally.

                                                                                                                                              ---

                                                                                                                                              ## Dev BEE ports

                                                                                                                                              | BEE | API | Embedder | Notes |
                                                                                                                                              |-----|-----|----------|-------|
                                                                                                                                              | bee-1 | 8080 | 7700 | Seed — no peer |
                                                                                                                                              | bee-2 | 8081 | 7701 | Peers with bee-1 |
                                                                                                                                              | bee-3 | 8082 | 7702 | Peers with bee-1, `BEE_TOPIC_DOMAIN=current_events` |
                                                                                                                                              | aggregator | 8090 | 7790 | Read-only, Qdrant backend |

                                                                                                                                              ---

                                                                                                                                              ## Key design decisions

                                                                                                                                              - **Hypercore as source of truth**: append-only, ed25519-signed. Data lives here regardless of derived-index state.
                                                                                                                                              - **Single-writer per BEE**: each BEE owns its Hypercore. Peers open it read-only. No Autobase. Aligns with Holepunch's own apps (Keet, Hyperdrive).
                                                                                                                                              - **HNSW/Qdrant as derived index**: always rebuildable from Hypercore. HNSW for BEEs (in-process, ~80 MB), Qdrant for aggregator (persistent, multi-process, ~400 MB).
                                                                                                                                              - **100% P2P between HIVE nodes since v0.6.4**: discovery via Hyperswarm DHT, metadata exchange via Protomux `hive/meta/v2`, fragment + claim sync via Hypercore replication on the same socket. No HTTP request is made between two HIVE nodes for sync/discovery/coordination. **Note on `/api/crawl` (v0.6.4.5)**: the aggregator/queen proxies a bee's forager state to external dashboards (e.g. capybarahome `/hive`). That is *dashboard plumbing*, not node-to-node sync — the dashboard is a consumer of HIVE's public surface, not a HIVE node. Controlled by `HIVE_DASHBOARD_BEE_URL`. All actual replication still travels Hyperswarm + Hypercore exclusively.
                                                                                                                                              - **Native Hypercore replication**: core key arrives in the meta exchange, not over HTTP. v0.6.4 removed the HTTP bootstrap that earlier versions had.
                                                                                                                                              - **No agent framework**: own TypeScript extractor — cleaner and more auditable than LangChain for this use case.
                                                                                                                                              - **LLM-free verbatim extraction (v0.6)**: fetch tools write fragment text byte-for-byte from the source API. The LLM only orchestrates which sources to crawl, never the text. ed25519 signature backs verbatim content, fulfilling the Manifesto's "no fabricated citations" promise.
                                                                                                                                              - **Filosofical alignment with Holepunch (relevant for the v0.7 role split)**: Hypercore is single-writer by design; consumers fan out. The planned `HIVE_MODE=bee` (producer only) + `HIVE_MODE=aggregator` (consumer) topology is the same shape as Keet's "each user a Hypercore, indexer-nodes federate". Splitting roles is *more* Holepunch-native than the current monolithic bee.

                                                                                                                                              ---

                                                                                                                                              ## Known issues

                                                                                                                                              | Issue | Impact | Status |
                                                                                                                                              |-------|--------|--------|
                                                                                                                                              | `await b.put()` missing in KnowledgeStore | Hypercore always empty — P2P replication impossible | **Fixed v0.4** |
                                                                                                                                              | Listeners registered after p2pNode.start() | Aggregator missed early peer events | **Fixed v0.4** |
                                                                                                                                              | Native Hypercore replication | test_replication.ts all phases pass | **Fixed v0.4** |
                                                                                                                                              | Qdrant `search()` API v1.12+ | Replaced with query_points() | **Fixed v0.4** |
                                                                                                                                              | ollama-init TTY error | `ollama pull` CLI requires TTY — switched to HTTP API | **Fixed v0.5** |
                                                                                                                                              | web_fetch 2000-char truncation | Only article intro indexed — missed 95% of content | **Fixed v0.5** (wikipedia_fetch) |
                                                                                                                                              | RSS 300-char teaser | Useless teasers indexed instead of article content | **Fixed v0.5** (content:encoded) |
                                                                                                                                              | arXiv 500-char abstract | Abstract cut mid-sentence | **Fixed v0.5** (2000 chars) |
                                                                                                                                              | LLM writes fragment text | Small models hallucinate/paraphrase — violates "no fabricated citations" | **✅ Fixed v0.6** (LLM-free extraction) |
                                                                                                                                              | Signature verification on receive | Malicious node could inject unsigned data | **✅ Fixed v0.6.2.1** — full ed25519 verify via PeerRegistry |
                                                                                                                                              | Replication factor ≥ 3 | Fragments may exist on < 3 BEEs | **TODO v0.7+** |
                                                                                                                                              | IConsensus — fragment quality voting | No multi-agent validation | **Replaced by score-by-corroboration (v0.7)** — non-bizantine, softer trust signal |
                                                                                                                                              | ~~Peer HTTP URL in Docker (127.0.0.1)~~ | ~~Aggregator advertises loopback — HTTP sync fallback fails cross-container~~ | **Fixed v0.5.1** — `HIVE_API_URL` env var. (Obsolete since v0.6.4: no HTTP between nodes at all.) |
                                                                                                                                              | Bee local HNSW shows lower `indexed` than its Hypercore length after container recreate | `usearch` library throws `Duplicate keys not allowed in high-level wrappers` when the bee re-hydrates its embedder from Hypercore and the same logical id has multiple versions (supersede history) | **TODO v0.6.4.5** — switch `VectorIndex.add` to upsert semantics. Hypercore is fine, replication is fine, aggregator queries unaffected (Qdrant has upsert). |
                                                                                                                                              | Free-tier Groq for bee extraction | bee + aggregator share the API key → share the TPM bucket. Aggregator's queries leave the bee with ~1-2k usable TPM/min, can't complete extraction cycles | **✅ Fixed v0.6** — LLM-free extraction means the bee no longer hits the LLM per fragment. Bees can now use the same key without choking each other. |
                                                                                                                                              | Aggregator `(unhealthy)` in `docker ps` | Dockerfile HEALTHCHECK curls `127.0.0.1:8080` which isn't bound in the aggregator container | Cosmetic — aggregator works correctly. Will tidy when touching the Dockerfile next. |
                                                                                                                                              | UI `/api/config` provider override lost on container recreate | Was writing to `/hive/.env` inside the container (ephemeral) | **✅ Fixed v0.6.4.3** — persists to `${HIVE_DATA_DIR}/.runtime.env` (mounted volume), loaded at boot |
                                                                                                                                              | Aggregator silently fell back to HNSW when Qdrant slow to start | `depends_on: service_started` doesn't wait for the port to accept connections; aggregator.sh got connection-refused and used in-process HNSW while 34k vectors sat untouched in qdrant-data | **✅ Fixed v0.6.4.4** — Qdrant healthcheck on `/readyz`, aggregator waits `service_healthy`, aggregator.sh hard-fails when `QDRANT_URL` was set explicitly |
                                                                                                                                              | bee + bee-2 + aggregator + ollama on a 4 GB VPS = OOM | Stack required ~4.5 GB residence | **✅ Mitigated v0.6.4.2** — Ollama moved behind opt-in profile (~2 GB freed). 2 bees + aggregator + Gemini fits in 4 GB. For 2 bees with Ollama: 8 GB recommended. |
                                                                                                                                              | Hypercore DHT in Codespaces | Cross-machine needs open UDP | Expected. No HTTP fallback since v0.6.4. If UDP blocked, the bee runs isolated until UDP becomes available. |
                                                                                                                                              | Semantic routing / VecDHT | All BEEs reply to all queries | **TODO v0.7+** (requires role split first) |
                                                                                                                                              | Token economics | No incentive layer | **TODO v0.7+** |
                                                                                                                                              | Bee Docker image carries 200 MB of `sentence-transformers` it doesn't strictly need for the producer role | Architecture entanglement — bee = producer + consumer in one process today | **TODO v0.7.0** — role separation drops HNSW + embedder from bee image |

                                                                                                                                              ---

                                                                                                                                              ## Running tests

                                                                                                                                              ```bash
                                                                                                                                              # Native Hypercore replication — should show ALL PHASES PASSED
                                                                                                                                              packages/core/node_modules/.bin/tsx packages/core/src/test_replication.ts

                                                                                                                                              # SESSION_CLOSED fix + write queue
                                                                                                                                              packages/core/node_modules/.bin/tsx packages/core/src/test_v03.ts
                                                                                                                                              ```

                                                                                                                                              ---

                                                                                                                                              ## GitHub

                                                                                                                                              ```
                                                                                                                                              Repo   : https://github.com/capybarist/hive (private)
                                                                                                                                              Branch : main
                                                                                                                                              Push   : requires GITHUB_TOKEN workaround
                                                                                                                                                       TOKEN=$(GITHUB_TOKEN="" gh auth token)
                                                                                                                                                                git remote set-url origin "https://capybarist:${TOKEN}@github.com/capybarist/hive.git"
                                                                                                                                                                         git push origin main
                                                                                                                                                                         ```

                                                                                                                                                                         ---

                                                                                                                                                                         ## Developer context

                                                                                                                                                                         - Background: Java/enterprise (Financial Services)
                                                                                                                                                                         - Learning distributed systems and AI
                                                                                                                                                                         - Project is both portfolio and real product
                                                                                                                                                                         - Communicates in Spanish
                                                                                                                                                                         - All code comments and logs must be in English
                                                                                                                                                                         - `Bash(*)` is pre-approved in `.claude/settings.json`
                                                                                                                                                                         