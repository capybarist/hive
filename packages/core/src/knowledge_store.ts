import Autobase from 'autobase';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { join } from 'node:path';
import type { Fragment, FragmentId, FragmentInput, IKnowledgeGraph, QueryFilter } from './interfaces.js';
import { hashPayload, signPayload, verifySignature, type NodeIdentity } from './node_identity.js';

// Key prefixes for Hyperbee indexes
const K = {
  frag: (id: string) => `frag:${id}`,
  src: (source: string, id: string) => `src:${source}:${id}`,
  dat: (date: string, id: string) => `dat:${date}:${id}`,
  hist: (id: string, ts: string) => `hist:${id}:${ts}`,
};

type Op =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'del'; key: string };

async function applyOps(nodes: any[], view: Hyperbee, _base: any): Promise<void> {
  const b = view.batch();
  for (const node of nodes) {
    const op: Op = JSON.parse(node.value.toString());
    if (op.type === 'put') {
      await b.put(op.key, op.value);
    } else if (op.type === 'del') {
      await b.del(op.key);
    }
  }
  await b.flush();
}

export class KnowledgeStore implements IKnowledgeGraph {
  private store: Corestore;
  private base: any;
  private identity: NodeIdentity;
  private _ready = false;

  constructor(dataDir: string, identity: NodeIdentity) {
    this.identity = identity;
    this.store = new Corestore(join(dataDir, 'corestore'));
    this.base = new Autobase(this.store, null, {
      open: (store: any) =>
        new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
      apply: applyOps,
    });
  }

  async ready(): Promise<void> {
    if (this._ready) return;
    await this.base.ready();
    this._ready = true;
  }

  private get view(): Hyperbee {
    return this.base.view;
  }

  private async append(op: Op): Promise<void> {
    await this.base.append(JSON.stringify(op));
    await this.view.update();
  }

  private buildFragment(input: FragmentInput, status: 'current' | 'superseded' | 'historical' = 'current', supersedes: FragmentId[] = [], superseded_by: FragmentId | null = null): Fragment {
    const partial = { ...input, status, supersedes, superseded_by };
    const hash = hashPayload(partial);
    const signature = signPayload({ id: partial.id, hash }, this.identity.privateKeyHex);
    return { ...partial, hash, signature };
  }

  async save(input: FragmentInput): Promise<FragmentId> {
    await this.ready();
    const fragment = this.buildFragment(input);

    await this.append({ type: 'put', key: K.frag(fragment.id), value: fragment });
    await this.append({ type: 'put', key: K.src(fragment.source, fragment.id), value: fragment.id });
    await this.append({ type: 'put', key: K.dat(fragment.extracted_at.slice(0, 10), fragment.id), value: fragment.id });

    return fragment.id;
  }

  async get(id: FragmentId): Promise<Fragment | null> {
    await this.ready();
    await this.view.update();
    const node = await this.view.get(K.frag(id));
    return node ? (node.value as Fragment) : null;
  }

  async *query(filter: QueryFilter = {}): AsyncIterable<Fragment> {
    await this.ready();
    await this.view.update();

    const prefix = filter.source ? K.src(filter.source, '') : 'frag:';
    let count = 0;
    const limit = filter.limit ?? Infinity;

    for await (const node of this.view.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      if (count >= limit) break;

      let fragment: Fragment;
      if (filter.source) {
        // index node holds only the id; fetch the full fragment
        const id = node.value as string;
        const full = await this.get(id);
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

    // Mark old as superseded (archive current entry to history first)
    const updatedOld: Fragment = { ...old, status: 'superseded', superseded_by: newFragment.id };
    const oldHash = hashPayload({ ...updatedOld, hash: undefined, signature: undefined });
    const oldSig = signPayload({ id: updatedOld.id, hash: oldHash }, this.identity.privateKeyHex);
    const signedOld = { ...updatedOld, hash: oldHash, signature: oldSig };

    const histKey = K.hist(oldId, old.extracted_at);
    await this.append({ type: 'put', key: histKey, value: signedOld });
    await this.append({ type: 'put', key: K.frag(oldId), value: signedOld });

    // Save new fragment
    await this.append({ type: 'put', key: K.frag(newFragment.id), value: newFragment });
    await this.append({ type: 'put', key: K.src(newFragment.source, newFragment.id), value: newFragment.id });
    await this.append({ type: 'put', key: K.dat(newFragment.extracted_at.slice(0, 10), newFragment.id), value: newFragment.id });

    return newFragment.id;
  }

  async history(id: FragmentId): Promise<Fragment[]> {
    await this.ready();
    await this.view.update();
    const prefix = K.hist(id, '');
    const results: Fragment[] = [];
    for await (const node of this.view.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
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
    await this.base.close();
    await this.store.close();
  }
}
