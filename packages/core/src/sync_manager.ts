import type { KnowledgeStore } from './knowledge_store.js';
import type { Fragment } from './interfaces.js';

const SYNC_INTERVAL_MS = 8_000;

export class SyncManager {
  private syncedIds = new Set<string>();
  private intervalHandle?: ReturnType<typeof setInterval>;
  private peerApis: string[];
  private embedderUrl: string;

  constructor(
    private store: KnowledgeStore,
    private localNodeId: string,
    peerApis: string[] = [],
    embedderUrl = 'http://127.0.0.1:7700',
  ) {
    this.peerApis = [...peerApis];
    this.embedderUrl = embedderUrl;
  }

  addPeer(apiUrl: string): void {
    if (!this.peerApis.includes(apiUrl)) {
      this.peerApis.push(apiUrl);
      console.log(`[sync] Registered peer API: ${apiUrl}`);
    }
  }

  async syncOnce(): Promise<number> {
    let synced = 0;
    for (const peerUrl of this.peerApis) {
      try {
        const res = await fetch(`${peerUrl}/api/fragments?limit=1000`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) continue;

        const data = (await res.json()) as { fragments: any[]; total: number };
        const remote = data.fragments ?? [];

        for (const raw of remote) {
          if (!raw.id || !raw.text) continue;
          if (this.syncedIds.has(raw.id)) continue;
          if (raw.node_id === this.localNodeId) {
            this.syncedIds.add(raw.id);
            continue;
          }

          const existing = await this.store.get(raw.id);
          if (!existing) {
            await this.store.saveReplicated(raw as Fragment);
            synced++;
            console.log(`[sync] Replicated from ${raw.node_id?.slice(0, 16) ?? peerUrl}: ${raw.id}`);
          }
          // Always index to HNSW (remote fragments may be missing after restart)
          await this.addToHNSW(raw);
          this.syncedIds.add(raw.id);
        }
      } catch (err: any) {
        console.log(`[sync] Peer ${peerUrl} unreachable: ${err.message}`);
      }
    }
    if (synced > 0) console.log(`[sync] Synced ${synced} new fragments from peers`);
    return synced;
  }

  start(): void {
    // Initial sync immediately
    this.syncOnce().catch(() => {});
    this.intervalHandle = setInterval(() => this.syncOnce().catch(() => {}), SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async addToHNSW(frag: any): Promise<void> {
    if (!frag.text) return;
    try {
      await fetch(`${this.embedderUrl}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: frag.id,
          text: frag.text,
          metadata: {
            source: frag.source,
            doi: frag.doi ?? null,
            doi_valid: frag.doi_valid ?? frag.doi !== null,
            confidence: frag.confidence,
            node_id: frag.node_id,
            title: frag.title,
            arxiv_id: frag.arxiv_id,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }
}
