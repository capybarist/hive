// HIVE v0.8 — KnowledgeStore.
// Holds the bee's signed v0.8 Hypercore (Hyperbee on top), and reads remote
// peer cores so the queen can pipe their already-signed, already-vectorized
// fragments into its in-process index (LanceDB).
//
// The v0.7 HTTP fan-out to a Python embedder is GONE in v0.8: the queen is
// in-process Node + LanceDB, so we just hand decoded fragments to a callback.
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type NodeIdentity } from './node_identity.js';
import { type FragmentV08 } from './schema_v08.js';
import { verifyFragmentV08 } from './fragment_v08.js';
import type { BeeManifest } from './bee_manifest.js';

const K = {
  frag: (id: string)                 => `frag:${id}`,
  src:  (source: string, id: string) => `src:${source}:${id}`,
  dat:  (date: string, id: string)   => `dat:${date}:${id}`,
};

export interface QueryFilter {
  source?: string;
  status?: FragmentV08['status'];
  limit?: number;
}

// Hypercore emits 'conflict' when disk state disagrees with a received proof
// (typically after an unclean shutdown). Log once per core then silence — the
// core remains readable, writes from before the crash may be absent.
function attachConflictHandler(core: any, label: string): void {
  let logged = false;
  core.on('conflict', () => {
    if (!logged) {
      const key = core.key?.toString('hex')?.slice(0, 16) ?? '?';
      console.warn(`[store] Hypercore conflict in ${label} core (${key}) — last write before crash may be missing. Safe to ignore.`);
      logged = true;
    }
  });
}

export class KnowledgeStore {
  private store: Corestore;
  private core!: any;
  private bee!: Hyperbee;
  private identity: NodeIdentity;
  private _ready = false;
  private _readyPromise: Promise<void> | null = null;
  // Serialize Hyperbee writes to prevent concurrent flush conflicts.
  private _writeQueue: Promise<void> = Promise.resolve();
  // Manifests received from remote peers (nodeId → manifest). Populated during
  // watchRemoteCoreV08; read by /api/directory on the queen.
  private remoteManifests: Map<string, BeeManifest> = new Map();
  // Cursor persistence + watcher deduplication (carried over from v0.7.6.4).
  // Without this every peer reconnect would spawn a fresh watcher loop
  // replaying the peer's core from offset 0 — OOM-killed prod at scale.
  private dataDir: string;
  private cursorDir: string;
  private activeWatchers: Set<string> = new Set();
  private cursorByNode: Map<string, number> = new Map();
  // v0.8.4 — fast in-memory count of locally-signed fragments. Surfaced via
  // /api/status so bee dashboards stop reading 0 (queen.indexed is the LanceDB
  // count, a different number that is always 0 on a producer). Initialised
  // from the Hyperbee at ready() and bumped on every successful save().
  private _localCount = 0;

  constructor(dataDir: string, identity: NodeIdentity) {
    this.identity = identity;
    this.dataDir = dataDir;
    this.cursorDir = join(dataDir, 'repl_cursors');
    this.store = new Corestore(join(dataDir, 'corestore'));
  }

  get nodeId(): string { return this.identity.nodeId; }
  /** Public key of the local fragments Hypercore. Shared with peers via PeerMeta. */
  get coreKey(): Buffer { return this.core.key; }
  /** The parent Corestore — passed to P2PNode for native replication. */
  get corestore(): Corestore { return this.store; }

  async ready(): Promise<void> {
    if (this._ready) return;
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = (async () => {
      await this.store.ready();
      this.core = this.store.get({ name: 'fragments' });
      await this.core.ready();
      attachConflictHandler(this.core, 'fragments');
      this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await this.bee.ready();
      await mkdir(this.cursorDir, { recursive: true });
      // Initial count of locally-signed fragments. Hyperbee doesn't expose a
      // cheap count(); the read-stream over the `frag:` prefix is bounded by
      // the local Hypercore size (no peer traffic) so it's fast on bee-scale
      // stores and runs once at startup.
      try {
        let n = 0;
        for await (const _ of this.bee.createReadStream({ gt: 'frag:', lt: 'frag:\xff' })) n++;
        this._localCount = n;
      } catch { /* count stays 0 — non-fatal */ }
      this._ready = true;
    })();

    return this._readyPromise;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

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

  // ── v0.8 fragment persistence ─────────────────────────────────────────────

  /**
   * Save a pre-built, pre-signed v0.8 fragment to the local Hyperbee. The bee
   * must construct the fragment upstream (chunk → embed → buildSignedFragmentV08)
   * because v0.8 puts the vector inside the signed hash. The store is just the
   * append-only durable layer.
   */
  async save(frag: FragmentV08): Promise<void> {
    await this.ready();
    return this.enqueue(async () => {
      await this.ensureOpen();
      // Detect existing-id overwrites so the counter stays accurate when the
      // agent re-saves a fragment that already lived in the Hyperbee.
      const wasNew = !(await this.bee.get(K.frag(frag.id)));
      const b = this.bee.batch();
      // batch.put() is async in Hyperbee v2 — must be awaited or puts are lost.
      await b.put(K.frag(frag.id), frag);
      await b.put(K.src(frag.source, frag.id), frag.id);
      await b.put(K.dat(frag.extracted_at.slice(0, 10), frag.id), frag.id);
      await this.withTimeout(b.flush(), 8_000, 'save flush');
      if (wasNew) this._localCount++;
    });
  }

  /** Fast count of locally-signed fragments (no peer traffic). v0.8.4+. */
  get localFragmentCount(): number { return this._localCount; }

  async get(id: string): Promise<FragmentV08 | null> {
    await this.ready();
    const node = await this.bee.get(K.frag(id));
    return node ? (node.value as FragmentV08) : null;
  }

  async *query(filter: QueryFilter = {}): AsyncIterable<FragmentV08> {
    await this.ready();
    const prefix = filter.source ? K.src(filter.source, '') : 'frag:';
    let count = 0;
    const limit = filter.limit ?? Infinity;
    for await (const node of this.bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      if (count >= limit) break;
      let fragment: FragmentV08;
      if (filter.source) {
        const full = await this.get(node.value as string);
        if (!full) continue;
        fragment = full;
      } else {
        fragment = node.value as FragmentV08;
      }
      if (filter.status && fragment.status !== filter.status) continue;
      yield fragment;
      count++;
    }
  }

  verify(fragment: FragmentV08): boolean {
    return verifyFragmentV08(fragment, fragment.node_pubkey);
  }

  // ── BeeManifest (v0.7.3, additive fields in v0.8) ─────────────────────────

  async publishManifest(manifest: BeeManifest): Promise<void> {
    await this.ready();
    return this.enqueue(async () => {
      await this.ensureOpen();
      await this.withTimeout(this.bee.put('bee:manifest', manifest), 5_000, 'publishManifest');
    });
  }

  async getLocalManifest(): Promise<BeeManifest | null> {
    await this.ready();
    const node = await this.bee.get('bee:manifest');
    return node ? (node.value as BeeManifest) : null;
  }

  getRemoteManifests(): ReadonlyMap<string, BeeManifest> {
    return this.remoteManifests;
  }

  // ── Cursor persistence (per remote nodeId) ────────────────────────────────
  // Resume each remote core's history stream from the last successfully
  // delivered Hyperbee block seq. Without this, every reconnect replays from
  // offset 0 — the dominant trigger of the v0.7 embedder OOM loop.

  private cursorFile(nodeId: string): string {
    const safe = nodeId.replace(/[^A-Za-z0-9_-]/g, '_');
    return join(this.cursorDir, `${safe}.json`);
  }

  private async loadCursor(nodeId: string): Promise<number> {
    const cached = this.cursorByNode.get(nodeId);
    if (cached !== undefined) return cached;
    try {
      const raw = await readFile(this.cursorFile(nodeId), 'utf-8');
      const parsed = JSON.parse(raw);
      const seq = typeof parsed?.lastSeq === 'number' && parsed.lastSeq >= 0 ? parsed.lastSeq : 0;
      this.cursorByNode.set(nodeId, seq);
      return seq;
    } catch {
      this.cursorByNode.set(nodeId, 0);
      return 0;
    }
  }

  private async saveCursor(nodeId: string, seq: number): Promise<void> {
    const prev = this.cursorByNode.get(nodeId) ?? 0;
    if (seq <= prev) return;
    this.cursorByNode.set(nodeId, seq);
    const file = this.cursorFile(nodeId);
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ lastSeq: seq }), 'utf-8');
      await rename(tmp, file);
    } catch (err: any) {
      console.warn(`[repl] Failed to persist cursor for ${nodeId.slice(0, 16)}: ${err?.message ?? err}`);
    }
  }

  // ── Remote core watcher (v0.8 — feeds the queen's LanceDB) ────────────────

  /**
   * Open a peer's fragments core (already opened+downloading via P2PNode),
   * read its 'bee:manifest' once, then stream v0.8 fragments to `onBatch` in
   * chunks of FLUSH_SIZE. Cursor advances only after onBatch resolves so a
   * crashing queen-side index doesn't lose its place.
   *
   * Single-watcher invariant per nodeId so peer-meta churn doesn't accumulate
   * concurrent loops (same v0.7.6.4 fix; just no HTTP fan-out now).
   */
  async watchRemoteCoreV08(
    remoteCoreKey: Buffer,
    nodeId: string,
    onBatch: (batch: FragmentV08[]) => Promise<void>,
  ): Promise<void> {
    await this.ready();
    if (this.activeWatchers.has(nodeId)) {
      console.log(`[repl] watchRemoteCoreV08 already active for ${nodeId.slice(0, 16)} — skipping duplicate`);
      return;
    }
    this.activeWatchers.add(nodeId);

    const initialSeq = await this.loadCursor(nodeId);
    if (initialSeq > 0) {
      console.log(`[repl] Resuming ${nodeId.slice(0, 16)} from seq=${initialSeq} (cursor persisted)`);
    }

    const FLUSH_SIZE = 20;
    const FLUSH_INTERVAL_MS = 500;

    const runStreamOnce = async () => {
      const remoteCore = (this.store as any).get({ key: remoteCoreKey });
      await remoteCore.ready();
      attachConflictHandler(remoteCore, `remote-${nodeId.slice(0, 8)}`);
      remoteCore.download({ start: 0, end: -1 });
      console.log(`[repl] watchRemoteCoreV08: key=${remoteCoreKey.toString('hex').slice(0, 16)} len=${remoteCore.length}`);

      const remoteBee = new Hyperbee(remoteCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await remoteBee.ready();

      // Read the peer's 'bee:manifest' — resiliently. The bee writes it first,
      // but right after the core opens our local view of its length is usually
      // still 0 (the peer's length handshake hasn't landed yet), so a one-shot
      // get returns null and /api/directory stays empty even though fragments
      // later stream fine (the v0.9 directory bug). Retry in the background,
      // syncing the length from the peer each time, until the manifest resolves.
      (async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            await remoteCore.update({ wait: true }).catch(() => {});
            if (remoteCore.length > 0) {
              const manifestNode = await remoteBee.get('bee:manifest');
              if (manifestNode?.value) {
                const m = manifestNode.value as BeeManifest;
                this.remoteManifests.set(nodeId, m);
                const srcs = m.declared_sources?.map((s: any) => s.id).join(', ') ?? '—';
                console.log(`[manifest] ${nodeId.slice(0, 16)} declared: ${srcs} (schema_v=${m.schema_version ?? '?'}, model=${m.embedding_model ?? '?'})`);
                return;
              }
            }
          } catch { /* keep retrying — manifest may not be replicated yet */ }
          await new Promise(r => setTimeout(r, 2_000));
        }
        console.warn(`[manifest] ${nodeId.slice(0, 16)} — no bee:manifest after retries; /api/directory will omit it`);
      })();

      let buffer: FragmentV08[] = [];
      let lastSeqInBuffer = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushing = false;

      const doFlush = async () => {
        if (buffer.length === 0 || flushing) return;
        flushing = true;
        const batch = buffer;
        const maxSeq = lastSeqInBuffer;
        buffer = [];
        lastSeqInBuffer = 0;
        try {
          await onBatch(batch);
          this.saveCursor(nodeId, maxSeq).catch(() => { /* logged inside */ });
        } catch (err: any) {
          console.warn(`[repl] onBatch failed for ${nodeId.slice(0, 16)} (${batch.length} frags): ${err?.message ?? err}`);
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

      const resumeFrom = this.cursorByNode.get(nodeId) ?? 0;
      if (resumeFrom > 0) {
        console.log(`[repl] Opening history stream for ${nodeId.slice(0, 16)} gt=${resumeFrom}`);
      }

      try {
        for await (const { key, value, seq } of (remoteBee as any).createHistoryStream({ gt: resumeFrom, live: true })) {
          if (typeof key !== 'string' || !key.startsWith('frag:')) continue;
          const frag = value as FragmentV08;
          if (!frag?.text || !frag.vector || !frag.id) continue;
          buffer.push(frag);
          lastSeqInBuffer = seq;
          if (buffer.length >= FLUSH_SIZE) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            await doFlush();
          } else {
            scheduleFlush();
          }
        }
      } finally {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        await doFlush();
      }
    };

    let backoffMs = 1_000;
    try {
      while (true) {
        try {
          await runStreamOnce();
          backoffMs = 1_000;
        } catch (err: any) {
          console.warn(`[repl] watchRemoteCoreV08 stream died for ${nodeId.slice(0, 16)}: ${err?.message ?? err} — restarting in ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    } finally {
      this.activeWatchers.delete(nodeId);
    }
  }

  /**
   * Local-core watcher used by `hive` mode (single-box bee+queen): stream
   * THIS node's own appended fragments to a callback so the in-process
   * QueenIndex can ingest them without a second round-trip through the
   * remote-core path. Identical batching semantics to watchRemoteCoreV08.
   */
  async watchLocalCoreV08(
    onBatch: (batch: FragmentV08[]) => Promise<void>,
  ): Promise<void> {
    await this.ready();
    const FLUSH_SIZE = 20;
    const FLUSH_INTERVAL_MS = 500;

    const runOnce = async () => {
      const session = this.store.session();
      const localCore = session.get({ name: 'fragments' });
      await localCore.ready();
      const localBee = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await localBee.ready();

      let buffer: FragmentV08[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushing = false;

      const doFlush = async () => {
        if (buffer.length === 0 || flushing) return;
        flushing = true;
        const batch = buffer;
        buffer = [];
        try { await onBatch(batch); }
        catch (err: any) {
          console.warn(`[local-watch] onBatch failed (${batch.length} frags): ${err?.message ?? err}`);
          buffer = [...batch, ...buffer];
        }
        finally { flushing = false; }
      };

      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(async () => { flushTimer = null; await doFlush(); }, FLUSH_INTERVAL_MS);
      };

      for await (const { key, value } of (localBee as any).createHistoryStream({ live: true })) {
        if (typeof key !== 'string' || !key.startsWith('frag:')) continue;
        const frag = value as FragmentV08;
        if (!frag?.text || !frag.vector || !frag.id) continue;
        buffer.push(frag);
        if (buffer.length >= FLUSH_SIZE) {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          await doFlush();
        } else {
          scheduleFlush();
        }
      }
    };

    let backoffMs = 1_000;
    while (true) {
      try { await runOnce(); backoffMs = 1_000; }
      catch (err: any) {
        console.warn(`[local-watch] stream died: ${err?.message ?? err} — restarting in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  async close(): Promise<void> {
    await this.core?.close();
    await this.store.close();
  }
}
