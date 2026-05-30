import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import c from 'compact-encoding';
import type Corestore from 'corestore';

/** Well-known public swarm: sha256("hive-network-v0.1"). Used as the default topic. */
export const PUBLIC_TOPIC = createHash('sha256').update('hive-network-v0.1').digest();

/** Derive a Hyperswarm topic from a human-readable string. */
export function topicFromString(s: string) {
  return createHash('sha256').update(s).digest();
}

/** Parse a 64-char hex topic string into a Buffer. Returns null on invalid input. */
export function topicFromHex(hex: string) {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  return Buffer.from(clean, 'hex');
}

export interface PeerInfo {
  peerId: string;
  connectedAt: string;
}

/**
 * Self-description sent over the Protomux meta channel on every new
 * Hyperswarm connection. From v0.6.4 onwards this is the ONLY bootstrap
 * channel between nodes — there is no longer an HTTP round-trip for
 * coreKey / publicKey / nodeId. Anything HTTP between bees has been
 * removed.
 */
export interface PeerMeta {
  nodeId: string;
  publicKey: string;       // ed25519 pubkey hex
  coreKey: string;         // hex of fragments Hypercore key
  claimsCoreKey: string;   // hex of claims Hypercore key
}

// JSON-over-c.string encoding for the meta payload. We considered a
// custom compact-encoding schema but the payload is tiny (~200 bytes)
// and sent exactly once per connection, so the simplicity of JSON beats
// the byte savings.
//
// The decode is wrapped in try/catch so a malformed payload from any
// peer (mid-rollout incompatibility, malicious node, corrupted frame)
// can never crash the bee. We log once and skip — Protomux will
// continue delivering the next message normally.
const metaEncoding = {
  preencode(state: any, m: PeerMeta) { c.string.preencode(state, JSON.stringify(m)); },
  encode(state: any, m: PeerMeta) { c.string.encode(state, JSON.stringify(m)); },
  decode(state: any): PeerMeta | null {
    const raw = c.string.decode(state);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as PeerMeta;
      return null;
    } catch {
      console.warn(`[p2p] Ignoring non-JSON meta payload (likely a pre-v0.6.4 peer): ${raw.slice(0, 60)}`);
      return null;
    }
  },
};

export class HiveP2PNode extends EventEmitter {
  private swarm: Hyperswarm;
  private _peers = new Map<string, PeerInfo>();
  private discoveries: any[] = [];
  private _topics: Buffer[];

  constructor(
    private store: Corestore,
    private localMeta: PeerMeta,
    topics: Buffer[] = [PUBLIC_TOPIC],
  ) {
    super();
    this.swarm = new Hyperswarm();
    this._topics = topics;
  }

  get peers(): PeerInfo[] { return [...this._peers.values()]; }
  get peerCount(): number { return this._peers.size; }

  /** Re-announce + re-lookup on all joined topics. */
  async rejoin(): Promise<void> {
    for (const d of this.discoveries) {
      try { await d.refresh({ server: true, client: true }); }
      catch { /* refresh may throw on tear-down */ }
    }
  }

  /** Join an additional topic at runtime (e.g. queen adding a private bee's topic). */
  async addTopic(topic: Buffer): Promise<void> {
    const d = this.swarm.join(topic, { server: true, client: true });
    this.discoveries.push(d);
    this._topics.push(topic);
    await d.flushed().catch(() => {});
    console.log(`[p2p] Joined additional topic: ${topic.toString('hex').slice(0, 16)}...`);
  }

  async start(): Promise<void> {
    for (const topic of this._topics) {
      this.discoveries.push(this.swarm.join(topic, { server: true, client: true }));
    }

    this.swarm.on('connection', (socket: any, peerInfo: any) => {
      const peerId = (peerInfo.publicKey as Buffer).toString('hex').slice(0, 16);

      // ── Hypercore replication ──────────────────────────────────────────────
      // store.replicate() creates its own Protomux internally (noiseStream.userData).
      // We must NOT create a second Protomux on the same socket — that corrupts
      // both protocols. All custom channels must use replStream.noiseStream.userData.
      const replStream = (this.store as any).replicate(socket);

      // ── Meta exchange (v0.6.4) ────────────────────────────────────────────
      // After the noise handshake, add a lightweight channel on CORESTORE'S
      // mux to exchange our self-description: pubkey + coreKey + claimsCoreKey
      // + nodeId. Previously this was done via HTTP `/api/status` after the
      // peer announced its API URL — that HTTP round-trip is gone since v0.6.4.
      replStream.noiseStream.opened.then(() => {
        const mux: any = replStream.noiseStream.userData;
        // Protocol version bumped to v2 in v0.6.4.1. Pre-v0.6.4 nodes
        // open `hive/meta/v1` and never see our channel; we never see
        // theirs. The wire-format break is therefore isolated to nodes
        // running the new protocol and never crashes either side.
        const channel = mux.createChannel({ protocol: 'hive/meta/v2' });
        if (!channel) return;

        const metaMessage = channel.addMessage({ encoding: metaEncoding });
        metaMessage.onmessage = (theirMeta: PeerMeta | null) => {
          if (!theirMeta) return; // decoder already logged the reason
          if (theirMeta?.nodeId && theirMeta?.publicKey && theirMeta?.coreKey) {
            console.log(`[p2p] Got meta from ${peerId}: node=${theirMeta.nodeId.slice(0, 16)} core=${theirMeta.coreKey.slice(0, 16)}`);
            this.emit('peer-meta', theirMeta, peerId);
          } else {
            console.warn(`[p2p] Ignoring malformed meta from ${peerId}: missing fields`);
          }
        };

        channel.open();
        metaMessage.send(this.localMeta);
      }).catch(() => {});

      socket.on('close', () => {
        replStream.destroy?.();
        this._peers.delete(peerId);
        this.emit('peer-left', peerId);
        console.log(`[p2p] Peer left: ${peerId}`);
      });

      socket.on('error', () => {});

      this._peers.set(peerId, { peerId, connectedAt: new Date().toISOString() });
      this.emit('peer', peerId);
      console.log(`[p2p] Peer connected: ${peerId} (total: ${this._peers.size})`);
    });

    await Promise.race([
      this.swarm.flush(),
      new Promise(r => setTimeout(r, 10_000))
    ]);
    console.log(`[p2p] Joined HIVE network — ${this._topics.length} topic(s): ${this._topics.map(t => t.toString('hex').slice(0, 12)).join(', ')}...`);
  }

  async stop(): Promise<void> {
    await this.swarm.destroy();
  }
}
