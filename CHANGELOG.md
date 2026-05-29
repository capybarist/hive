# Changelog

All notable changes to HIVE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## v0.8.11 — Caddy + sslip.io for HTTPS on queen + bees without a domain

Lets a HIVE operator serve queen and bees over valid HTTPS even when they
do not control a DNS zone. Caddy switches from the inline
`caddy reverse-proxy` CLI to a proper Caddyfile (mounted from the repo
root). The Caddyfile declares three subdomains under sslip.io — a free
wildcard DNS service that resolves `<ip-with-dashes>.sslip.io` to the
matching IPv4 — and Caddy auto-fetches a Let's Encrypt cert for each via
HTTP-01.

Public access points (when `CADDY_HOST_IP` is set in `.env` to the dashed
IPv4 of the host):

  https://queen.${CADDY_HOST_IP}.sslip.io  → queen:8090
  https://bee1.${CADDY_HOST_IP}.sslip.io   → bee-1:8080
  https://bee2.${CADDY_HOST_IP}.sslip.io   → bee-2:8081

Bare-IP HTTP requests get a 308 to the canonical HTTPS queen URL so old
bookmarks and tooling keep working. Leaving `CADDY_HOST_IP` unset keeps
the previous HTTP-only behavior (subdomain blocks just fail to match;
the redirect still serves a 308 to a missing host, so set the var when
you flip Caddy on).

The Caddyfile is generic: swap `{$CADDY_HOST_IP}.sslip.io` for a real
domain you control and you get the same auto-TLS without sslip.io as
an intermediary.

---

## v0.8.10 — Fix UI source-chip links pointing at the queen URL

Reported 2026-05-29. Search-result source chips in the queen UI rendered
their `href` from `f.source` (the source-type label like `wikipedia-en` or
`rss`) instead of `f.url` (the verbatim source URL). `safeUrl()` rejects
anything that doesn't start with `http(s)://` and returns `#`, which makes
the browser navigate to the page's own origin — so users clicking the
citation chip landed back on the queen instead of the original Wikipedia /
arXiv / RSS page.

One-line fix: `const url = f.url ?? '#';` (was `f.source`). Hover tooltip
also now shows the verbatim source URL.

Confirmed the Hypercore fragment already carries `url` correctly — this
was a pure rendering bug, no schema or data-layer issue.

---

## v0.8.9 — Fix `bin/hive-bee` regression

The `npx hive-bee` convenience launcher had been broken since the v0.8
all-Node migration: its first step was `pip install -r packages/embeddings/requirements.txt`,
but that directory (the Python embedder) was deleted in v0.8. Anyone who
followed the README's "run a bee with `npx hive-bee`" path got a hard pip
error before Node even started. Rewritten for v0.8: install Node deps if
missing, then `exec bash hive.sh`. No pip, no Python.

This is the **local-repo** launcher (clone + `npx hive-bee` from the
checkout). The `npm install -g @capybaralabs/hive` path is the larger
follow-up tracked in ROADMAP.md §1 — work starting now.

---

## v0.8.8 — Public demo token (`/api/public-bootstrap`)

v0.8.7 turned auth on but left every visitor to the public Hetzner demo
seeing a `prompt()` for a token. That makes sense for private deployments
but breaks the "open a tab and try HIVE" demo flow.

This adds an opt-in escape hatch for that case: the operator publishes a
demo token in a new `HIVE_PUBLIC_DEMO_TOKEN` env var, the queen exposes it
via an always-public `GET /api/public-bootstrap`, and the UI fetches it at
page load before any authenticated call. If the env is unset, the bootstrap
returns `demoToken: null` and the UI falls back to the manual prompt — so
private queens behave exactly as before.

The bootstrap endpoint is **whitelisted in the auth hook**, so it works
even when `HIVE_API_KEY` is set. The demo token it returns is, by design,
fetchable by anyone — bots included. It is a soft gate, not a hard security
boundary; the operator rotates `HIVE_API_KEY` (and the demo token with it)
to kick everyone off when abuse appears. The "no payment method on groq"
fact this design relies on keeps the worst case bounded.

**Changes**
- `api_server.ts`: read `HIVE_PUBLIC_DEMO_TOKEN`; auth hook whitelists
  `/api/public-bootstrap`; new route returns `{version, demoToken}`.
- `index.html`: `ensureBootstrap()` runs once on first `apiFetch()` and
  pre-loads the token into `localStorage` before the request goes out.
- `docker-compose.yml`: passes `HIVE_PUBLIC_DEMO_TOKEN` to the queen
  service alongside `HIVE_API_KEY`.

---

## v0.8.7 — Optional bearer-token auth on `/api/*`

Lets an operator gate the queen's HTTP API behind a shared secret without
giving up the open-access mode that's been the default since v0.7. Off by
default; set the `HIVE_API_KEY` env var to enable.

The trigger is the public Hetzner demo queen: anyone with the URL can hit
`/api/query`, which spends LLM tokens on the operator's account. With a token
set, only requests that send `Authorization: Bearer <HIVE_API_KEY>` go through;
everything else returns `401`. Static UI assets (`/`, JS, CSS) remain public —
the in-browser UI is just another client and authenticates the same way as a
programmatic caller. Decision recorded 2026-05-29: no UI bypass, no special-case
routes.

**Behavior**
- Unset → API fully open (existing dev/local-stack behavior is preserved).
- Set → every `/api/*` route requires the bearer token. UI files (HTML/JS/CSS)
  still serve unauthenticated.
- A Fastify `onRequest` hook checks the header before route handlers run.
  CORS preflight (`OPTIONS`) is allowed through so browsers can still complete
  the actual request.

**UI changes** (`packages/ui/index.html`)
- New `apiFetch()` wrapper injects `Authorization: Bearer <token>` on every
  call; replaces the 8 bare `fetch()` calls to `/api/*`.
- Token sources, in priority order: `?hive_token=...` URL query string
  (one-click demo link — auto-saved and stripped from the URL),
  `localStorage`, then `window.prompt()` on the first `401`. The prompt fires
  once, the entered value is persisted, and the request retries.

**Ops**
- `docker-compose.yml` passes `HIVE_API_KEY` through to the queen service.
- The Dockerfile healthcheck sends the header when the env var is set
  (`${HIVE_API_KEY:+-H "Authorization: Bearer $HIVE_API_KEY"}`) so the
  container's own health probe survives auth being turned on.
- Multi-tenant tokens (`HIVE_API_KEYS=k1:alice,k2:bob,...`) and audit logging
  are planned for v0.9.x — single-token is enough for the immediate "stop
  randoms burning my LLM credits" use case.

---

## v0.8.6 — Periodic LanceDB optimize (compact + cleanup old versions)

Root-cause fix for the 2026-05-29 disk-fill incident on the Hetzner production
box. Each `upsertBatch` leaves a permanent MVCC manifest version in LanceDB;
nothing was pruning them. In <16 h post-v0.8 deploy the queen accumulated
33 940 manifest versions in `fragments.lance/_versions/`, filling the 75 GB
disk to 100 % and triggering cascading `No space left on device` write
failures (Caddy → 502, `docker exec` itself failed). After manual
`table.optimize({ cleanupOlderThan: now })` the store dropped from **45 GB →
540 MB** with **124 201 fragments preserved**.

Without compaction, every HIVE queen will exhibit the same failure mode —
this is on the critical path for self-hosted operators (a 50 GB VPS must be
able to run a queen for years, not days).

**Changes**
- `VectorIndex.optimize(keepMs)` interface method; `LanceVectorIndex`
  implements it via `table.optimize({ cleanupOlderThan })`. The keep-window
  ensures an in-flight reader can't pull a version out from under itself.
- Queen runs the optimize loop every 30 min with a 1 h trailing window.
  Configurable: `HIVE_OPTIMIZE_INTERVAL_MS` (default 1 800 000),
  `HIVE_OPTIMIZE_KEEP_MS` (default 3 600 000). Set interval to 0 to disable.
- Search behavior unchanged. Optimize is concurrent-safe with reads
  (MVCC); upserts may briefly serialize against the writer lock.

---

## v0.8.0 — Unified migration: all-Node, producer-side vectorization

One coordinated breaking change (single hard reset). Full plan and cutover
runbook: [`docs/V0.8-MIGRATION.md`](docs/V0.8-MIGRATION.md).

**Architecture**
- **Producer-side vectorization.** Bees now embed each chunk themselves and
  sign the vector *inline* in the Hypercore fragment. The queen no longer
  embeds passages — it copies the bee's pre-computed, signed vectors straight
  into its index. A queen's per-fragment cost is now an upsert, not a
  transformer forward pass, so it scales to many bees.
- **All-Node stack.** The Python `sentence-transformers` embedder and the
  Qdrant container are gone. Every node embeds in-process with
  `intfloat/multilingual-e5-base` (ONNX int8) via `@huggingface/transformers`;
  the queen stores vectors in an embedded **LanceDB** (in-process, no service).
- **New embedding model:** `all-MiniLM-L6-v2` (384-d, English-centric) →
  `multilingual-e5-base` (768-d). Fixes the cross-lingual gap (ES query vs EN
  corpus) and improves retrieval precision.
- **Fragment schema v2.** Source-agnostic, signed over text + metadata +
  vector. `doi`/`arxiv_id` collapse into a generic `identifiers` map; the
  vector is base64(Float16Array) inline; `content_hash` (whitespace-normalised,
  no lowercase) enables corroboration across bees.
- **Deterministic layout chunking** (`chunker_version`) so two bees produce
  identical chunks → identical `content_hash` → corroboration.

**Retrieval**
- Recalibrated gate: `RELEVANT_SCORE` 0.45 (MiniLM) → **0.82** (e5 cosines
  compress to ~0.70–0.91). Same logic (score AND majority-keyword,
  word-boundary, punctuation-stripped) + the LLM grounded-verdict backstop.

**Ops**
- `docker-compose.yml`: dropped `qdrant`; queen volume renamed
  `aggregator-data` → `queen-data` (one-time `docker volume` recipe in the
  migration doc). `hive.sh`/`queen.sh`/`start.sh` are single Node processes
  now (no embedder bring-up). Dockerfile is `node:22-slim` (Float16Array needs
  Node 22+) and pre-caches the ONNX model at build.
- Requires **fresh cores** at cutover — the Hypercore fragment format changed.
  Old v0.7 text-only data is re-crawled (young network, data re-crawlable).

---

## [0.7.7.12] — 2026-05-27 — *Graceful shutdown: stop forking the Hypercore on container stop*

Root-cause fix for the 2026-05-27 fork incident. The bee's fragments
core forked (two signed roots for length 3,966,110), which permanently
broke the queen's replication and froze `indexed`. Investigation
traced it to abrupt container kills: the ~15 rapid redeploys today each
recreated the bee container, and the bee's node process was
**SIGKILLed mid-Hypercore-append** without flushing — on the next start
the corestore rolled back and re-appended different content → fork.

Why an abrupt kill happened at all: the container's PID 1 was
`exec tail -f` (the log streamer in hive.sh/queen.sh), so Docker's
SIGTERM went to `tail`, not to node. Node never got a chance to close
its corestore; it was force-killed after the grace period.

### Fix (three parts)

1. **`api_server.ts`** — a `SIGTERM`/`SIGINT` handler that closes the
   stores cleanly (`app.close` → `p2pNode.stop` → `claimRegistry.close`
   → `knowledgeStore.close`, flushing the corestore), with a 25 s
   force-exit guard.
2. **`hive.sh` / `queen.sh`** — node is now started with `exec` in a
   subshell so `$!` is its real PID; the launcher traps SIGTERM/SIGINT
   and forwards it to node, then waits for node to exit before stopping
   (replaces `exec tail`, which hid node from signals).
3. **`docker-compose.yml`** — `stop_grace_period: 40s` on bee-1, bee-2,
   queen so the clean shutdown has time to finish before SIGKILL.

### Recovery applied to production

The already-forked state was repaired by purging the QUEEN's replica of
the bee core (corestore + repl_cursors; identity + Qdrant preserved) and
letting it re-download the bee's current, consistent history. The bee
was untouched (its core is internally fine; only the queen's cached copy
had diverged). Queries kept working throughout (Qdrant is separate).

### Files touched
- `packages/api/src/api_server.ts`, `hive.sh`, `queen.sh`,
  `docker-compose.yml`, `package.json` (0.7.7.11 → 0.7.7.12).

---

## [0.7.7.11] — 2026-05-27 — *Revert the freshness fast-forward — it silently dropped recent fragments*

Testing exposed that "The Go! Team", which the bee had recently
extracted, was NOT in the queen's Qdrant and not findable. Root cause:
the v0.7.7.5–.9 "freshness fast-forward" jumped the replication cursor
from ~1.49 M to ~3.95 M, **skipping 2.47 M blocks** — and that gap
contained recently-extracted fragments the queen had not yet indexed.
The assumption "the skipped range is already in Qdrant" was false for
the bee's recent additions, so they were lost.

Freshness (surface new fragments fast) and completeness (never drop a
fragment HIVE has) both matter; the fast-forward traded the second for
the first. For a knowledge base that's the wrong trade.

### What changed

- Removed the fast-forward entirely (the jump, the `update()` head
  probe, the `FRESHNESS_*` constants, the `embedderCount` helper that
  v0.7.7.9 already dropped). The watcher is back to natural sequential
  replay from the persisted cursor.
- v0.7.6.5's embedder-side fast-skip already makes replaying
  already-indexed fragments cheap, so the natural replay reaches the
  live tail in a reasonable one-time catch-up and **loses nothing**.
  In steady state (no restart) the queen tracks the tail live — new
  bee fragments index within seconds.

### Follow-up

The ideal (immediate freshness AND completeness) needs a background
backfill of the gap running concurrently with a live-tail watcher —
deferred to v0.7.8. Until then, freshness is bounded by the one-time
post-restart catch-up, which is acceptable because restarts are now
rare (the OOM loop is fixed).

Operationally, the production cursor (left near the head by the old
fast-forward) is reset so the queen re-scans the skipped gap and
indexes the fragments that were dropped.

### Files touched
- `packages/core/src/knowledge_store.ts` — remove fast-forward.
- `package.json` — 0.7.7.10 → 0.7.7.11.

---

## [0.7.7.10] — 2026-05-27 — *Fix: punctuation in the query broke the keyword gate (false "not in HIVE")*

After freshness was fixed, a fresh test exposed a retrieval bug:
**"Stupa"** found HIVE data, but **"What is a stupa?"** returned
"not verified" — even though the embedder scored stupa fragments at
0.52–0.61 (e.g. "Relic Stupa of Vaishali").

Cause: `meaningful` query tokens were produced by splitting on
whitespace only, so the last token kept its punctuation —
`"stupa?"`. `meetsKeywordGate` escapes each token into a
word-boundary regex, so it searched for the literal `stupa?` (with
the question mark), which a fragment containing plain `stupa` never
matches. The fragment cleared the score threshold but failed the
keyword gate → `has_hive_data=false`.

Since virtually every natural-language question ends in `?` or
contains commas, this silently sabotaged most real queries — the
exact "doesn't return HIVE info even when it has it" symptom.

Fix: normalise each token to letters/numbers
(`replace(/[^\p{L}\p{N}]/gu, '')`) before the length/stop-word
filter, so `"stupa?" → "stupa"`. One line.

### Files touched
- `packages/api/src/query_engine.ts` — strip punctuation from query
  tokens.
- `package.json` — 0.7.7.9 → 0.7.7.10.

---

## [0.7.7.9] — 2026-05-27 — *Fix: base the fast-forward on the cursor, not the embedder (which is GIL-bound during replay)*

Third and final timing fix. v0.7.7.8 polled the embedder's `/stats` to
decide if the queen was "populated enough" to fast-forward. But during
replay the embedder is GIL-bound serving `/add_batch`, so `/stats`
times out for minutes — a deadlock: the replay we want to skip is
exactly what prevents us from deciding to skip it. (Logs: `len=3966110`
read fine, but no fast-forward and no "No fast-forward" line either —
the decision was stuck polling.)

Fix: the "is this queen populated?" signal is now the **persisted
cursor**, which is local and instant. `current > 100 000` means the
queen has already processed (and indexed) a large span of the bee's
history, so its Qdrant mirrors the bee and skipping the backlog is
safe. No embedder call in the decision path at all.

- Established queen (cursor past the floor) → fast-forward to
  `head − 20 000`, tracks the live tail.
- Fresh queen (cursor ≈ 0) → full backfill, as required to fill an
  empty Qdrant.
- Operational note (now in the README too): if you wipe Qdrant, also
  delete `repl_cursors/` so the cursor resets and the backfill re-runs.

Removed the now-unused `embedderCount` helper.

### Files touched
- `packages/core/src/knowledge_store.ts` — cursor-based populated check;
  drop `embedderCount`.
- `package.json` — 0.7.7.8 → 0.7.7.9.

---

## [0.7.7.8] — 2026-05-27 — *Fix: fast-forward skipped because the embedder wasn't ready yet at restart*

v0.7.7.7 fixed the head read, but the fast-forward STILL didn't fire in
production. The logs showed everything right — `len=3966110`, cursor
≈1.44M, indexed 514k — yet no jump.

Cause: `embedderCount()` calls the embedder's `/stats`, but the embedder
is still loading its sentence-transformers model for ~30-60 s after a
restart. During that window `/stats` is unreachable and the old
`embedderCount` returned `0`, indistinguishable from a genuinely empty
index — so `indexed > 100 000` was false and the fast-forward was
skipped (then `didFastForward` latched, never retried).

Fix:
- `embedderCount` now returns **-1** on failure (unreachable / loading),
  reserving `0` for a real empty index.
- The fast-forward polls `embedderCount` up to 18 × 5 s, waiting out the
  model-load window, and only decides once the embedder actually answers
  (≥ 0). A populated queen then sees its true count and jumps; a fresh
  queen sees 0 and does the full backfill (correct).
- Added a "No fast-forward … doing full backfill" log for the negative
  case so this is never a silent mystery again.

### Files touched
- `packages/core/src/knowledge_store.ts` — `embedderCount` -1 sentinel +
  poll loop in the fast-forward.
- `package.json` — 0.7.7.7 → 0.7.7.8.

---

## [0.7.7.7] — 2026-05-27 — *Fix: freshness fast-forward read the head too early and never fired*

v0.7.7.5 shipped the freshness fast-forward but in production it never
triggered — the queen kept grinding through history (cursor ~1.4M,
`indexed` crawling up only as it stumbled on scattered new fragments).

Cause: the fast-forward probed `remoteCore.length` immediately after
`get({key})` + `ready()`, *before* Hypercore replication had announced
the peer's length. At that moment `length` is the locally-known value
(≈0), so `head - cursor` was negative and the condition was always
false.

Fix: the decision moved into `runStreamOnce`, after
`remoteCore.update({ wait: true })` (timeout-guarded) pulls the synced
remote head. Guarded by a `didFastForward` flag so it fires exactly
once per watcher. Now `head` is the real ~4 M length, the gap check
passes, and a populated queen jumps to `head - 20 000` as intended.

### Files touched
- `packages/core/src/knowledge_store.ts` — move fast-forward into
  `runStreamOnce` after `core.update()`; one-time guard.
- `package.json` — 0.7.7.6 → 0.7.7.7.

---

## [0.7.7.6] — 2026-05-27 — *Wider context for richer answers + conversational follow-ups*

User: answers are too terse ("escueto") and there's no way to ask a
follow-up after each one.

### More detailed answers

The synthesis prompt always pushed for depth, but `buildPrompt` only
fed the model **4 fragments × 400 chars** (~1.6 k chars) and capped
output at **1024 tokens** — it was starved of material. Now:

- `buildPrompt`: **8 fragments × 900 chars** (~7 k chars of verbatim
  context). Enough to actually write the depth the system prompt asks
  for, still well within Groq/Gemini per-query TPM.
- `maxTokens` 1024 → **1800**.
- `/api/query` default `top_k` 5 → **8**, so retrieval surfaces enough
  candidates to fill the wider context.

### Conversational follow-ups (website)

`/api/query` already accepted a `history` array; the capybarahome
Try-HIVE widget now uses it. It keeps a thread of turns and sends the
last few exchanges as history, so the user can ask follow-ups that
build on the previous answer instead of one-shot queries. (Website
change — this entry notes the API contract it leans on, unchanged.)

### Files touched
- `packages/api/src/llm_client.ts` — wider `buildPrompt`, maxTokens.
- `packages/api/src/api_server.ts` — default `top_k` 5 → 8.
- `package.json` — 0.7.7.5 → 0.7.7.6.

---

## [0.7.7.5] — 2026-05-27 — *Freshness fast-forward: a populated queen jumps to the tail instead of replaying history*

User observed the queen "stuck" at 504,694 fragments / 1 peer: the
replication cursor was grinding through historical Hypercore entries
(seq ~1.0M of ~4.0M) that Qdrant **already has**, so a visitor
searching for what the bee *just* extracted came up empty — the bee's
newest fragments sit at the tail (seq ~4M+) and the queen wouldn't
reach them for hours.

### Why this happens

A bee's Hypercore is ~8× its fragment count: each fragment writes
`frag:` + `src:` + `dat:` index keys plus supersede history. bee-1 has
~160 k articles → ~504 k fragments → ~4 M Hypercore blocks. Qdrant
already holds those 504 k fragments. Strict sequential replay from the
persisted cursor means re-reading ~3 M already-indexed blocks before
the first genuinely new fragment — at which point "live" is hours
stale.

### Fix

`watchRemoteCore` now does a one-time **freshness fast-forward** when
opening a remote core:

- Probe the remote head length.
- If `head - cursor > 200 000` (a real backlog) AND the embedder is
  already populated (`/stats` fragments > 100 000), jump the cursor to
  `head - 20 000` and persist it.
- Otherwise (fresh/empty queen, or small gap) do the normal full
  backfill.

The skipped range is assumed already in Qdrant; the 20 k re-scan window
before the head covers recent overlap and Qdrant dedup handles the
rest. After the jump the queen tracks the live tail, so a fragment the
bee writes now is queryable within seconds. The jump is one-time:
the persisted cursor lands near the head, so restarts don't re-trigger
it.

New helper `embedderCount(embedderUrl)` (GET `/stats`) gates the
decision; on any failure it returns 0 → treated as empty → safe full
backfill.

### Trade-off / known limitation

Fast-forward permanently skips the historical gap rather than
backfilling it. For a queen whose Qdrant already mirrors the bee
(the production case) this is lossless. A queen with real holes in
its index would not refill them this way — a proper low-priority
background backfill is a v0.7.8 candidate. Freshness was the
explicit priority here.

### Files touched
- `packages/core/src/knowledge_store.ts` — fast-forward logic in
  `watchRemoteCore` + `embedderCount` helper.
- `package.json` — 0.7.7.4 → 0.7.7.5.

---

## [0.7.7.4] — 2026-05-27 — *The LLM's verdict, not the retrieval gate, decides the "Verified by HIVE" badge*

User hit the worst-case false positive: a query for **"Guido Fanti"**
showed **"✓ Verified by HIVE"** over an answer that literally said
*"There is no information available about Guido Fanti in the provided
knowledge fragments"* — sourced to articles about the city Fano and
the city Ravenna.

### Why the gate alone can't fix this

The v0.7.7.x retrieval gate (score ≥ 0.45 + majority keyword match)
decides which fragments to SEND the LLM. But it's a fuzzy pre-filter:
"Guido Fanti" (a person) pulls "Fano" (a city) at 0.53 and a token
match sneaks through. No threshold tuning makes a bag-of-words gate
reliably tell "the person Guido Fanti" from "the city Fano". The only
component that actually *reads* the fragments and knows they don't
answer is the LLM — which already said so in plain language. The bug
was that the badge trusted the gate, not the LLM.

### Fix: the LLM is the final judge

`llm_client.ts` now instructs the model: when the provided fragments
don't actually contain the answer, begin the reply with a
`[[NO_MATCH]]` sentinel, then answer from general knowledge under the
"⚠ Not verified by HIVE" caveat. `synthesize` returns a new
`grounded: boolean`:

- fragments genuinely used → `grounded: true`, `mode: 'verified'`.
- sentinel emitted, or no fragments to begin with → `grounded: false`,
  `mode: 'hybrid'`.

`api_server` sets the response's `has_hive_data = gatePassed &&
grounded` and **drops the source chips when not grounded**. So the
"Verified by HIVE" badge and the source list now appear only when the
LLM confirms it actually answered from HIVE data. No extra LLM call —
same single synthesis, just a verdict token parsed out of it.

This is also the "dead-end recovery" half of the v0.7.7 plan: a query
that retrieves near-misses now degrades honestly to a general-knowledge
answer instead of dressing the near-misses up as verified sources.

### Effect

- "Guido Fanti" → LLM emits `[[NO_MATCH]]` → badge off, no chips,
  honest "not verified" answer.
- "photosynthesis" → LLM grounds in the real fragments → "Verified by
  HIVE" with sources, unchanged.

### Files touched
- `packages/api/src/llm_client.ts` — sentinel instruction in the
  system prompt, `grounded` in `LLMResponse`, verdict parsing.
- `packages/api/src/api_server.ts` — badge + chips follow `grounded`.
- `package.json` — 0.7.7.3 → 0.7.7.4.

---

## [0.7.7.3] — 2026-05-27 — *Sanitize ALL payload fields, not just text — the surrogate was in the title*

v0.7.7.2 stripped surrogates from the fragment `text` but the cursor
stayed frozen at seq 324,608 and the same error kept firing:

```
PydanticSerializationError: …UnicodeEncodeError: 'utf-8' codec can't
encode character '\ud804' in position 91: surrogates not allowed
```

The poison `\ud804` wasn't in `text` — it was in another payload
field (the fragment **title**). The Qdrant client serializes the
WHOLE payload dict to JSON, so a surrogate in *any* string value
(title, source, …) fails the upsert just the same.

### Fix

`sanitize_meta(meta)` strips surrogates from every string value in
the metadata dict (one level deep — the queen's payloads are flat).
Applied wherever we build the Qdrant payload: `add`, the `add_batch`
batch path, and the per-item fallback. `text` is still cleaned
separately as before.

### Note on SESSION_CLOSED

The replication stream also logs intermittent `SESSION_CLOSED` on the
bee-1 core and restarts (~every 24 entries) from the persisted
cursor. That caps throughput but does not block; it's the separate
bee-1 ↔ queen Hyperswarm session churn on the backlog. With the
poison fragment now serialisable, the cursor advances past 324,608
and `indexed` resumes growing.

### Files touched
- `packages/embeddings/embedder.py` — `sanitize_meta` + calls.
- `package.json` — 0.7.7.2 → 0.7.7.3.

---

## [0.7.7.2] — 2026-05-26 — *Strip lone surrogates before Qdrant — unfreeze the replication cursor*

User noticed the queen's `indexed` count was stuck at 504,678 for
hours even though the embedder looked healthy and bee-1 was extracting
102 fragments/cycle. The replication cursor was frozen at
**seq 324,584** — not advancing at all.

### Root cause: a poison-pill fragment

A fragment in bee-1's Hypercore contains a lone UTF-16 surrogate
(`\ud804`) in its text — same class of bee-side extraction bug as
the Gothic surrogates found in v0.7.6.7, but this one fails at a
DIFFERENT layer:

```
PydanticSerializationError: Error serializing to JSON:
UnicodeEncodeError: 'utf-8' codec can't encode character '\ud804'
in position 91: surrogates not allowed
```

v0.7.6.7's per-item fallback guarded the *embedding* step, but this
fragment embeds fine — it fails when the **Qdrant client serializes
the payload to JSON**. That fails the entire `upsert_batch`, returns
HTTP 500, the queen's `doFlush` reinstates the buffer, and the
cursor never advances past the poison fragment. The queen retried
the same doomed batch forever — catch-up frozen, `indexed` flat,
new fragments never reached.

### Fix

New `strip_surrogates(s)` in `embedder.py` removes any code point in
U+D800–U+DFFF. Applied to fragment text in both `add` and
`add_batch` BEFORE embedding and before building the Qdrant payload,
so the sanitised text is what gets stored. Lossless for every
legitimate character (a properly-decoded UTF-8 codepoint is never a
surrogate in a Python `str`).

This is the v0.7.6.8 backlog item, promoted to urgent because it
turned out to be a hard pipeline blocker, not just the per-item
slowdown we thought.

### Also seen (not fixed here)

The replication stream logs intermittent `SESSION_CLOSED` on the
bee-1 core and restarts from the persisted cursor — believed to be a
symptom of the long stall (corestore session timing out while the
poison batch retried), should resolve once the cursor advances. If
it persists after this deploy, it's the separate bee-1 ↔ queen
Hyperswarm topology issue already on the backlog.

### Files touched
- `packages/embeddings/embedder.py` — `strip_surrogates` + calls.
- `package.json` — 0.7.7.1 → 0.7.7.2.

---

## [0.7.7.1] — 2026-05-26 — *Keyword gate: require MAJORITY of query tokens, not just one*

v0.7.7 fixed the obvious false positive ("cocido madrileño" → 5
unrelated fragments) but the user immediately found another: query
"Latest advances in retrieval augmented generation" returned **"✓ In
HIVE · 1 source"** with the fragment being "Expert — Expertise →
Related research" — an article about expertise/memory retrieval,
not RAG.

Root cause: v0.7.7's keyword check was `words.some(...)` — ANY single
meaningful token appearing in the fragment was enough. For the RAG
query the meaningful tokens are `[latest, advances, retrieval,
augmented, generation]` (5 after stop-word filter), and the Expert
fragment matched on **just "retrieval"** (mention of memory
retrieval), score 0.458 (just over the 0.45 threshold).

### Fix

`meetsKeywordGate(haystack, words)` now requires **`ceil(N/2)`
distinct query tokens** to appear in the fragment. For our case:

- "Latest advances in retrieval augmented generation" — 5
  meaningful tokens → need ≥3. Expert fragment hits 1 → filtered.
- "cocido madrileño" — 2 tokens → need ≥1 (unchanged from v0.7.7;
  the single-keyword threshold already filtered all of them).
- "photosynthesis" — 1 token → need ≥1 (unchanged).
- "Toronto subway lines" — 3 tokens → need ≥2. A genuine Toronto
  Line 1 article hits all 3 → still relevant.

For very short queries the gate behaves identically to v0.7.7; the
new tightening only kicks in for 3+ token queries where the noise
floor risk is highest.

### Files touched

- `packages/api/src/query_engine.ts` — replaced `keywordHit()`
  (`some`) with `countTokenHits` + `meetsKeywordGate` (majority).
- `package.json` — 0.7.7 → 0.7.7.1.

---

## [0.7.7] — 2026-05-26 — *Retrieval gating: stop showing "In HIVE" for bogus matches*

User reported the canonical false-positive case: a query for
**"cocido madrileño"** returned the badge **"✓ In HIVE · 5 sources"**
with five completely unrelated fragments (List of regional anthems,
Raquel Torres Cerdán cookbook, Treaty of Defensive Alliance
Bolivia–Peru, Province of Verbano-Cusio-Ossola, Veneto tourism). The
LLM correctly recognised nothing in the fragments answered the
question and fell back to its general knowledge, but the UI still
showed those five source chips below the answer, implying citations
that did not exist.

### Root cause

`query_engine.ts` had two issues that compounded:

1. **`RELEVANT_SCORE = 0.30`** — the v0.6 comment claimed
   `all-MiniLM-L6-v2` noise tops out at 0.20-0.25. That's correct for
   diverse English queries against an English HNSW. For Spanish
   queries against the current ~500 k mixed-language Qdrant, noise
   regularly reaches **0.46-0.48** on entirely unrelated content.
2. **`f.score >= 0.30 || meaningful.some(w => haystack.includes(w))`** —
   relevance was an OR: either the score was loosely high OR *any*
   meaningful query word appeared in *any* fragment text. Either
   path alone is noisy; combining them with OR made false positives
   easy.

Direct check on prod with the user's query confirmed all five
top-5 fragments scored 0.46-0.48; none contained "cocido" or
"madrileño" in title or text.

### Fix

`query_engine.ts:queryByText`:

- `RELEVANT_SCORE` raised **0.30 → 0.45**.
- The OR is now an **AND**: `score >= 0.45 AND keywordHit`. Both
  must pass.
- `keywordHit` uses a word-boundary regex (`\b{token}`) instead of
  `String.prototype.includes`, so "madrid" doesn't match "madridista"
  and "neural" doesn't match "neuralgic".
- Empty `meaningful` token list (rare; query was all stop-words)
  falls back to score-only.
- When `has_hive_data` is false, the API now returns **zero
  fragments** instead of `markedFragments.slice(0, 3)`. The old
  behaviour leaked three loosely-related fragments into the response
  body and the UI rendered them as source chips even though the LLM
  prompt path was already correct ("answer from general knowledge,
  no fragments provided"). Now the UI gets a clean empty list and
  the visual matches the verbal — no chips, "Not verified by HIVE"
  caveat in the answer.

### Effect on the reported case

- `cocido madrileño` →
  scores 0.480, 0.477, 0.466, 0.466, 0.460; none contain "cocido"
  or "madrileño" as words → all marked non-relevant → `has_hive_data
  = false` → API returns `fragments: []` → LLM answers from general
  knowledge with the "⚠ Not verified by HIVE" caveat → UI shows no
  source chips.

### Effect on legitimate queries

- `photosynthesis` → high score AND keyword "photosynthesis" in
  multiple titles → unchanged, still surfaces correctly.
- `Toronto subway lines` → multi-token query, at least one of
  {toronto, subway, lines} present in genuine matches → still
  surfaces.

### Known limitation

Cross-lingual queries against a single-language corpus now fail
strict: asking "fotosíntesis" in Spanish against an English HNSW
will not find the English "Photosynthesis" article even though
the embedding similarity is there. This is intentional for v0.7.7
— false positives were the worse failure mode — but a future
release should add a translation pre-pass or a language-aware
keyword check.

### Files touched

- `packages/api/src/query_engine.ts` — gating logic.
- `package.json` — 0.7.6.7 → 0.7.7.

### What did NOT change

- LLM prompt or `llm_client.ts` (already builds a clean prompt
  when `has_hive_data=false`).
- `/api/query` response schema.
- UI rendering code — the UI already conditionally renders chips
  on `fragments.length`; with the empty list it draws nothing.

---

## [0.7.6.7] — 2026-05-26 — *Per-item fallback in embedder.add_batch when batch encode raises*

v0.7.6.6's filter still didn't catch every input the tokenizer can
choke on — log showed ~8 `TypeError: TextEncodeInput must be Union…`
500s per few hundred batches even after the type/empty filter.
Without knowing which specific text triggers it, we can't write a
precise filter — so wrap the batch encode in try/except and fall
back to per-item embed on failure. One bad item gets logged
(`repr(text)[:120]`) and dropped; the other 19 in the batch get
through. Catch-up keeps moving instead of failing the whole batch
back to the queen.

### Files touched
- `packages/embeddings/embedder.py` — try/except around
  `embed_batch`, per-item fallback path.
- `package.json` — 0.7.6.6 → 0.7.6.7.

---

## [0.7.6.6] — 2026-05-26 — *Defensive filter in embedder.add_batch: skip malformed items instead of 500-ing the whole batch*

v0.7.6.5 sped up catch-up dramatically (~25× — cursor advanced from
40k to 181k in 6 minutes after deploy) but the embedder log lit up
with `TextEncodeInput must be Union[TextInputSequence, …]`
TypeErrors from the tokenizer. Some items reaching `add_batch` had
non-string or empty `text` fields and the sentence-transformers
`model.encode` raises on the FIRST bad item, failing the entire
batch with HTTP 500.

The queen has a defensive guard in `_consumeRemoteStream` since
v0.7.5.2 but it can be defeated by a fragment with weird text
content the JS-side type check accepts (e.g. a non-empty string
that's all whitespace, or a string that becomes empty after some
internal sentence-transformers normalisation).

### Fix

`embedder.py:add_batch` filter now also drops items whose
`id`/`text` are missing, non-string, or whitespace-only — same
list as the v0.7.6.5 known-id filter, just stricter. A bad item
loses, the rest of the batch survives.

```python
fresh = [
    it for it in items
    if isinstance(it.get("id"), str) and it["id"]
    and it["id"] not in known
    and isinstance(it.get("text"), str) and it["text"].strip()
]
```

### Files touched
- `packages/embeddings/embedder.py` — tighter filter.
- `package.json` — 0.7.6.5 → 0.7.6.6.

---

## [0.7.6.5] — 2026-05-26 — *Filter known IDs in the embedder BEFORE running sentence-transformers (catch-up fast-skip)*

v0.7.6.4 stopped the watcher-loop accumulation and gave us cursor
persistence, but the embedder was **still OOM-killed** ~2 h after the
deploy. Root cause: `add_batch` in `embedder.py` was running
`sentence-transformers.encode` on every text in the batch *before*
checking which IDs were already in Qdrant. Dedup happened inside
`upsert_batch` AFTER embedding, so the wasted vectors were discarded
silently.

During queen catch-up of a remote bee's Hypercore, **~99 % of items
in every batch are already in Qdrant** (we just resumed from a
cursor, but qdrant still has every historical fragment). The
embedder was running the transformer model on millions of texts
whose vectors would be immediately thrown away — at 20 items per
batch, 384-dim vectors, and CPU-only inference, this ate ~2 GB of
working set and burned the box's 3.7 GB OOM budget.

### Fix

`embedder.py:add_batch` now snapshots the index's known-id set
(`_known_ids` for Qdrant, `_id_to_label` keys for HNSW) and **filters
items BEFORE `embed_batch`**:

```python
known = getattr(self.index, "_known_ids", None) or \
        getattr(self.index, "_id_to_label", {})
fresh = [it for it in items if it["id"] not in known]
if not fresh:
    return 0
texts = [it["text"] for it in fresh]
vectors = self.embed_batch(texts)
```

Effects:

- During catch-up, a 20-item batch where all are known returns
  in microseconds (set lookup × 20) instead of running the
  transformer.
- Embedder RAM stays close to baseline (~500 MB model + qdrant
  client) instead of climbing toward the OOM line.
- Queen catch-up rate jumps from ~930 seq/min to limited only by
  Hypercore block I/O. The ~70 h ETA collapses to minutes.

### Why this matters at scale

With hundreds of bees and millions of articles, **every queen
restart was facing a catch-up storm**: each remote core, each peer
reconnect, every restart re-ran the transformer on already-known
content. The new behaviour means a queen only ever embeds what's
genuinely new to its Qdrant — restart cost scales with **net new
fragments since last shutdown**, not with the total network history.

### What did NOT change

- API surface (`/add_batch` returns the same shape).
- HNSW fallback path (was already doing the right thing in the
  per-item loop; now also skipped earlier).
- Queen-side code unchanged from v0.7.6.4.

### Files touched

- `packages/embeddings/embedder.py` — one filter pass before
  `embed_batch`.
- `package.json` — version 0.7.6.4 → 0.7.6.5.

---

## [0.7.6.4] — 2026-05-26 — *Cursor persistence + watcher dedup: stop the recurring embedder OOM loop*

Post-demo root-cause fix for the recurring queen instability: the
embedder was being **OOM-killed at the kernel level every 30–60 min**
(`dmesg` confirmed three kills today at 10:34, 10:52, 11:44, each at
~2.8 GB RSS on a 3.7 GB box). After each kill the queen reported
`embedder_online: false`, `indexed: 0`, and queries returned empty —
fixed temporarily by `docker compose restart queen`, but the loop
restarted as soon as catch-up replay began.

### Root causes

Two interacting bugs in `knowledge_store.ts` `watchRemoteCore`:

1. **No deduplication by `nodeId`.** Hyperswarm peers churn-reconnect
   every few seconds (NAT holepunch instability). Every reconnect
   emits a fresh `peer-meta` event → `api_server.ts` calls
   `watchRemoteCore` again → each call enters its own `while(true)`
   loop and opens a fresh `Hyperbee.createHistoryStream` from offset
   0. After a few hours of peer churn, the queen had **dozens of
   concurrent streams** each fanning into `/add_batch`, racing for
   the GIL until the embedder's working set crossed the OOM line.

2. **No cursor persistence.** Even with one stream per peer, every
   queen restart re-streamed the remote bee's 600 k+ Hypercore from
   offset 0. Combined with bug #1, after a restart the queen had to
   re-process several million entries before catching up to live.

3. **Latent `seen` Set never populated** — separate bug found while
   fixing the above: `trackSeen` was referenced from
   `_consumeRemoteStream` but defined in `watchRemoteCore`'s scope,
   raising a silent `ReferenceError` swallowed by the `doFlush` catch
   block. The Set therefore stayed empty across the entire run, so
   the in-process dedup short-circuit `if (seen.has(frag.id)) continue`
   was a no-op — every Hyperbee entry was re-POSTed on every cycle.
   Qdrant's `_known_ids` covered the duplicates server-side but at
   the cost of every batch round-tripping the embedder.

### Fix

`KnowledgeStore`:

- **`activeWatchers: Set<string>`** keyed by `nodeId`. The first
  `watchRemoteCore(nodeId)` call enters the loop; concurrent calls
  with the same `nodeId` log `[repl] already active … skipping
  duplicate` and return. `try/finally` clears the entry on the (in
  practice unreachable) loop exit so the next reconnect can restart.
- **Cursor persistence** at `${DATA_DIR}/repl_cursors/<nodeId>.json`.
  Each entry is `{ "lastSeq": <n> }`, written atomically via
  `writeFile` + `rename`. `loadCursor` populates `cursorByNode` on
  first watcher open; `saveCursor` updates after every successful
  `/add_batch` 2xx, taking `batch[batch.length - 1].seq` (the
  history stream emits in ascending order, so the last item is the
  max). Regressions are rejected internally.
- **`createHistoryStream({ gt: lastSeq, live: true })`** — the
  stream skips everything already processed. Restart cost drops
  from ~600 k entries to ~0; only new fragments since last
  shutdown are streamed.
- **`trackSeen` is now passed in as a parameter** to
  `_consumeRemoteStream`, replacing the broken cross-scope
  reference. The in-process Set now actually deduplicates, and the
  bounded 10 k cap (v0.7.6.1) is finally effective.

### Operational effect

After a queen restart with this version deployed (and the cursor
files seeded by one normal run beforehand):

- The catch-up replay storm is **gone**. Restarts resume from the
  latest persisted `seq` per peer.
- `/add_batch` traffic drops to live-extraction rate (~10–20
  frags/min), not catch-up rate (thousands/min).
- Embedder working set stays under ~700 MB, well below the OOM
  threshold.
- `/search` and `/health` respond promptly — the 20 s / 45 s
  timeouts from v0.7.6.3 are still in place as belt-and-suspenders
  but should rarely fire.

### First-run note

On first start after upgrading, the queen still does one full
replay (cursor files are empty). Subsequent restarts are cheap.
The replay this one time takes the same ~25–30 min it always did;
this is unavoidable unless we also seed the cursor file from
qdrant's `_known_ids` (out of scope for this version).

### Files touched

- `packages/core/src/knowledge_store.ts` — new helpers
  `cursorFile`, `loadCursor`, `saveCursor`; `watchRemoteCore` gets
  dedup gate and resume log; `_consumeRemoteStream` gains `nodeId`
  and `trackSeen` params, batch items carry `seq`, `doFlush`
  persists cursor on 2xx.
- `package.json` — version 0.7.6.3 → 0.7.6.4.

### What did NOT change

- API surface (no new endpoints, no schema changes, no env vars).
- BeeManifest format.
- Hypercore / Hyperbee on-disk layout.
- UI, README install steps, capybarahome `/hive` page — operators
  see the same commands and flags.

---

## [0.7.6.3] — 2026-05-26 — *Bump embedder timeouts so /search and /health survive GIL contention (demo blocker)*

Pre-demo emergency: `/api/status` started reporting `embedder_online: false`
and `indexed: 0`, the UI Knowledge Network panel rendered empty, and the
"Embedder offline" badge appeared in the topbar — even though qdrant was
healthy (491 110 points, 1.4 GB on disk, green) and the embedder log was
streaming `POST /add_batch 200 OK` continuously.

Root cause: after the v0.7.6.2 queen redeploy, `watchRemoteCore` re-streams
the bee's Hypercore from offset 0. Every dedupable entry hits `/add_batch`,
which monopolises the Python GIL on the embedder. `/health`, `/stats` and
`/search` queue behind it. Our client-side timeouts (2 s for /health, 15 s
for /search) were ate the responses, so the queen reported the embedder
offline and short-circuited `/api/query` before /search ever returned.

The data is intact; the embedder is working; we just gave up waiting too
soon under load. Fix is two numeric bumps in `query_engine.ts`:

### Changed

- `getEmbedderStatus()` /health timeout: 2 s → **20 s**. Stops the
  "embedder offline" false-negative on /api/status during catch-up.
- `queryByText()` /search timeout: 15 s → **45 s**. /search wins a GIL
  window within 45 s under realistic /add_batch load; under 15 s it was
  losing the lottery and returning empty fragments.

No logic changes, no schema changes, no UI changes. Pure number edits.

### Why not throttle replication too

That would slow the catch-up further and add code surface in the hot
path. Bumping timeouts alone gets queries answering correctly NOW —
slow but correct. Throttling can come in v0.7.6.4 after the demo if we
decide replay vs query trade-off is worth a new knob.

### Trade-off

During catch-up replay (~tens of minutes), queries take 5–15 s instead
of <1 s. After replay completes, queries are snappy again. UX is "slow
but correct" rather than "fast but lying".

---

## [0.7.6.2] — 2026-05-26 — *System prompt: ship for depth, not brevity (demo blocker)*

Pre-demo regression noticed by the operator: queries with five solid
fragments (e.g. "cell biology") were getting four-line answers. Cause
was the v0.7.2.5 system prompt rewrite — "Answer in natural prose. Be
direct." over-corrected from the earlier "the fragment mentions X"
verbosity and trained the model toward brevity.

This patch keeps every v0.7.2.5 win (no meta-narration, no inline-link
spam, terse when no data) and explicitly invites depth + context when
the fragments support it. The model now reads:

> Write detailed, thorough answers. Explain concepts in depth, add
> context, give examples, and expand on implications. Don't write
> four lines when the fragments support twenty — the user came here
> for grounded depth, not a one-paragraph summary they could get
> from any chatbot.

### Changed

- `packages/api/src/llm_client.ts::SYSTEM_PROMPT` rewritten. The
  "Voice" section now leads with depth; the "When fragments answer
  the question" section adds "synthesise across multiple fragments
  instead of dumping them one by one".

### Not changed

- No code logic changes. Pure string edit in one file.
- Same retrieval, same UI, same embedder, same maxTokens cap (1024
  tokens — if that turns into a ceiling we'll bump it; today's
  problem was the model under-using its budget, not hitting it).

### Risk note (demo freeze break)

The v0.7.6.x demo freeze was broken for this single-file, no-logic
change because the user-visible regression (one-paragraph answers)
was a demo blocker. Revert is `git revert HEAD && push` if the new
prompt over-corrects in the other direction.

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
