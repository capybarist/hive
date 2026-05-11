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
  private core!: any;
  private bee: Hyperbee | null = null;
  private _ready = false;
  private _readyPromise: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.store = new Corestore(join(dataDir, 'claim_registry'));
  }

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

  async close(): Promise<void> {
    await this.store.close();
  }
}
