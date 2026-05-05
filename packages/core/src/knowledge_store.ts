import Hypercore from 'hypercore';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Fragment, FragmentId, FragmentInput, IKnowledgeGraph, QueryFilter } from './interfaces.js';
import { hashPayload, signPayload, verifySignature, type NodeIdentity } from './node_identity.js';

// Key prefixes for Hyperbee secondary indexes
const K = {
  frag: (id: string)                    => `frag:${id}`,
  src:  (source: string, id: string)    => `src:${source}:${id}`,
  dat:  (date: string, id: string)      => `dat:${date}:${id}`,
  hist: (id: string, ts: string)        => `hist:${id}:${ts}`,
};

export class KnowledgeStore implements IKnowledgeGraph {
  private store: Corestore;   // used only for P2P replication
  private core!: any;         // direct Hypercore, independent of Corestore sessions
  private bee!: Hyperbee;
  private identity: NodeIdentity;
  private _dataDir: string;
  private _ready = false;

  constructor(dataDir: string, identity: NodeIdentity) {
    this.identity = identity;
    this._dataDir = dataDir;
    this.store = new Corestore(join(dataDir, 'corestore'));
  }

  get nodeId(): string { return this.identity.nodeId; }
  get corestore(): Corestore { return this.store; }

  async ready(): Promise<void> {
    if (this._ready) return;
    await this.store.ready();

    // Use a direct Hypercore (bypassing Corestore) for all local writes.
    // This isolates write sessions from P2P replication session lifecycle:
    // when Hyperswarm closes a peer connection its replication session closes,
    // which can close Corestore-managed cores too. A standalone Hypercore
    // has no such dependency.
    const storageDir = join(this._dataDir, 'hypercore-fragments');
    mkdirSync(storageDir, { recursive: true });
    this.core = new Hypercore(storageDir);
    await this.core.ready();
    this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
    await this.bee.ready();
    this._ready = true;
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

  // ── IKnowledgeGraph implementation ─────────────────────────────────────────

  async save(input: FragmentInput): Promise<FragmentId> {
    await this.ready();
    const fragment = this.buildFragment(input);
    const b = this.bee.batch();
    await b.put(K.frag(fragment.id), fragment);
    await b.put(K.src(fragment.source, fragment.id), fragment.id);
    await b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
    await b.flush();
    return fragment.id;
  }

  async saveReplicated(fragment: Fragment): Promise<void> {
    await this.ready();
    const b = this.bee.batch();
    await b.put(K.frag(fragment.id), fragment);
    await b.put(K.src(fragment.source, fragment.id), fragment.id);
    await b.put(K.dat(fragment.extracted_at.slice(0, 10), fragment.id), fragment.id);
    await b.flush();
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

    const b = this.bee.batch();
    await b.put(K.hist(oldId, old.extracted_at), signedOld);
    await b.put(K.frag(oldId), signedOld);
    await b.put(K.frag(newFragment.id), newFragment);
    await b.put(K.src(newFragment.source, newFragment.id), newFragment.id);
    await b.put(K.dat(newFragment.extracted_at.slice(0, 10), newFragment.id), newFragment.id);
    await b.flush();
    return newFragment.id;
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
    const expectedHash = hashPayload(rest);
    if (expectedHash !== hash) return false;
    return verifySignature({ id: fragment.id, hash }, signature, this.identity.publicKeyHex);
  }

  async close(): Promise<void> {
    await this.bee?.close();
    await this.core?.close();
    await this.store.close();
  }
}
