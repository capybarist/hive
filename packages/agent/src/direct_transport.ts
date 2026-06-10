// HIVE direct mode — BEE-side transport (docs/direct-mode.md).
//
// A FragmentSink that delivers signed v0.8 fragments to a queen's
// POST /internal/ingest over plain HTTP instead of appending to the local
// Hyperbee. The pipeline upstream (forage → chunk → embed → sign) is
// identical to p2p mode; verifiability rides on the per-fragment ed25519
// signature, not on the transport.
//
// Retry semantics rest on the deterministic-id invariant: fragments carry
// ids derived from source identity + structural anchor + chunk index, and the
// queen upserts by id — so the bee retries a WHOLE batch on network failure
// or 5xx with exponential backoff, and double delivery is harmless by
// construction. 4xx responses are deterministic (bad token, unknown bee,
// failed signature): retrying cannot fix them, so they fail fast and loud.
//
// Delivered-fragment inventory (id → { extracted_at, content_hash }) persists
// in a JSON file under the data dir — same pattern as CrawlQueue — and backs
// the extractor's TTL freshness check, so a restarted direct bee doesn't
// re-embed and re-deliver everything it already shipped.
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BeeManifest, FragmentV08 } from '@hive/core';
import type { FragmentSink } from './fragment_sink.js';

export interface DirectTransportOptions {
  /** Queen base URL (HIVE_QUEEN_URL), e.g. https://queen.example.com */
  queenUrl: string;
  /** Shared bearer secret (HIVE_INGEST_TOKEN). */
  token: string;
  /** This bee's node id — the queen looks it up in HIVE_TRUSTED_BEES. */
  beeId: string;
  /** Where the delivery inventory persists (the bee's HIVE_DATA_DIR). */
  dataDir: string;
  /** Manifest the api_server built for this bee (drives source selection). */
  manifest?: BeeManifest | null;
  /** Max fragments per POST. The endpoint rejects > 500. */
  maxBatch?: number;
  /** Delivery attempts per batch before giving up (backoff 1s·2^n + jitter). */
  maxAttempts?: number;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
}

interface InventoryEntry { extracted_at: string; content_hash: string; }
interface InventoryFile { delivered: Record<string, InventoryEntry>; }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A 4xx from the queen — deterministic, not retryable. */
export class IngestRejectedError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'IngestRejectedError'; }
}

export class DirectTransport implements FragmentSink {
  private readonly ingestUrl: string;
  private readonly token: string;
  private readonly beeId: string;
  private readonly inventoryPath: string;
  private readonly manifest: BeeManifest | null;
  private readonly maxBatch: number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  private buffer: FragmentV08[] = [];
  private delivered = new Map<string, InventoryEntry>();
  private loaded = false;

  constructor(opts: DirectTransportOptions) {
    this.ingestUrl = `${opts.queenUrl.replace(/\/+$/, '')}/internal/ingest`;
    this.token = opts.token;
    this.beeId = opts.beeId;
    this.inventoryPath = resolve(opts.dataDir, 'direct_inventory.json');
    this.manifest = opts.manifest ?? null;
    this.maxBatch = Math.min(opts.maxBatch ?? 500, 500);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  async ready(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.inventoryPath, 'utf8')) as InventoryFile;
      for (const [id, e] of Object.entries(raw.delivered ?? {})) this.delivered.set(id, e);
      console.log(`[direct] inventory loaded — ${this.delivered.size} delivered fragments`);
    } catch { /* first run — empty inventory */ }
  }

  get localFragmentCount(): number { return this.delivered.size; }

  async getLocalManifest(): Promise<BeeManifest | null> { return this.manifest; }

  /** TTL freshness lookup. A fragment counts as "ours" once DELIVERED — a
   *  buffered-but-undelivered fragment must not look fresh, or a crash before
   *  flush would skip it for a whole TTL. */
  async get(id: string): Promise<Pick<FragmentV08, 'extracted_at'> | null> {
    const e = this.delivered.get(id);
    return e ? { extracted_at: e.extracted_at } : null;
  }

  async save(frag: FragmentV08): Promise<void> {
    await this.ready();
    this.buffer.push(frag);
    if (this.buffer.length >= this.maxBatch) await this.deliverBuffer();
  }

  /** Deliver everything still buffered. Called at the end of each cycle. */
  async flush(): Promise<void> {
    await this.ready();
    while (this.buffer.length > 0) await this.deliverBuffer();
  }

  private async deliverBuffer(): Promise<void> {
    const batch = this.buffer.slice(0, this.maxBatch);
    const body = gzipSync(Buffer.from(JSON.stringify({ bee_id: this.beeId, batch }), 'utf8'));

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(this.ingestUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.ok) {
          const out = await res.json().catch(() => ({})) as { upserted?: number; unchanged?: number };
          this.buffer = this.buffer.slice(batch.length);
          for (const f of batch) this.delivered.set(f.id, { extracted_at: f.extracted_at, content_hash: f.content_hash });
          await this.persistInventory();
          console.log(`[direct] delivered batch of ${batch.length} → upserted=${out.upserted ?? '?'} unchanged=${out.unchanged ?? '?'}`);
          return;
        }
        const detail = await res.text().catch(() => '');
        if (res.status >= 400 && res.status < 500) {
          // Deterministic rejection (token/allowlist/signature) — retrying is futile.
          this.buffer = this.buffer.slice(batch.length);   // don't wedge the pipeline behind a poisoned batch
          console.warn(`[direct] ingest REJECTED: bee_id=${this.beeId} size=${batch.length} status=${res.status} stage=deliver body=${detail.slice(0, 300)}`);
          throw new IngestRejectedError(res.status, `ingest rejected with ${res.status}: ${detail.slice(0, 300)}`);
        }
        lastErr = new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
      } catch (e) {
        if (e instanceof IngestRejectedError) throw e;
        lastErr = e;   // network / timeout / 5xx → retry
      }
      if (attempt < this.maxAttempts) {
        const backoff = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
        console.warn(`[direct] delivery attempt ${attempt}/${this.maxAttempts} failed (bee_id=${this.beeId}, size=${batch.length}, stage=deliver): ${(lastErr as any)?.message ?? lastErr} — retrying in ${Math.round(backoff)}ms`);
        await sleep(backoff);
      }
    }
    // Batch stays buffered: deterministic ids make the eventual re-delivery harmless.
    throw new Error(`direct delivery failed after ${this.maxAttempts} attempts (bee_id=${this.beeId}, size=${batch.length}): ${(lastErr as any)?.message ?? lastErr}`);
  }

  private async persistInventory(): Promise<void> {
    const out: InventoryFile = { delivered: Object.fromEntries(this.delivered) };
    try {
      await fs.writeFile(this.inventoryPath, JSON.stringify(out), 'utf8');
    } catch (e: any) {
      console.warn(`[direct] inventory persist failed (${this.inventoryPath}): ${e?.message ?? e}`);
    }
  }
}
