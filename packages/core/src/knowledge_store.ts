import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { join } from 'node:path';
import type { Fragment, FragmentId, FragmentInput, IKnowledgeGraph, QueryFilter } from './interfaces.js';
import { buildEmbedderPayload } from './interfaces.js';
import { hashPayload, signPayload, verifySignature, type NodeIdentity } from './node_identity.js';
import type { PeerRegistry } from './peer_registry.js';
import type { BeeManifest } from './bee_manifest.js';

const K = {
  frag: (id: string)                 => `frag:${id}`,
  src:  (source: string, id: string) => `src:${source}:${id}`,
  dat:  (date: string, id: string)   => `dat:${date}:${id}`,
  hist: (id: string, ts: string)     => `hist:${id}:${ts}`,
};

// Hypercore emits 'conflict' when disk state disagrees with a received proof
// (typically from an unclean shutdown / OOM kill). Log once per core then silence —
// the core remains readable, writes from before the crash may be absent.
function attachConflictHandler(core: any, label: string): void {
  let logged = false;
  core.on('conflict', () => {
    if (!logged) {
      const key = core.key?.toString('hex')?.slice(0, 16) ?? '?';
      console.warn(`[store] Hypercore conflict in ${label} core (${key}) — last write before crash may be missing. This is safe to ignore.`);
      logged = true;
    }
  });
}

export class KnowledgeStore implements IKnowledgeGraph {
  private store: Corestore;
  private core!: any;       // strong reference prevents GC from closing the Hypercore
  private bee!: Hyperbee;
  private identity: NodeIdentity;
  private _ready = false;
  // Serialize all Hyperbee writes to prevent concurrent flush conflicts
  private _writeQueue: Promise<void> = Promise.resolve();
  // Manifests received from remote peers (nodeId → manifest). Populated during
  // watchRemoteCore; read by /api/directory on the queen.
  private remoteManifests: Map<string, BeeManifest> = new Map();

  private _readyPromise: Promise<void> | null = null;

  constructor(dataDir: string, identity: NodeIdentity) {
    this.identity = identity;
    this.store = new Corestore(join(dataDir, 'corestore'));
  }

  get nodeId(): string { return this.identity.nodeId; }

  /** Public key of the local fragments Hypercore. Shared with peers so they can replicate it. */
  get coreKey(): Buffer { return this.core.key; }

  /**
   * The parent Corestore — passed to P2PNode for replication.
   * Replication uses a per-connection session so closing a connection
   * never affects the write session.
   */
  get corestore(): Corestore { return this.store; }

  async ready(): Promise<void> {
    if (this._ready) return;
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = (async () => {
      await this.store.ready();
      // Store the core as an instance field to prevent garbage collection.
      // A local variable would go out of scope after ready() returns and the GC
      // would close the Hypercore, causing SESSION_CLOSED on subsequent writes.
      this.core = this.store.get({ name: 'fragments' });
      await this.core.ready();
      attachConflictHandler(this.core, 'fragments');
      this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await this.bee.ready();
      this._ready = true;
    })();

    return this._readyPromise;
  }

  // ── Write helpers ───────────────────────────────────────────────────────────

  private buildFragment(
    input: FragmentInput,
    status: Fragment['status'] = 'current',
    supersedes: FragmentId[] = [],
    superseded_by: FragmentId | null = null,
  ): Fragment {
    const partial = { ...input, status, supersedes, superseded_by };
    const hash = hashPayload(partial);
    const signature = signPayload({ id: partial.id, hash }, this.identity.privateKeyHex);
    return { ...partial, hash, signature };
  }

  // ── IKnowledgeGraph ─────────────────────────────────────────────────────────

  private async ensureOpen(): Promise<void> {
    if (this.core?.closed) {
      console.warn('[store] Core was closed — reopening...');
      this.core = this.store.get({ name: 'fragments' });
      await this.withTimeout(this.core.ready(), 10_000, 'core.ready');
      this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await this.withTimeout(this.bee.ready(), 10_000, 'bee.ready');
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    this._writeQueue = this._writeQueue.then(() => fn().then(resolve, reject));
    return result;
  }

  async save(input: FragmentInput): Promise<Fragment> {
    await this.ready();
    const fragment = this.buildFragment(input);
    return this.enqueue(async () => {
      await this.ensureOpen();
      const b = this.bee.batch();
      // batch.put() is async in Hyperbee v2 — must be awaited or puts are lost
      await b.put(K.frag(fragment.id), fragment);
      await b.put(K.src(fragment.source, fragment.id), fragment.id);
      await b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
      await this.withTimeout(b.flush(), 8_000, 'save flush');
      return fragment;
    });
  }

  async saveReplicated(fragment: Fragment): Promise<void> {
    await this.ready();
    return this.enqueue(async () => {
      await this.ensureOpen();
      const b = this.bee.batch();
      await b.put(K.frag(fragment.id), fragment);
      await b.put(K.src(fragment.source, fragment.id), fragment.id);
      await b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
      await this.withTimeout(b.flush(), 8_000, 'saveReplicated flush');
    });
  }

  async get(id: FragmentId): Promise<Fragment | null> {
    await this.ready();
    const node = await this.bee.get(K.frag(id));
    return node ? (node.value as Fragment) : null;
  }

  async *query(filter: QueryFilter = {}): AsyncIterable<Fragment> {
    await this.ready();
    const prefix = filter.source ? K.src(filter.source, '') : 'frag:';
    let count = 0;
    const limit = filter.limit ?? Infinity;
    for await (const node of this.bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      if (count >= limit) break;
      let fragment: Fragment;
      if (filter.source) {
        const full = await this.get(node.value as string);
        if (!full) continue;
        fragment = full;
      } else {
        fragment = node.value as Fragment;
      }
      if (filter.status && fragment.status !== filter.status) continue;
      yield fragment;
      count++;
    }
  }

  async supersede(oldId: FragmentId, newInput: FragmentInput): Promise<Fragment> {
    await this.ready();
    const old = await this.get(oldId);
    if (!old) throw new Error(`Fragment ${oldId} not found`);
    const newFragment = this.buildFragment(newInput, 'current', [oldId], null);
    const updatedOld: Fragment = { ...old, status: 'superseded', superseded_by: newFragment.id };
    const oldHash = hashPayload({ ...updatedOld, hash: undefined, signature: undefined });
    const oldSig = signPayload({ id: updatedOld.id, hash: oldHash }, this.identity.privateKeyHex);
    const signedOld = { ...updatedOld, hash: oldHash, signature: oldSig };
    return this.enqueue(async () => {
      await this.ensureOpen();
      const b = this.bee.batch();
      await b.put(K.hist(oldId, old.extracted_at), signedOld);
      await b.put(K.frag(oldId), signedOld);
      await b.put(K.frag(newFragment.id), newFragment);
      await b.put(K.src(newFragment.source, newFragment.id), newFragment.id);
      await b.put(K.dat(newFragment.extracted_at.slice(0, 10), newFragment.id), newFragment.id);
      await this.withTimeout(b.flush(), 8_000, 'supersede flush');
      return newFragment;
    });
  }

  async history(id: FragmentId): Promise<Fragment[]> {
    await this.ready();
    const prefix = K.hist(id, '');
    const results: Fragment[] = [];
    for await (const node of this.bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      results.push(node.value as Fragment);
    }
    return results;
  }

  async verify(fragment: Fragment): Promise<boolean> {
    const { hash, signature, ...rest } = fragment;
    return hashPayload(rest) === hash &&
      verifySignature({ id: fragment.id, hash }, signature, this.identity.publicKeyHex);
  }

  // ── BeeManifest (v0.7.3) ───────────────────────────────────────────────────

  /** Publish this BEE's manifest to its own Hyperbee so peers can read it. */
  async publishManifest(manifest: BeeManifest): Promise<void> {
    await this.ready();
    return this.enqueue(async () => {
      await this.ensureOpen();
      await this.withTimeout(this.bee.put('bee:manifest', manifest), 5_000, 'publishManifest');
    });
  }

  /** Read back the manifest this BEE previously published (null if not yet published). */
  async getLocalManifest(): Promise<BeeManifest | null> {
    await this.ready();
    const node = await this.bee.get('bee:manifest');
    return node ? (node.value as BeeManifest) : null;
  }

  /** All manifests received from remote peers via watchRemoteCore. */
  getRemoteManifests(): ReadonlyMap<string, BeeManifest> {
    return this.remoteManifests;
  }

  /**
   * Stream all fragments from Hyperbee history (past + live) and POST each one
   * to the HNSW embedder. This replaces HTTP-based sync: Hypercore replication
   * delivers blocks to this BEE, the history stream picks them up, and HNSW
   * stays in sync automatically — no polling, no separate sync layer needed.
   *
   * Call once after ready(). Never resolves (live stream). Auto-restarts the
   * stream if it dies — previously a hyperbee internal error or session
   * close would tear down the for-await loop and silently stop indexing
   * until the bee was restarted.
   */
  async watchFragments(embedderUrl: string): Promise<void> {
    await this.ready();
    const seen = new Set<string>();

    const post = async (frag: Fragment) => {
      if (seen.has(frag.id)) return;
      try {
        await fetch(`${embedderUrl}/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: frag.id,
            text: frag.text,
            metadata: buildEmbedderPayload(frag),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        seen.add(frag.id);
      } catch { /* embedder offline — not marked seen, will retry on next appearance */ }
    };

    const runStreamOnce = async () => {
      // Dedicated session per attempt so a torn-down stream doesn't poison
      // the next retry's session state.
      const watchSession = this.store.session();
      const watchCore = watchSession.get({ name: 'fragments' });
      await watchCore.ready();
      const watchBee = new Hyperbee(watchCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await watchBee.ready();
      for await (const { key, value } of (watchBee as any).createHistoryStream({ live: true })) {
        if (typeof key === 'string' && key.startsWith('frag:') && value?.text) {
          await post(value as Fragment);
        }
      }
    };

    // Restart loop with bounded backoff. If the stream throws we wait and
    // re-open from scratch; `seen` is preserved across restarts so already-
    // indexed fragments are skipped immediately.
    let backoffMs = 1_000;
    while (true) {
      try {
        await runStreamOnce();
        backoffMs = 1_000;   // clean exit (unlikely with live:true) → reset
      } catch (err: any) {
        console.warn(`[watch] watchFragments stream died: ${err?.message ?? err} — restarting in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  /**
   * Watch a remote peer's fragments core (opened read-only by key) and POST
   * each fragment to HNSW. Called after key exchange with a peer.
   * `nodeId` is the HIVE app-level identity of the peer — used to store its
   * BeeManifest (v0.7.3) and as a label for conflict logs.
   * The optional `peerRegistry` enables full ed25519 verification — without
   * it we fall back to the v0.6.1.x hash-recompute check.
   */
  async watchRemoteCore(remoteCoreKey: Buffer, nodeId: string, embedderUrl: string, peerRegistry?: PeerRegistry): Promise<void> {
    await this.ready();
    const seen = new Set<string>();
    let droppedUnsigned = 0;
    let droppedBadSig = 0;
    let droppedUnknownPeer = 0;

    const runStreamOnce = async () => {
      // The core was already opened + download()-enabled in api_server.ts
      // before emitting peer-core. Getting it again is a no-op (Corestore
      // caches by key). Re-fetching on every restart picks up the latest
      // length naturally.
      const remoteCore = (this.store as any).get({ key: remoteCoreKey });
      await remoteCore.ready();
      attachConflictHandler(remoteCore, `remote-${nodeId.slice(0, 8)}`);
      remoteCore.download({ start: 0, end: -1 });
      console.log(`[repl] watchRemoteCore: key=${remoteCoreKey.toString('hex').slice(0, 16)} len=${remoteCore.length}`);
      const remoteBee = new Hyperbee(remoteCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await remoteBee.ready();
      // Read peer's BeeManifest (v0.7.3) — once per stream open is enough since
      // it's written at startup and practically never changes.
      try {
        const manifestNode = await remoteBee.get('bee:manifest');
        if (manifestNode?.value) {
          const m = manifestNode.value as BeeManifest;
          this.remoteManifests.set(nodeId, m);
          const srcs = m.declared_sources?.map((s: any) => s.id).join(', ') ?? '—';
          console.log(`[manifest] ${nodeId.slice(0, 16)} declared: ${srcs} (policy: ${m.declared_sources?.[0]?.policy ?? '?'})`);
        }
      } catch { /* manifest absent or unreadable — not fatal */ }
      await this._consumeRemoteStream(remoteBee, embedderUrl, seen, peerRegistry, {
        droppedUnsignedRef: () => droppedUnsigned, incUnsigned: () => droppedUnsigned++,
        droppedBadSigRef: () => droppedBadSig,    incBadSig:    () => droppedBadSig++,
        droppedUnknownPeerRef: () => droppedUnknownPeer, incUnknownPeer: () => droppedUnknownPeer++,
      });
    };

    let backoffMs = 1_000;
    while (true) {
      try {
        await runStreamOnce();
        backoffMs = 1_000;
      } catch (err: any) {
        console.warn(`[repl] watchRemoteCore stream died for ${nodeId.slice(0, 16)}: ${err?.message ?? err} — restarting in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  // Extracted so watchRemoteCore can wrap the for-await loop in a restartable
  // closure. Counters are passed via getter/incrementer pairs so the outer
  // scope keeps a stable running total across restarts.
  // v0.7.5.1 — buffered batch flush instead of per-fragment POST.
  //
  // The old serial loop was ~80 ms per fragment (HTTP + sentence-transformers
  // encode + Qdrant upsert) — about 750 frags/min. With v0.7.2.3's continuous
  // bee extraction producing faster than that, the queen fell permanently
  // behind: recently-indexed articles (SEMA, Chen Xi, Highway 209) sat in the
  // queen's local Hypercore replica but never reached Qdrant. /api/query
  // returned vector-similar neighbours and the LLM honestly reported "I
  // don't have that".
  //
  // The new design:
  //   1. Stream items into an in-memory buffer (FLUSH_SIZE = 50).
  //   2. Flush when the buffer fills OR every FLUSH_INTERVAL_MS.
  //   3. POST the whole batch to /add_batch. Embedder runs a single batch
  //      encode + single Qdrant upsert. ~25× throughput in practice.
  //
  // Signature verification stays per-fragment before items enter the buffer
  // so an invalid fragment never makes it into a batch. Items the embedder
  // rejects are reinstated at the head of the buffer; only after a 2xx
  // response do we mark `seen`. The finally block flushes the partial
  // buffer on stream end so we don't lose items at restart boundary.
  private async _consumeRemoteStream(
    remoteBee: any,
    embedderUrl: string,
    seen: Set<string>,
    peerRegistry: PeerRegistry | undefined,
    counters: {
      droppedUnsignedRef: () => number; incUnsigned: () => void;
      droppedBadSigRef: () => number;   incBadSig: () => void;
      droppedUnknownPeerRef: () => number; incUnknownPeer: () => void;
    },
  ): Promise<void> {
    type BatchItem = { id: string; text: string; metadata: ReturnType<typeof buildEmbedderPayload> };
    // v0.7.5.3 — FLUSH_SIZE 50 → 20.
    //
    // 50 was too aggressive on the Hetzner 4 GB box. Each batch of 50
    // pushed the embedder's working set up enough to lift queen memory
    // to ~2.15 GB and block /health responses on the GIL under load. 20
    // keeps the throughput speedup (~10×, not 25×) while leaving more
    // headroom for the api_server, Hypercore replication, and other
    // queen components on a memory-tight box.
    const FLUSH_SIZE = 20;
    const FLUSH_INTERVAL_MS = 500;

    let buffer: BatchItem[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushing = false;

    const doFlush = async () => {
      if (buffer.length === 0 || flushing) return;
      flushing = true;
      const batch = buffer;
      buffer = [];
      try {
        const res = await fetch(`${embedderUrl}/add_batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: batch }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          for (const it of batch) seen.add(it.id);
        } else {
          // Embedder rejected — reinstate so the next flush retries.
          buffer = [...batch, ...buffer];
        }
      } catch {
        // Embedder offline or timed out. Reinstate so we retry next flush.
        buffer = [...batch, ...buffer];
      } finally {
        flushing = false;
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        await doFlush();
      }, FLUSH_INTERVAL_MS);
    };

    try {
      for await (const { key, value } of remoteBee.createHistoryStream({ live: true })) {
        if (typeof key === 'string' && key.startsWith('frag:') && value?.text) {
          const frag = value as Fragment;
          if (seen.has(frag.id)) continue;

          // ── Signature verification (unchanged from pre-batching version) ──
          if (!frag.hash || !frag.signature) {
            counters.incUnsigned();
            const n = counters.droppedUnsignedRef();
            if (n <= 3 || n % 50 === 0) console.warn(`[repl] Dropping unsigned remote fragment ${frag.id} (count=${n})`);
            continue;
          }
          const { hash, signature, ...rest } = frag;
          const recomputed = hashPayload(rest);
          if (recomputed !== hash) {
            counters.incBadSig();
            const n = counters.droppedBadSigRef();
            if (n <= 3 || n % 50 === 0) console.warn(`[repl] Dropping tampered remote fragment ${frag.id} (count=${n})`);
            continue;
          }
          if (peerRegistry) {
            const pubkey = peerRegistry.pubkeyFor(frag.node_id);
            if (!pubkey) {
              counters.incUnknownPeer();
              const n = counters.droppedUnknownPeerRef();
              if (n <= 3 || n % 50 === 0) console.warn(`[repl] Dropping fragment ${frag.id} — no pubkey known for ${frag.node_id} (count=${n})`);
              continue;
            }
            if (!verifySignature({ id: frag.id, hash }, signature, pubkey)) {
              counters.incBadSig();
              const n = counters.droppedBadSigRef();
              if (n <= 3 || n % 50 === 0) console.warn(`[repl] Dropping fragment ${frag.id} — ed25519 signature does not verify against ${frag.node_id}'s key (count=${n})`);
              continue;
            }
          }

          // v0.7.5.2 — guard against malformed Hyperbee entries.
          // /add_batch was returning 422 "metadata: null" for a fraction of
          // batches on Hetzner. Root cause traced to fragments where
          // buildEmbedderPayload returns a partially-populated object
          // (some Hypercore entries from older bee versions lack fields
          // like status or extracted_at). Pydantic v2 on the embedder side
          // is strict — one bad item fails the whole batch.
          //
          // Defensive coercion: ensure id + text are strings and metadata
          // is an object before queuing. Items that don't qualify are
          // dropped quietly (we already verified the signature, so it's
          // not a security concern — just garbage we can't index).
          const metadata = buildEmbedderPayload(frag) || {};
          if (typeof frag.id !== 'string' || !frag.id ||
              typeof frag.text !== 'string' || !frag.text ||
              typeof metadata !== 'object' || metadata === null) {
            continue;
          }
          buffer.push({
            id: frag.id,
            text: frag.text,
            metadata,
          });

          if (buffer.length >= FLUSH_SIZE) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            await doFlush();
          } else {
            scheduleFlush();
          }
        }
      }
    } finally {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await doFlush();
    }
  }

  async close(): Promise<void> {
    await this.core?.close();
    await this.store.close();
  }
}
