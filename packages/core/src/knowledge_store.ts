import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { join } from 'node:path';
import type { Fragment, FragmentId, FragmentInput, IKnowledgeGraph, QueryFilter } from './interfaces.js';
import { hashPayload, signPayload, verifySignature, type NodeIdentity } from './node_identity.js';

const K = {
  frag: (id: string)                 => `frag:${id}`,
  src:  (source: string, id: string) => `src:${source}:${id}`,
  dat:  (date: string, id: string)   => `dat:${date}:${id}`,
  hist: (id: string, ts: string)     => `hist:${id}:${ts}`,
};

export class KnowledgeStore implements IKnowledgeGraph {
  private store: Corestore;
  private core!: any;       // strong reference prevents GC from closing the Hypercore
  private bee!: Hyperbee;
  private identity: NodeIdentity;
  private _ready = false;
  // Serialize all Hyperbee writes to prevent concurrent flush conflicts
  private _writeQueue: Promise<void> = Promise.resolve();

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

  async save(input: FragmentInput): Promise<FragmentId> {
    await this.ready();
    const fragment = this.buildFragment(input);
    return this.enqueue(async () => {
      await this.ensureOpen();
      const b = this.bee.batch();
      b.put(K.frag(fragment.id), fragment);
      b.put(K.src(fragment.source, fragment.id), fragment.id);
      b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
      await this.withTimeout(b.flush(), 8_000, 'save flush');
      return fragment.id;
    });
  }

  async saveReplicated(fragment: Fragment): Promise<void> {
    await this.ready();
    return this.enqueue(async () => {
      await this.ensureOpen();
      const b = this.bee.batch();
      b.put(K.frag(fragment.id), fragment);
      b.put(K.src(fragment.source, fragment.id), fragment.id);
      b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
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

  async supersede(oldId: FragmentId, newInput: FragmentInput): Promise<FragmentId> {
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
      b.put(K.hist(oldId, old.extracted_at), signedOld);
      b.put(K.frag(oldId), signedOld);
      b.put(K.frag(newFragment.id), newFragment);
      b.put(K.src(newFragment.source, newFragment.id), newFragment.id);
      b.put(K.dat(newFragment.extracted_at.slice(0, 10), newFragment.id), newFragment.id);
      await this.withTimeout(b.flush(), 8_000, 'supersede flush');
      return newFragment.id;
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

  /**
   * Stream all fragments from Hyperbee history (past + live) and POST each one
   * to the HNSW embedder. This replaces HTTP-based sync: Hypercore replication
   * delivers blocks to this BEE, the history stream picks them up, and HNSW
   * stays in sync automatically — no polling, no separate sync layer needed.
   *
   * Call once after ready(). Never resolves (live stream). Catches its own errors.
   */
  async watchFragments(embedderUrl: string): Promise<void> {
    await this.ready();
    
    // Create a dedicated session for watching to avoid contention with the main session
    const watchSession = this.store.session();
    const watchCore = watchSession.get({ name: 'fragments' });
    await watchCore.ready();
    const watchBee = new Hyperbee(watchCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
    await watchBee.ready();

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
            metadata: {
              source: frag.source,
              doi: frag.doi ?? null,
              doi_valid: frag.doi !== null,
              confidence: frag.confidence,
              node_id: frag.node_id,
              title: (frag as any).title ?? null,
              arxiv_id: (frag as any).arxiv_id ?? null,
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        seen.add(frag.id);
      } catch { /* embedder offline — not marked seen, will retry on next appearance */ }
    };

    // createHistoryStream({ live: true }) replays all past Hyperbee entries then
    // streams new ones indefinitely — covers both local writes and P2P-replicated blocks.
    for await (const { key, value } of (watchBee as any).createHistoryStream({ live: true })) {
      if (typeof key === 'string' && key.startsWith('frag:') && value?.text) {
        await post(value as Fragment);
      }
    }
  }

  /**
   * Watch a remote peer's fragments core (opened read-only by key) and POST
   * each fragment to HNSW. Called after key exchange with a peer.
   */
  async watchRemoteCore(remoteCoreKey: Buffer, embedderUrl: string): Promise<void> {
    await this.ready();
    // Open on the main store so it's included in the store.replicate() connection.
    const remoteCore = (this.store as any).get({ key: remoteCoreKey });
    await remoteCore.ready();

    // Pre-want all blocks so the replication protocol delivers them eagerly.
    remoteCore.download({ start: 0, end: -1 });
    console.log(`[repl] watchRemoteCore started: key=${remoteCoreKey.toString('hex').slice(0, 16)} len=${remoteCore.length}`);

    const remoteBee = new Hyperbee(remoteCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
    await remoteBee.ready();

    const seen = new Set<string>();
    for await (const { key, value } of remoteBee.createHistoryStream({ live: true })) {
      if (typeof key === 'string' && key.startsWith('frag:') && value?.text) {
        if (seen.has(value.id)) continue;
        try {
          await fetch(`${embedderUrl}/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: value.id,
              text: value.text,
              metadata: {
                source: value.source,
                doi: value.doi ?? null,
                doi_valid: value.doi !== null,
                confidence: value.confidence,
                node_id: value.node_id,
                title: value.title ?? null,
                arxiv_id: value.arxiv_id ?? null,
              },
            }),
            signal: AbortSignal.timeout(10_000),
          });
          seen.add(value.id);
        } catch { /* embedder offline — not marked seen, will retry on reconnect */ }
      }
    }
  }

  async close(): Promise<void> {
    await this.core?.close();
    await this.store.close();
  }
}
