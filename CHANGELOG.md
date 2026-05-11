# Changelog

All notable changes to HIVE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
- **v0.1 Status table**: Renamed to v0.2 Status; documented current module versions and v0.3 roadmap.

### Known Issues Updated
- Hyperswarm DHT blockage now documented as Codespaces-specific (production VMs with open UDP work correctly).
- Added: replication factor enforcement deferred to v0.3.

---

## [0.2.1] — 2026-05-07

### Added
- **Conversational chat**: conversation history sent to Gemini on each query.
  Follow-up questions ("tell me more", "what about X?") now work correctly.
- **"New chat" button**: clears history and starts a fresh conversation.
- **Source chips**: only relevant fragments shown as source chips (not all top-k).
- **Docker support**: `Dockerfile` and `.dockerignore` for containerised deployment.
- **npx support**: `npx hive-network` installs and runs a BEE automatically.
- **Topic tree (95 topics)**: autonomous BEEs assign themselves uncovered topics
  from a 9-domain knowledge taxonomy without manual configuration.
- **Claim registry**: P2P coordination of topic coverage. BEEs scan peers before
  claiming topics to avoid overlap.
- **`/api/state`**: debug endpoint showing full BEE state (claims, objective, peers).
- **`/api/claims`**: exposes active topic claims for cross-BEE coordination.
- **`bash start.sh --clean`**: explicit flag to wipe BEE data (default: preserve).
- **Cycle cap**: max 5 topics per extraction cycle (prevents 30min stuck cycles).
- **Extraction `try/finally`**: spinner always resets, never stuck on "Extracting".

### Changed
- **Relevance threshold**: top-1 score ≥ 0.35 OR keyword-in-title match triggers
  "In HIVE" mode. Filters noise from small homogeneous HNSW indexes.
- **Stop-word filtering**: Spanish/English stop words excluded from keyword match
  (queries like "que sabe de GEMA" → meaningful=["gema"]).
- **`/api/fragments`**: reads from HNSW instead of Hypercore — fragments always
  available for sync regardless of Hypercore write failures.
- **Sync always updates HNSW first**: `addToHNSW()` runs before `saveReplicated()`.
  Hypercore write failure no longer blocks knowledge propagation.
- **System prompt**: removed "be concise", added "thorough detailed answers"
  and "maintain conversational continuity".
- **BEE naming**: generic `bee-1`, `bee-2`, `bee-3` (was descriptive names).
- **Data directories**: `data/bee-N/` unified structure (was `data/` + `data_b/`).

### Fixed
- `SESSION_CLOSED` crash when Hyperswarm peers disconnect → removed
  `store.replicate(socket)` from P2P node (HTTP sync used instead).
- Duplicate fragment indexing: same article from RSS + direct URL indexed once
  (session-scoped title deduplication in tools_registry).
- `extracted_at` missing from HNSW metadata causing sync crashes.
- Race condition on startup: BEEs now wait for peers to register topic claims
  before starting their own discovery (prevents duplicate topic coverage).
- `Autobase is closing` concurrent write error → **removed Autobase entirely**,
  replaced with direct `Hypercore + Hyperbee` (single-writer, stable).

### Known Issues
- **Hypercore writes**: SESSION_CLOSED errors persist for some writes. Fragments
  are always indexed to HNSW (search works). Hypercore signature persistence
  is unreliable. Fix planned for v0.3.
- **NAT traversal**: HTTP sync requires publicly accessible port. Nodes behind
  NAT (home routers) need a tunnel (ngrok, Cloudflare) or VPS. Native Hypercore
  replication with UDP hole-punching is the correct fix (v0.3).
- **No migration scripts**: breaking data format changes require `--clean`.

---

## [0.2.0] — 2026-05-05

### Added
- **Autonomous extractor (Module 7)**: Gemini function calling agent that
  decides what to search, which sources to use, and what to index — no
  manual topic lists.
- **`rss_fetch` tool**: RSS/Atom feed parsing for news and blog sources.
- **Budget controller**: per-cycle limits on tokens, API calls, fragments, time.
- **`BUSL-1.1` license and MANIFESTO.md**: public project launch preparation.

### Changed
- **Autobase → Hypercore direct** (v0.2.0): removed Autobase multi-writer layer.
  Each BEE uses its own single-writer Hypercore + Hyperbee. More stable.

---

## [0.1.0] — 2026-04-30

### Added
- **Module 1**: local embeddings with `all-MiniLM-L6-v2` (~80MB, CPU) + HNSW index.
- **Module 2**: reactive extractor — arXiv API + CrossRef DOI validation + chunking.
- **Module 3**: `KnowledgeStore` on Hypercore + Hyperbee + Autobase.
- **Module 4**: P2P network — Hyperswarm peer discovery + HTTP sync between BEEs.
- **Module 5**: Fastify vector query API with `/api/query`, `/api/fragments`, `/api/status`.
- **Module 6**: Web UI with Gemini synthesis, fragment provenance badges, BEE activity feed.
- **ed25519 identity**: per-BEE cryptographic identity, signed fragments.
- **Append-only supersedes**: knowledge corrections modeled as linked events.
- **Multi-BEE dev setup**: `bees/*.env` + `start.sh` for local multi-node testing.

---

## Upgrade notes

### 0.1.x → 0.2.x
Data format changed (Autobase removed). Run `bash start.sh --clean` to wipe
and re-extract. BEE identities are preserved across `--clean`.

### Future: 0.2.x → 0.3.x
Will restore native Hypercore replication (NAT traversal). Migration guide TBD.
