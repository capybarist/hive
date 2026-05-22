# HIVE — Claude Code Context

## What this project is

HIVE (Heuristic Intelligent Vector Extraction) is a decentralized P2P knowledge base for LLMs. Each node is a **BEE**. BEEs autonomously extract knowledge from the internet, sign each fragment with ed25519, store it in Hypercore (append-only, cryptographically verifiable), and sync with other BEEs via native Hypercore replication. LLMs query HIVE via RAG to get up-to-date, source-traceable knowledge.

**Analogy:** What Wikipedia is for humans, but optimised to be consumed by LLMs.

---

## Current state: v0.6.4.4 — 100% P2P, runtime-persistent config

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
                        { "id": "wikipedia-en", "config": { "language": "en" } },
                        { "id": "arxiv", "config": { "categories": ["cs.LG", "cs.AI"] } }
                      ],
                      "declared_languages": ["en", "es"],
                      "version": "0.7.0"
                    }
                    ```

                    Declaration is self-sovereign: no central registry approves anything. Queens read manifests from the BEEs they replicate and build a directory of "which BEEs cover which sources". Reputation per source emerges from observation — does this BEE actually publish what it declares? Discrepancy is a signal, not enforced.

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

                    Today's Wikipedia forager implements most of this implicitly. v0.7 makes it the contract every source obeys.

                    #### Migration path

                    1. **v0.7.0 — Role split (bee / queen / hive).** As documented in the v0.7.0 section above. Unblocks the rest by giving cleaner module boundaries.
                    2. **v0.7.1 — ForagerInterface introduced, Wikipedia migrated.** No behaviour change for operators. The Wikipedia forager becomes the reference implementation.
                    3. **v0.7.2 — Existing fetch tools refactored as adapters.** `arxiv_search`, `rss_fetch`, `web_fetch` rewritten over `ForagerSource`. Behaviour preserved.
                    4. **v0.7.3 — Manifest format and `declared_sources`.** BEE manifests published at Hypercore start. Queen reads them and exposes `/api/directory`. `topic_tree.json` deprecated; warning on boot if still referenced.
                    5. **v0.7.4 — Common Crawl adapter.** First non-curated open-web source. End-to-end demo of "two BEEs, same snapshot, corroborated fragments".
                    6. **v0.7.5 — Score-by-corroboration over sources.** `cos_sim × log(1 + corroboration_count)` where `corroboration_count` is the number of *distinct sources* (not BEEs) where the same content hash was independently extracted. Cross-BEE corroboration within the same source remains useful but lower weight.
                    7. **v0.7.6 — Topic-tree code paths removed.** Final cleanup. `topic_tree.json` becomes `examples/seed-topics.json` if kept at all.

                    #### Decisions explicitly made

                    - **No source tree in code.** Symmetry with topic-tree centralisation. Documentation and per-BEE manifest cover the legitimate needs.
                    - **Google and proprietary search not supported as sources.** Non-reproducible, ToS-hostile, recentralising. Common Crawl is the open-web vehicle.
                    - **Topic-tree expansion to 5000+ nodes — abandoned.** The forager has made it unnecessary. The original roadmap TODO is removed.
                    - **Source diversity is a v0.7 dependency, not a v0.8 nice-to-have.** Score-by-corroboration only becomes meaningful with multiple sources.

                    #### Open questions

                    - **Manifest mutability.** Does `declared_sources` evolve over time? Likely yes (BEE may add a new source). How does this interact with the append-only Hypercore? Probably as a new manifest entry that supersedes the previous, leaving history.
                    - **Source identity collisions.** Two BEEs declaring `id: "wikipedia-en"` should refer to the same source. Soft registry of canonical source IDs in `docs/suggested-sources.md` — non-authoritative, human-readable.
                    - **Partition granularity for claims.** Sensible default partition for Wikipedia EN? Alphabetical 26 buckets? Hash-based? Per-language only? Empirical experimentation before committing.
                    - **What happens to URLs discovered in source A that belong to source B?** (Example: a Wikipedia article links to an arXiv paper.) Probably: the generic forager routes the URL to the adapter whose `owns()` returns true. Requires multiple sources enabled in the same BEE. Open design point.
                    - **Common Crawl snapshot freshness vs reproducibility.** Snapshots are monthly-ish. A BEE pinned to a snapshot has reproducibility but loses freshness. Probably: declare the snapshot in the manifest, allow operators to choose.

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
                                                                                                                                              - **100% P2P between nodes since v0.6.4**: discovery via Hyperswarm DHT, metadata exchange via Protomux `hive/meta/v2`, fragment + claim sync via Hypercore replication on the same socket. No HTTP request is made between two HIVE nodes for any reason. The Fastify HTTP server is only for external clients (dashboard, /api/query).
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
                                                                                                                                                                         