# HIVE Direct Mode

> **What**: an alternative transport where BEEs deliver signed fragments to a
> QUEEN over plain HTTP, with no P2P stack involved.
> **Why**: centralized and enterprise deployments that want HIVE's pipeline
> (forage → chunk → embed → sign) and verified-fragment model, but run on
> conventional infrastructure — one operator, private network or single VPS —
> where Hypercore replication adds operational complexity without benefit.
> **Guarantee preserved**: per-fragment ed25519 signatures. Verifiability never
> depended on the transport; it depends on the signature. Direct mode keeps it
> intact — the queen verifies every fragment against an explicit signer
> allowlist before anything touches LanceDB.

Direct mode is **additive**: P2P stays the default, and a node without
`HIVE_TRANSPORT=direct` behaves exactly as before. A queen can serve P2P
replication and direct ingest at the same time.

## Configuration

```bash
# BEE
HIVE_TRANSPORT=p2p | direct       # default: p2p (no behavior change for existing nodes)
HIVE_QUEEN_URL=https://queen.example.com    # required when direct
HIVE_INGEST_TOKEN=<shared secret>           # required when direct

# QUEEN
HIVE_INGEST_ENABLED=true | false  # default: false
HIVE_INGEST_TOKEN=<shared secret>
HIVE_TRUSTED_BEES=<bee_id>:<ed25519 pubkey>[,...]   # allowlist of signers
HIVE_SWARM=on | off               # default: on. `off` = fully closed queen
HIVE_META_COLUMNS=k1,k2,…         # v1.2: promote these meta keys to filterable
                                  # `meta_<k>` LanceDB columns at ingest
```

**`HIVE_SWARM=off`** is the closed-deployment switch for the queen side: the
node joins **no** Hyperswarm topic — not the public commons, not private
topics, not the Public Topics Registry — so it neither replicates from nor
announces to anyone. Its only fragment source is `/internal/ingest`. Without
it, a queen serves direct ingest *and* p2p replication at once (both are
fine; pick per deployment). A direct bee never needs the flag — direct
transport already implies no swarm.

A BEE in direct mode performs the full forager pipeline exactly as today; only
the final "publish" step changes (HTTP POST instead of Hyperbee append). It
joins **no** Hyperswarm topic — there is no core to replicate and nothing to
announce. A direct bee logs its `bee_id:pubkey` allowlist line at boot so the
queen operator can copy it into `HIVE_TRUSTED_BEES` verbatim.

`HIVE_TRANSPORT` is a *bee* setting (it only applies to `HIVE_MODE=bee`).
`HIVE_INGEST_ENABLED` is a *queen* setting. Misconfiguration fails fast at
boot: a direct bee without `HIVE_QUEEN_URL`/`HIVE_INGEST_TOKEN`, or an
ingest-enabled queen without `HIVE_INGEST_TOKEN`, refuses to start.

## Ingest endpoint contract

```
POST /internal/ingest
Authorization: Bearer <HIVE_INGEST_TOKEN>
Content-Encoding: gzip (optional, recommended — the shipped bee always gzips)
Content-Type: application/json

{
  "bee_id": "string",
  "batch": [ Fragment, ... ]        // max 500 fragments per request
}
```

**QUEEN processing (strict order):**

1. Verify bearer token → else `401`.
2. Look up `bee_id` in `HIVE_TRUSTED_BEES` → unknown bee → `403`.
3. Verify the ed25519 signature of **every** fragment in the batch against
   that bee's pubkey (plus the network model/dim invariants). Any failure →
   reject the **entire batch** with `400 { rejected: [fragment ids], reason }`.
   Partial acceptance is forbidden (keeps retry semantics trivial).
4. Upsert into LanceDB via `mergeInsert("id")` — update on match, insert on
   miss. Fragments whose stored `content_hash` already matches are skipped.
5. Respond `200 { upserted: n, unchanged: n }`.

The ingest token is its own secret, independent of `HIVE_API_KEY` (the
operator/query API gate). `/internal/ingest` is not part of the public
`PROTECTED_PREFIXES` machinery; it always enforces its own bearer check.

## The idempotency invariant

Fragments carry **deterministic ids** derived from source identity +
structural anchor + chunk index (e.g. `wiki_Photosynthesis_Intro_c0`) — never
random UUIDs. Therefore a BEE retries a whole batch on any network failure or
5xx, with exponential backoff (5 attempts, 1s·2ⁿ + jitter), and double
delivery is harmless by construction: the queen upserts by id and reports
re-deliveries as `unchanged`.

This invariant is the cornerstone of direct mode. It is documented on
`FragmentV08.id` in `schema_v08.ts` and pinned by
`packages/api/src/test_direct_mode.ts` (`npm run test:direct -w @hive/api`).

One deliberate deviation from blind "retry on any non-200": a **4xx** response
(bad token, unknown bee, failed signature) is deterministic — retrying cannot
fix it — so the bee fails fast, logs `bee_id`, batch size and stage, drops the
poisoned batch from its buffer (so the pipeline doesn't wedge behind it), and
surfaces the error in the cycle summary.

## Fragment schema: `meta`

`FragmentV08` gains an optional extensible `meta: Record<string, unknown>` so
domain-specific deployments can attach structured metadata (document anchors,
validity windows, …) without forking the schema. `meta` sits **inside the
signed payload** (tampering breaks verification), is stored verbatim (JSON
column in LanceDB) and returned verbatim in search hits; core HIVE never
interprets it. Adapters attach it via `VerbatimFragment.meta`.

Note for pre-existing queens: LanceDB tables created before this release have
no `meta` column. Writes still work — `meta` is dropped with a one-time warning
— but keeping it requires recreating the index (it re-fills from the bees'
signed cores / re-delivery).

Two v1.2 refinements close the loop for domain deployments:

- **Promoted meta columns** — `HIVE_META_COLUMNS=celex,article,…` on the queen
  lifts those meta keys into real `meta_<k>` LanceDB columns at ingest, so a
  product layer can run exact filtered lookups (`meta_article = '6'`) instead
  of parsing JSON. The full `meta` JSON is still stored verbatim.
- **`VerbatimFragment.embedText`** — an adapter may supply anchor-contextualized
  embedding input ("AI Act, Article 6(1)(a): …") while the stored, signed
  `text` stays verbatim. Citation-shaped queries retrieve far better.

## CatalogSource

`ForagerSource` models frontier-style sources (follow discovered links — e.g.
Wikipedia). Many high-value sources are instead *catalogued*: an authoritative
registry can enumerate every document and report changes.

```typescript
interface CatalogEntry {
  sourceId: string;        // stable identifier within the source
  url: string;
  lastModified?: string;   // ISO date when the catalog provides it
}

interface CatalogSource extends ForagerSource {
  listAll(): AsyncIterable<CatalogEntry>;
  changedSince(date: Date): AsyncIterable<CatalogEntry>;   // err inclusive (>=)
  fetchEntry(entry: CatalogEntry): Promise<FetchResult>;
}
```

(Naming: the spec sketched `fetch(entry) → RawDocument`, but `ForagerSource`
already owns `fetch(url) → FetchResult` with an incompatible signature, so the
per-entry fetch is `fetchEntry` and reuses the existing verbatim-fragment
envelope.)

A `CatalogSource` registers like any forager with `kind: 'catalog'` in its
descriptor; the extractor then runs a **sweep** instead of a crawl
(`catalog_sweep.ts`):

- First run: `listAll()` — full sweep. After it, **completeness is
  verifiable**: `diff(catalog ids, local inventory ids)` must be empty, and
  the sweep reports any miss.
- Later runs: `changedSince(lastSweep)` — incremental.
- **Change detection**: the document's verbatim text is re-hashed
  (`content_hash`) and compared against the bee's persisted inventory
  (`catalog_inventory_<source>.json`, sourceId → content_hash; same JSON-file
  pattern as `CrawlQueue` — no SQLite dependency). Unchanged documents skip
  chunking, embedding and delivery entirely, so incremental sweeps are nearly
  free. Sweep summaries (`new / changed / unchanged / errors`) land in the
  cycle logs.
- The TTL freshness skip does **not** apply on the catalog path: content_hash
  is the change detector, and a changed document must re-embed even if its TTL
  hasn't lapsed.

CatalogSource works under both transports — it's about *what* to extract;
direct mode is about *where* it goes.

## Local sandbox in one command

```bash
bash direct.sh                                   # queen :8090 + direct bee :8080
HIVE_OBJECTIVE='"Quantum computing"' bash direct.sh   # pick the crawl topic
bash direct.sh clean                             # wipe the sandbox (~/.hive-direct)
```

`direct.sh` does the allowlist handshake automatically (pre-creates the bee
identity and injects `bee_id:pubkey` into the queen's `HIVE_TRUSTED_BEES`),
generates and persists a shared ingest token, starts both nodes and tails
their logs; Ctrl+C shuts both down cleanly. The sandbox queen runs
`HIVE_SWARM=off`, so its index contains exactly what the sandbox bee
delivered over HTTP — nothing replicates in from the public network. It prints a ready-to-paste
raw-fragment query (`"use_llm": false` — no LLM key needed) filtered by the
sandbox bee's node id. The manual two-step handshake below is only needed
when bee and queen live on different machines.

The single-node launchers understand direct mode too — the env vars pass
straight through:

```bash
# a direct bee against a remote queen
HIVE_TRANSPORT=direct HIVE_QUEEN_URL=https://queen.example.com \
HIVE_INGEST_TOKEN=<secret> bash hive.sh

# a queen accepting direct ingest
HIVE_INGEST_ENABLED=true HIVE_INGEST_TOKEN=<secret> \
HIVE_TRUSTED_BEES=<bee_id>:<pubkey> bash queen.sh
```

## docker-compose example (one host, one BEE + one QUEEN, no swarm)

```yaml
# Direct mode: bee → queen over the compose network. No Hyperswarm, no
# replicated cores — the queen's LanceDB is the only fragment store.
services:
  queen:
    image: ghcr.io/capybarist/hive:latest
    container_name: hive-queen
    restart: unless-stopped
    environment:
      - HIVE_MODE=queen
      - HIVE_PORT=8090
      - HIVE_DATA_DIR=/hive/data
      - HIVE_INGEST_ENABLED=true
      - HIVE_SWARM=off   # closed deployment: ingest is the only fragment source
      - HIVE_INGEST_TOKEN=${HIVE_INGEST_TOKEN:?set a shared secret}
      # Boot the bee once, copy the "Direct transport ✓" line from its log:
      - HIVE_TRUSTED_BEES=${HIVE_TRUSTED_BEES:?<bee_id>:<pubkey>}
      - LLM_PROVIDER=${LLM_PROVIDER:-groq}
      - LLM_API_KEY=${LLM_API_KEY:-}
    ports:
      - "8090:8090"
    volumes:
      - queen-data:/hive/data

  bee-1:
    image: ghcr.io/capybarist/hive:latest
    container_name: hive-bee-1
    restart: unless-stopped
    environment:
      - HIVE_MODE=bee
      - HIVE_PORT=8080
      - HIVE_DATA_DIR=/hive/data
      - HIVE_AUTOSTART=1
      - HIVE_TRANSPORT=direct
      - HIVE_QUEEN_URL=http://queen:8090
      - HIVE_INGEST_TOKEN=${HIVE_INGEST_TOKEN:?same shared secret}
    expose:
      - "8080"
    volumes:
      - bee1-data:/hive/data
    depends_on:
      - queen

volumes:
  queen-data:
  bee1-data:
```

First boot is a two-step handshake: start the bee, read its
`Direct transport ✓ → … (queen must list this bee in HIVE_TRUSTED_BEES as
<bee_id>:<pubkey>)` log line, put that value in the queen's
`HIVE_TRUSTED_BEES`, restart the queen. Until then the queen answers `403`
and the bee retries harmlessly.

## Testing

- `npm run test:direct -w @hive/api` — the direct-mode suite: deterministic
  ids, signature verification (happy / tampered / unknown bee), whole-batch
  rejection atomicity, double-ingest idempotency (`unchanged == batch.length`,
  stable row count), and an offline E2E (fixture `CatalogSource` with 3
  documents → `DirectTransport` over localhost HTTP → queen LanceDB → vector
  search returns the fragments with `meta` intact).
- Regression: the existing P2P suites (`test_v08.ts`, embeddings-node
  `test.ts` / `test_phase4.ts`) pass untouched — `HIVE_TRANSPORT=p2p` paths
  are unchanged.

## Out of scope (deliberately)

- Removing or refactoring the Hypercore/Hyperswarm/Hyperbee path. Direct mode
  is additive.
- Abstracting `KnowledgeStore` behind a storage port (known to require a
  rewrite; not this release).
- Multi-writer coordination, queen federation, or any change to QUEEN
  search/synthesis.
- Auth beyond a shared bearer token (key rotation tooling, mTLS, etc. can come
  later).
