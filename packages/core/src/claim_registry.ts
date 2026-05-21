import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { join } from 'node:path';

const CLAIM_TTL_MS = 30 * 60 * 1000; // 30 min — BEE must renew or claim expires

export interface TopicClaim {
  topicId: string;
  beeId: string;
  claimedAt: string;
  renewedAt: string;
  fragmentCount: number;
  isPrimary: boolean; // primary extractor vs replica
}

export class ClaimRegistry {
  private store: Corestore;
  private ownsStore: boolean;
  private core!: any;
  private bee: Hyperbee | null = null;
  private _ready = false;
  private _readyPromise: Promise<void> | null = null;

  /**
   * @param dataDir          Used only if `sharedStore` is not provided.
   * @param sharedStore      Optional Corestore — when passed, claims live in
   *                         the same Corestore as fragments, which means
   *                         `store.replicate(socket)` already replicates
   *                         them and peers can open the `claims` core
   *                         read-only by key. This is the v0.6.3.4 path.
   *                         When omitted, the legacy isolated Corestore
   *                         at `${dataDir}/claim_registry/` is used.
   */
  constructor(dataDir: string, sharedStore?: Corestore) {
    if (sharedStore) {
      this.store = sharedStore;
      this.ownsStore = false;
    } else {
      this.store = new Corestore(join(dataDir, 'claim_registry'));
      this.ownsStore = true;
    }
  }

  /** Public key of the local claims Hypercore. Shared with peers so they can replicate it. */
  get coreKey(): Buffer | null { return this.core?.key ?? null; }

  async ready(): Promise<void> {
    if (this._ready) return;
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = (async () => {
      await this.store.ready();
      this.core = this.store.get({ name: 'claims' });
      await this.core.ready();
      this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await this.bee.ready();
      this._ready = true;
    })();

    return this._readyPromise;
  }

  /**
   * Open a peer's `claims` core read-only by key and stream it into our
   * own ClaimRegistry. Each remote claim row goes through `claim()` so
   * conflicts resolve via `renewedAt` (latest wins, same as local writes).
   * Restartable — if the stream dies (network drop, peer restart) we wait
   * and re-open.
   */
  async watchRemoteClaims(remoteCoreKey: Buffer): Promise<void> {
    await this.ready();
    const post = async (raw: TopicClaim) => {
      if (!raw?.topicId || !raw?.beeId) return;
      try { await this.claim(raw.topicId, raw.beeId, raw.fragmentCount ?? 0); } catch { /* concurrent put */ }
    };
    const runOnce = async () => {
      const remoteCore = (this.store as any).get({ key: remoteCoreKey });
      await remoteCore.ready();
      remoteCore.download({ start: 0, end: -1 });
      const remoteBee = new Hyperbee(remoteCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await remoteBee.ready();
      console.log(`[claims] watchRemoteClaims: key=${remoteCoreKey.toString('hex').slice(0, 16)} len=${remoteCore.length}`);
      for await (const { key, value } of remoteBee.createHistoryStream({ live: true })) {
        if (typeof key === 'string' && key.startsWith('claim:') && value) {
          await post(value as TopicClaim);
        }
      }
    };
    let backoffMs = 1_000;
    while (true) {
      try {
        await runOnce();
        backoffMs = 1_000;
      } catch (err: any) {
        console.warn(`[claims] watchRemoteClaims stream died: ${err?.message ?? err} — restarting in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.core?.closed) {
      this.core = this.store.get({ name: 'claims' });
      await this.core.ready();
      this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
      await this.bee.ready();
    }
  }

  async claim(topicId: string, beeId: string, fragmentCount = 0): Promise<void> {
    await this.ready();
    await this.ensureOpen();
    const existing = await this.getClaim(topicId, beeId);
    const entry: TopicClaim = {
      topicId,
      beeId,
      claimedAt: existing?.claimedAt ?? new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      fragmentCount,
      isPrimary: true,
    };
    await this.bee!.put(`claim:${topicId}:${beeId}`, entry);
  }

  async release(topicId: string, beeId: string): Promise<void> {
    await this.ready();
    await this.ensureOpen();
    await this.bee!.del(`claim:${topicId}:${beeId}`);
  }

  async getClaim(topicId: string, beeId: string): Promise<TopicClaim | null> {
    await this.ready();
    await this.ensureOpen();
    const node = await this.bee!.get(`claim:${topicId}:${beeId}`);
    return node ? (node.value as TopicClaim) : null;
  }

  async getClaimsForTopic(topicId: string): Promise<TopicClaim[]> {
    await this.ready();
    await this.ensureOpen();
    const prefix = `claim:${topicId}:`;
    const claims: TopicClaim[] = [];
    const now = Date.now();
    for await (const node of this.bee!.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      const claim = node.value as TopicClaim;
      const age = now - new Date(claim.renewedAt).getTime();
      if (age < CLAIM_TTL_MS) claims.push(claim);
    }
    return claims;
  }

  async getClaimsForBee(beeId: string): Promise<TopicClaim[]> {
    await this.ready();
    await this.ensureOpen();
    const claims: TopicClaim[] = [];
    const now = Date.now();
    for await (const node of this.bee!.createReadStream({ gt: 'claim:', lt: 'claim:\xff' })) {
      const claim = node.value as TopicClaim;
      if (claim.beeId === beeId) {
        const age = now - new Date(claim.renewedAt).getTime();
        if (age < CLAIM_TTL_MS) claims.push(claim);
      }
    }
    return claims;
  }

  /** Returns all active claims grouped by topicId → list of beeIds */
  async getAllActiveClaims(): Promise<Record<string, string[]>> {
    await this.ready();
    await this.ensureOpen();
    const result: Record<string, string[]> = {};
    const now = Date.now();
    for await (const node of this.bee!.createReadStream({ gt: 'claim:', lt: 'claim:\xff' })) {
      const claim = node.value as TopicClaim;
      const age = now - new Date(claim.renewedAt).getTime();
      if (age < CLAIM_TTL_MS) {
        if (!result[claim.topicId]) result[claim.topicId] = [];
        result[claim.topicId].push(claim.beeId);
      }
    }
    return result;
  }

  /**
   * Sweep claims whose `renewedAt` is older than CLAIM_TTL_MS and delete
   * the corresponding bee key. Returns the list of released claims so the
   * caller can log/alert. Safe to call on every cycle — only TTL-expired
   * rows are touched.
   */
  async releaseExpired(): Promise<TopicClaim[]> {
    await this.ready();
    await this.ensureOpen();
    const expired: TopicClaim[] = [];
    const now = Date.now();
    for await (const node of this.bee!.createReadStream({ gt: 'claim:', lt: 'claim:\xff' })) {
      const claim = node.value as TopicClaim;
      const age = now - new Date(claim.renewedAt).getTime();
      if (age >= CLAIM_TTL_MS) expired.push(claim);
    }
    for (const c of expired) {
      try { await this.bee!.del(`claim:${c.topicId}:${c.beeId}`); } catch { /* concurrent del */ }
    }
    if (expired.length > 0) {
      const sample = expired.slice(0, 5).map(c => `${c.topicId}@${c.beeId.slice(0, 12)}`).join(', ');
      console.warn(`[claims] Released ${expired.length} expired claim(s): ${sample}${expired.length > 5 ? ', …' : ''}`);
    }
    return expired;
  }

  async close(): Promise<void> {
    if (this.ownsStore) await this.store.close();
  }
}
