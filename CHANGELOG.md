# Changelog

All notable changes to HIVE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
