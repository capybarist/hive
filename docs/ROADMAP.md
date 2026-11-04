# HIVE — Roadmap

> Last revised: 2026-11-04, at v1.5.0.
> Source of truth for "what's next". Update this file when items move between
> sections. Per-version detail lives in [CHANGELOG](../CHANGELOG.md), which is
> authoritative on what has shipped.

Section conventions: each item starts with **why** (the problem) and ends with
the **shape** of the work (what we'd actually build).

---

## 0. Where we are

**v1.5.0.** A public demo queen runs at
[hive.capybaralabs.tech](https://hive.capybaralabs.tech) (Hetzner, fed by
bee-1 Wikipedia and bee-2 news RSS, ~242 k signed fragments). The first
commercial product on HIVE, [Acquis](https://acquislaw.com), runs a closed,
signed EU-law corpus on direct mode.

The v0.8 all-Node engine is unchanged underneath: bees chunk, embed (e5-base
ONNX) and sign vectors inline; the queen verifies, upserts into LanceDB, embeds
only the query, gates relevance, and synthesises with the LLM.

Shipped since the previous revision of this file (2026-06-09):

| Version | Date | What |
|---|---|---|
| v1.0.0 | 2026-06-09 | First stable release: v0.9 productisation (Settings UI, topics, ForagerRegistry, auth, npm + MCP) |
| v1.1.0–1.1.1 | 2026-06-10 | **Direct mode**: bee → queen over HTTP, no P2P, for closed deployments; circuit breaker for queen outages |
| v1.2.0–1.2.1 | 2026-06-10/11 | Promoted meta columns (`HIVE_META_COLUMNS`), contextualised embedding input, CLI env precedence |
| v1.3.0–1.3.2 | 2026-06-24/28 | Optional cross-encoder **reranker** (`HIVE_RERANK`), bounded memory |
| v1.4.0 | 2026-10-06 | Verbatim chunker `layout-v2`, `filters.meta` on `/api/query`, `rerank_score` |
| v1.4.1 | 2026-11-04 | Query-only demo token (security), `last_indexed_at` liveness, releases from CHANGELOG |
| v1.5.0 | 2026-11-04 | **Score-by-corroboration** (`HIVE_CORROBORATION`): dedupe identical texts, `corroboration_count`, `cos × ln(1 + n)` ranking |

The three focus items agreed on 2026-06-09 all shipped: npm-loadable external
connectors (plugin loader), the personal-memory connector v1, and a non-P2P
centralised mode (direct mode).

---

## 0b. Current focus (next 3)

1. **Make corroboration visible on the demo.** v1.5.0 ships the score behind
   `HIVE_CORROBORATION`, but the demo's two bees (Wikipedia, RSS) never sign
   the same text, so every count is 1. Point a second bee at an overlapping
   scope and turn the flag on; the UI already marks a source chip with
   "×N bees" when N > 1.
2. **Demo that shows the network working.** The public queen is the project's
   shop window: keep it on the latest release, show live activity (done in
   v1.4.1: `last_indexed_at`), and add a swarm view (§4).
3. **Connector robustness** (§1–2): arXiv `Retry-After` cooldown so bee-2 can
   go back to arXiv, RSS entity-limit hardening, generic web dispatch.

---

## 1. Open regressions from the v0.8 migration

- **Generic web crawler dispatch** — `packages/agent/src/forager/web_source.ts`
  is alive in code but no caller dispatches non-specialised URLs to it. In v0.6
  the forager fell back to WebSource for URLs no adapter claimed.
  *Shape:* a URL→adapter dispatcher in `autonomous_extractor` so outbound links
  found during a crawl can hand off to WebSource. Useful first for Wikipedia's
  outbound links. Note: generic `web` stays passive by design (non-deterministic
  crawl breaks corroboration).
- **arXiv adapter backoff hardening** — 2 attempts × 5 s isn't enough once a
  box has been rate-limited by an arXiv 429.
  *Shape:* honour `Retry-After`, persist a cooldown across cycles (file in
  `data/`), exponential up to ~30 min. Until then the demo's bee-2 uses RSS.

Fixed: `npx hive-bee` (v0.8.9), npm-installable HIVE (`@capybaralabs/hive`,
v0.8.15).

---

## 2. Near-term polish (1-2 sessions each)

- **Fragment id hygiene** — the Wikipedia adapter can still leak heading text
  (incl. `_edit_…`) into chunk ids. Cosmetic but visible in `/api/fragments`.
  *Shape:* strip wiki markup leftovers before `slugify`.
- **RSS adapter — XML parser hardening** — Guardian's feed trips
  `fast-xml-parser`'s entity expansion limit ("1008 > 1000") and the cycle
  returns zero items.
  *Shape:* raise/disable the entity limit, or fall back per-feed to a more
  permissive parser.
- **Newest-first indexing on the queen** — smooths the "is anything happening?"
  experience after a deploy.
  *Shape:* reverse backfill plus a live-tail watcher in `watchRemoteCoreV08`.
- **Settings → API auth key actually rotates the key.** `POST /api/auth-key`
  writes `HIVE_API_KEY` to `.runtime.env`, but boot only applies `LLM_*` keys
  from that file, so the new key never takes effect on Docker deployments.
  *Shape:* apply `HIVE_API_KEY` from `.runtime.env` (and say so in the UI), or
  remove the button and document rotation via the host env.

Shipped: Settings UI + Public Topics Registry (v0.9.0–0.9.4), bee dashboard
separate from the queen's (v0.9.5), MCP server + Claude Skill (v0.8.x).

---

## 3. Scale and durability

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
- ~~**Score-by-corroboration**~~ — shipped in v1.5.0 behind
  `HIVE_CORROBORATION=on`. Next step: default it on once a public queen has
  overlapping bees to validate the ranking on, and consider a scalar index on
  `content_hash` if the count lookup (~70 ms over 250k rows) grows with the corpus.

---

## 4. Marketing / community (further out)

- **Swarm visualizer** — live web view: bees joining/leaving, replication
  flows, peers per topic. Wow factor for the site and a free debug tool.
- **Reputation + Query Blueprints + bounties** — an operator says "I want
  this indexed", bees that deliver get reputation/bounties. Needs a real
  community of bees first.
- **Tit-for-tat / proof-of-storage** — skip until somebody actually freerides
  at scale.

---

## 5. Designed-in (free; we just keep the enablers)

- **Distributed embedding-model migration.** When the network upgrades
  past e5-base, each bee detects its `embedding_model` mismatch at startup,
  re-embeds its local text into a fresh core, and the queen segregates by
  `embedding_model` during the rollout window. No queen-side mass re-index
  ever. Full detail in
  [`V0.8-MIGRATION.md` §9](./V0.8-MIGRATION.md#9-designed-in-future-embedding-model-migration-distributed-re-embed).

---

## 6. Killed / mooted by v0.8

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

1. Keep the demo on the latest release (merge to `main` deploys it).
2. Overlapping bees on the demo so corroboration shows (§0b).
3. arXiv cooldown so bee-2 can index papers again (§1).

If the user asks "what would make this a product?":

1. **One-click self-host** (§3)
2. **Multi-tenant API tokens + audit log** for hosted queens
3. **Swarm visualizer** on the demo (§4)
