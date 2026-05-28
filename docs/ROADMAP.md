# HIVE — Roadmap

> Last revised: 2026-05-28, post v0.8.2 deploy. Source of truth for "what's
> next". Update this file when items move between sections.

Section conventions: each item starts with **why** (the problem) and ends with
the **shape** of the work (what we'd actually build).

---

## 0. Where we are

**v0.8.2 is live on Hetzner.** Bee-1 (Wikipedia generalist) and bee-2 (arXiv
ML specialist) produce signed fragments with the vector inline; the queen
replicates both cores, verifies signatures, upserts pre-computed vectors into
LanceDB, embeds only the query, gates with the recalibrated 0.82 threshold,
and synthesises with the LLM. No Python, no Qdrant, no topic_tree.

Recently shipped (since v0.7.7.12):

- **v0.8.0** — All-Node stack, e5-base ONNX in-process embedder, LanceDB,
  Fragment schema v2 with the vector inside the signed payload, deterministic
  chunking, recalibrated retrieval gate.
- **v0.8.1** — Queen UI brand (HiveLogo), peering self-heal that refreshes
  Hyperswarm discovery when `peerCount=0`, README rewritten with a single
  clearer diagram.
- **v0.8.2** — `topic_tree.json` removed (1842 LoC of v0.6 taxonomy gone).
  Bees seed their crawl from the manifest's partition → scope → objective →
  adapter default.
- **multi-bee in prod** — bee-2 added as an arXiv ML specialist with an
  intentionally non-overlapping manifest, exercising the partition/scope path
  end-to-end.

---

## 1. Things we lost in the v0.8 migration (regression fixes)

These were working in v0.7 and the migration silently broke them. Priority is
"do them before they bite somebody".

- **`npx hive-bee` install path** — `bin/hive-bee` still ships in
  `package.json`'s `bin`, but the script tries to `pip install
  packages/embeddings/requirements.txt` (the Python package we deleted).
  Anyone running `npx hive-bee` today gets a hard error.
  *Shape:* rewrite the script for v0.8 (`npm install && bash hive.sh`, no
  pip), or remove the bin entry from `package.json` and document `bash
  hive.sh` as the canonical path.
- **Generic web crawler regression** — `packages/agent/src/forager/web_source.ts`
  is alive in code but no caller dispatches non-Wikipedia URLs to it. In v0.6
  the forager had a generic "URL doesn't fall to a specialised adapter →
  WebSource" fallback. v0.7+ moved to per-source extractors and the dispatch
  never came back.
  *Shape:* add a URL→adapter dispatcher to `autonomous_extractor` so external
  links discovered during a crawl can hand off to WebSource. Useful first for
  the Wikipedia adapter (lots of outbound non-wiki links).
- **arXiv adapter backoff hardening** — the adapter's 2 attempts × 5 s
  backoff isn't enough once a box has been rate-limited by an arXiv 429.
  Discovered while standing up bee-2 (the adapter code is correct, queries
  are well-formed, but arXiv's rate window punished the CI-driven deploy
  churn). Each deploy and every crawl cycle compounds it.
  *Shape:* honour the `Retry-After` header arXiv sends with 429, persist a
  cooldown across cycles (file in `data/`), exponential up to ~30 min.
  Until this lands, bee-2 uses RSS — flip `HIVE_SOURCES` back to `arxiv` in
  compose once the cooldown logic ships.

---

## 2. Near-term polish (1-2 sessions each)

- **Fragment id hygiene** — the Wikipedia adapter leaks long heading text
  (incl. literal `_edit_main_article_…`) into chunk ids. Cosmetic but very
  visible in logs and `/api/fragments`.
  *Shape:* tighter slugger that strips Wiki markup leftovers and caps length
  before forming the id.
- **Settings UI in the node web** *(big new direction — see §3)*.
- **Newest-first indexing on the queen** — was a v0.7 idea blocked by the
  Hypercore fork bug. v0.8 fresh cores make it less urgent (we see 16 k →
  20 k indexed within minutes after a restart), but it would still smooth
  the "is anything happening?" experience after a deploy.
  *Shape:* reverse backfill plus a live-tail watcher in `watchRemoteCoreV08`,
  prioritising the newest seq first.

---

## 3. 🌟 Settings UI + Public Topics Registry (user-requested, v0.9)

This is the next big direction the product needs. Today the manifest lives in
env vars, the LLM key lives in `/api/config` (UI-driven but partial), and
discovery of what other bees offer happens only by peering. End state:

- **Settings page in the node UI** (`packages/ui/index.html`) covering:
  - **Manifest builder.** Pick adapter (Wikipedia/arXiv/RSS/Common Crawl/Web)
    from a dropdown, choose policy (drift-ok / exclusive), pick a scope
    (category tree, arxiv categories, RSS feeds, CC domains), pick a
    partition. Live preview of the JSON manifest. No more env-var copy-paste.
  - **Public ⇄ private toggle per declared source.** Private = the bee stays
    on the topic but never advertises it; only operators with the
    coreKey/topic out-of-band can discover it (use cases 02/03 in the
    README). Public = the bee publishes its manifest to the **Public Topics
    Registry** (next bullet) so anyone can subscribe.
  - **LLM provider + key.** Already partially in `/api/config`; absorbed
    under one settings flow.
  - **Apply** = save the manifest, restart the node so it republishes (no
    surprise hot-swap; v0.8 fragments depend on a stable identity).
- **Public Topics Registry — P2P, no server.** A separate, public Hypercore
  topic where bees announce small entries:
  `{ adapter, scope, sample_url, bee_pubkey, replication: 'all' }`. Anyone
  running a node can subscribe and browse "what's being indexed on this
  network right now". Spammable; mitigate later with reputation + per-bee
  rate limits.
  *Shape:* a tiny new "topics core" alongside the existing `fragments`
  Hypercore; CRUD via the Settings UI; a `/api/topics-registry` endpoint to
  consume.

This collapses three pieces (manifest, LLM key, exposure mode) into one
operator-facing surface and makes HIVE-the-product visible to a non-technical
operator for the first time.

---

## 4. MCP / agents integration (the productization)

The "you can sell this as a tool" lever. Two flavours of the same idea:

- **MCP server for HIVE** — wraps `/api/query` (and `/api/fragments`,
  `/api/directory`) as MCP tools. Claude Code, Cursor, Continue, Goose, any
  MCP-aware host can use HIVE as a native knowledge source.
  *Shape:* `packages/mcp-server`, runs alongside the api_server or as a
  separate binary; serves stdio or SSE; documented as
  `npx @hive/mcp-server`.
- **OpenClaw / Claude Skills connector** — same family, different
  packaging. A bundled Skill manifest that calls `/api/query` and renders
  results.
  *Shape:* a `skills/` directory shipped from this repo with a ready-to-load
  Skill; deploy guide on capybarahome.

The README and the capybarahome `/hive` page already advertise these as
"Coming" — promise to deliver. Both are pure additive packaging on top of the
existing API; no v0.8 internals change.

---

## 5. Scale and durability

- **Selective replication (Bloom/centroid routing)** — the queen today
  replicates every bee's Hypercore in full. With one Wikipedia bee that's
  hundreds of MB; with a fleet of bees it stops scaling. Each bee announces
  a Bloom filter (or centroid set) over its content; the queen subscribes
  only to bees whose Bloom intersects its declared interests.
  *Shape:* extension to `BeeManifest` + a new Protomux channel for the Bloom
  exchange; selective `watchRemoteCoreV08` start.
- **One-click self-host** — Umbrel / CasaOS / Pikapods package for a
  private queen with a guided LLM-key step. Adoption vector for
  non-engineers.
- **Score-by-corroboration** — `cos_sim × log(1 + corroboration_count)`,
  where `corroboration_count` = number of distinct bees that signed a
  fragment with the same `content_hash`. Already enabled by the v0.8
  schema; needs the count to actually be computed at query time. Lights up
  once multi-bee is in real use.

---

## 6. Marketing / community (further out)

- **Swarm visualizer** — live web view: bees joining/leaving, replication
  flows, peers per topic. Wow factor for the site and a free debug tool.
- **Reputation + Query Blueprints + bounties** — an operator says "I want
  this indexed", bees that deliver get reputation/bounties. Needs a real
  community of bees first.
- **Tit-for-tat / proof-of-storage** — skip until somebody actually freerides
  at scale.

---

## 7. Designed-in (free; we just keep the enablers)

- **Distributed embedding-model migration.** When the network upgrades
  past e5-base, each bee detects its `embedding_model` mismatch at startup,
  re-embeds its local text into a fresh core, and the queen segregates by
  `embedding_model` during the rollout window. No queen-side mass re-index
  ever. Full detail in
  [`V0.8-MIGRATION.md` §9](./V0.8-MIGRATION.md#9-designed-in-future-embedding-model-migration-distributed-re-embed).

---

## 8. Killed / mooted by v0.8

Kept here as a graveyard so we don't accidentally bring them back.

- **Qdrant quantization** — moot. We use LanceDB.
- **Python embedder hardening / batched ingest / surrogate sanitisation** —
  the whole class of problems disappeared with the all-Node stack.
- **`topic_tree.json` cleanup** — done in v0.8.2.
- **Layout-based semantic chunking on the bee** — done; the deterministic
  chunker (`packages/embeddings-node/src/chunker.ts`) is the layout-based
  algorithm we'd planned.
- **Hypercore fork recovery procedure** — the v0.7.7.12 graceful-shutdown
  fix plus the v0.8 fresh-core cutover removed the failure mode. Keep the
  recovery runbook archived but it's no longer roadmap.

---

## Quick reference — what does *the user* need next?

If the user asks "what should I do this week?":

1. **Verify bee-2 (arXiv ML specialist)** produces papers after the
   `scope.categories`-as-filter fix lands. → §0.
2. **Fix the `npx hive-bee` install path or remove it.** → §1.
3. **Settings UI prototype.** Pick *just* the manifest builder + apply +
   restart, ship it, then iterate. → §3.

If the user asks "what would make this a product?":

1. **Settings UI** + **Public Topics Registry** (§3)
2. **MCP server** (§4)
3. **One-click self-host** (§5)

Everything else can wait.
