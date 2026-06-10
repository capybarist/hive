# HIVE Direct Mode — Specification (target: v1.2)

> **Feature**: an alternative transport where BEEs deliver signed fragments to a QUEEN over plain HTTP, with no P2P stack involved.
> **Motivation**: centralized and enterprise deployments that want HIVE's pipeline (forage → chunk → embed → sign) and verified-fragment model, but run on conventional infrastructure — one operator, private network or single VPS — where Hypercore replication adds operational complexity without benefit.
> **Guarantee preserved**: per-fragment ed25519 signatures. Verifiability never depended on the transport; it depends on the signature. Direct mode keeps it intact.

---

## 1. Scope

**In scope**
- New BEE transport: HTTP batch delivery to a QUEEN ingest endpoint.
- New QUEEN endpoint: `POST /internal/ingest` (verify → upsert into LanceDB).
- Transport selection via configuration; P2P mode remains the default and is untouched.
- A new `CatalogSource` specialization of `ForagerSource` for sources with an authoritative listing.

**Out of scope (explicitly)**
- Removing or refactoring the Hypercore/Hyperswarm/Hyperbee path. Direct mode is additive.
- Abstracting `KnowledgeStore` behind a storage port (known to require a rewrite; not this release).
- Multi-writer coordination, queen federation, or any change to QUEEN search/synthesis.
- Auth beyond a shared bearer token (key rotation tooling, mTLS, etc. can come later).

## 2. Configuration

```bash
# BEE
HIVE_TRANSPORT=p2p | direct      # default: p2p (no behavior change for existing nodes)
HIVE_QUEEN_URL=https://queen.example.com   # required when direct
HIVE_INGEST_TOKEN=<shared secret>           # required when direct
HIVE_BEE_SIGNING_KEY=<ed25519 private key>  # same as today

# QUEEN
HIVE_INGEST_ENABLED=true | false  # default: false
HIVE_INGEST_TOKEN=<shared secret>
HIVE_TRUSTED_BEES=<bee_id>:<ed25519 pubkey>[,...]   # allowlist of signers
```

A BEE in direct mode performs the full Forager pipeline exactly as today; only the final "publish" step changes (HTTP POST instead of Hyperbee append).

## 3. Ingest endpoint contract

```
POST /internal/ingest
Authorization: Bearer <HIVE_INGEST_TOKEN>
Content-Encoding: gzip (optional, recommended)
Content-Type: application/json

{
  "bee_id": "string",
  "batch": [ Fragment, ... ]        // max 500 fragments per request
}
```

**QUEEN processing (strict order):**
1. Verify bearer token → else `401`.
2. Look up `bee_id` in `HIVE_TRUSTED_BEES` → unknown bee → `403`.
3. Verify the ed25519 signature of **every** fragment in the batch against that bee's pubkey. Any failure → reject the **entire batch** with `400 { rejected: [fragment ids], reason }`. Partial acceptance is forbidden (keeps retry semantics trivial).
4. Upsert into LanceDB: `table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll()`.
5. Respond `200 { upserted: n, unchanged: n }`.

**Idempotency invariant**: fragments carry deterministic ids (derived from source identity + structural anchor + chunk index — not random UUIDs). Therefore a BEE retries a whole batch on any network failure or non-200, with exponential backoff, and double delivery is harmless by construction. This invariant is the cornerstone of direct mode: document it in the Fragment docs and enforce it with a test.

**Fragment schema**: unchanged from HIVE's current Fragment, plus an optional extensible `meta: Record<string, unknown>` field so domain-specific deployments can attach structured metadata (e.g. document anchors, validity windows) without forking the schema. `meta` is stored and returned verbatim; core HIVE never interprets it.

## 4. CatalogSource

Today's `ForagerSource` models frontier-style sources (follow discovered links — e.g. Wikipedia). Many high-value sources are instead *catalogued*: an authoritative registry can enumerate every document and report changes. Add:

```typescript
interface CatalogEntry {
  sourceId: string;        // stable identifier within the source
  url: string;
  lastModified?: string;   // ISO date when the catalog provides it
}

interface CatalogSource extends ForagerSource {
  listAll(): AsyncIterable<CatalogEntry>;
  changedSince(date: Date): AsyncIterable<CatalogEntry>;
  fetch(entry: CatalogEntry): Promise<RawDocument>;
}
```

**Completeness becomes verifiable**: after a sweep, `diff(catalog ids, local inventory ids)` must be empty. The BEE persists its inventory (sourceId → content_hash) in local SQLite and exposes sweep summaries (`new / changed / unchanged / errors`) in logs.

**Change detection**: recompute `content_hash` per fragment; skip embedding and delivery for unchanged hashes (embedding cache keyed by content_hash). This makes incremental sweeps nearly free.

## 5. Testing & acceptance

- Unit: deterministic id generation; signature verify (happy path + tampered fragment + unknown bee); batch rejection atomicity.
- Integration: ingest the same batch twice → second response reports `unchanged == batch.length` and LanceDB row count is stable.
- E2E: a BEE in `HIVE_TRANSPORT=direct` against a local QUEEN completes a sweep of a fixture `CatalogSource` (3 documents, no network), and a QUEEN vector search returns the ingested fragments with valid signatures.
- Regression: full existing P2P test suite passes untouched with `HIVE_TRANSPORT=p2p`.

## 6. Documentation

- README: new "Deployment modes" section — P2P (default, decentralized) vs Direct (centralized, single operator). One-paragraph guidance on choosing.
- `docs/direct-mode.md`: this contract, the idempotency invariant, and a docker-compose example with one BEE + one QUEEN on a single host.

## 7. Engineering notes

- TypeScript strict; no new runtime dependencies beyond what HIVE already ships (HTTP server already present in QUEEN).
- No silent catches; ingest failures log `bee_id`, batch size, and stage.
- Conventional commits; land as a single reviewed PR: `feat: direct mode transport (bee → queen HTTP ingest)`.