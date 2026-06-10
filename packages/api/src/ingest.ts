// HIVE direct mode — QUEEN-side ingest endpoint (docs/direct-mode.md).
//
// POST /internal/ingest receives signed v0.8 fragment batches from bees over
// plain HTTP — the alternative to Hypercore replication for centralized /
// enterprise deployments. The verifiability story is unchanged: the per-
// fragment ed25519 signature is checked against an explicit allowlist of
// trusted bee pubkeys before anything touches LanceDB.
//
// Processing order is strict (and the contract the tests pin down):
//   1. bearer token            → else 401
//   2. bee_id in allowlist     → else 403
//   3. EVERY signature valid   → else 400 { rejected: [ids], reason }
//      (whole-batch rejection: partial acceptance is forbidden so the bee
//       retry loop stays trivial — deterministic ids make re-delivery a no-op)
//   4. mergeInsert upsert into LanceDB
//   5. 200 { upserted, unchanged }
import { createGunzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { FragmentV08 } from '@hive/core';
import type { QueenIndex } from '@hive/embeddings-node';

export const MAX_INGEST_BATCH = 500;
// 500 fragments × (text ≤ ~4 KB + 768-d fp16 vector ≈ 2 KB b64 + metadata)
// lands well under this; the limit only exists to bound a hostile payload.
const INGEST_BODY_LIMIT = 64 * 1024 * 1024;

export interface IngestConfig {
  token: string;
  /** bee_id → ed25519 pubkey hex (the HIVE_TRUSTED_BEES allowlist). */
  trustedBees: Map<string, string>;
}

/** Parse HIVE_TRUSTED_BEES (`<bee_id>:<pubkey>[,...]`) into the allowlist. */
export function parseTrustedBees(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0 || sep === trimmed.length - 1) {
      console.warn(`[ingest] Ignoring malformed HIVE_TRUSTED_BEES entry: "${trimmed}" (want <bee_id>:<pubkey>)`);
      continue;
    }
    out.set(trimmed.slice(0, sep), trimmed.slice(sep + 1));
  }
  return out;
}

interface IngestBody {
  bee_id: string;
  batch: FragmentV08[];
}

export function registerIngestRoute(app: FastifyInstance, queenIndex: QueenIndex, cfg: IngestConfig): void {
  const expected = `Bearer ${cfg.token}`;

  app.post<{ Body: IngestBody }>('/internal/ingest', {
    bodyLimit: INGEST_BODY_LIMIT,
    // Bees gzip their batches (Content-Encoding: gzip). Fastify doesn't
    // decompress request bodies natively, so transparently gunzip the payload
    // stream before the JSON parser sees it. Scoped to this route only.
    preParsing: async (req, _reply, payload) => {
      if (req.headers['content-encoding'] !== 'gzip') return payload;
      delete req.headers['content-encoding'];
      delete req.headers['content-length'];   // length describes the compressed stream
      const gunzip = createGunzip();
      payload.pipe(gunzip);
      return gunzip;
    },
  }, async (req, reply) => {
    // 1. Bearer token.
    if (req.headers.authorization !== expected) {
      return reply.code(401).send({ error: 'unauthorized', hint: 'Send Authorization: Bearer <HIVE_INGEST_TOKEN>' });
    }

    const { bee_id, batch } = req.body ?? ({} as IngestBody);
    if (typeof bee_id !== 'string' || !Array.isArray(batch)) {
      return reply.code(400).send({ error: 'body must be { bee_id: string, batch: Fragment[] }' });
    }
    if (batch.length > MAX_INGEST_BATCH) {
      return reply.code(400).send({ error: `batch too large (${batch.length} > ${MAX_INGEST_BATCH})` });
    }

    // 2. Signer allowlist.
    const pubkey = cfg.trustedBees.get(bee_id);
    if (!pubkey) {
      console.warn(`[ingest] rejected batch: unknown bee_id=${bee_id} (size=${batch.length}, stage=allowlist)`);
      return reply.code(403).send({ error: `unknown bee_id '${bee_id}' — not in HIVE_TRUSTED_BEES` });
    }

    // 3+4. Verify every signature, then mergeInsert. All-or-nothing.
    try {
      const res = await queenIndex.ingestBatch(batch, pubkey);
      if (!res.ok) {
        console.warn(`[ingest] rejected batch: bee_id=${bee_id} size=${batch.length} stage=verify reason="${res.reason}" (${res.rejected.length} bad fragment(s))`);
        return reply.code(400).send({ rejected: res.rejected, reason: res.reason });
      }
      // 5.
      if (res.upserted > 0) console.log(`[ingest] bee_id=${bee_id} +${res.upserted} upserted, ${res.unchanged} unchanged`);
      return { upserted: res.upserted, unchanged: res.unchanged };
    } catch (e: any) {
      console.warn(`[ingest] failed: bee_id=${bee_id} size=${batch.length} stage=upsert error=${e?.message ?? e}`);
      return reply.code(500).send({ error: 'ingest upsert failed' });
    }
  });
}
