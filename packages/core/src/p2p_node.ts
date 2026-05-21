import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import c from 'compact-encoding';
import type Corestore from 'corestore';

// All HIVE BEEs discover each other using this fixed topic
const HIVE_TOPIC = createHash('sha256').update('hive-network-v0.1').digest();

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

  constructor(
    private store: Corestore,
    private localMeta: PeerMeta,
  ) {
    super();
    this.swarm = new Hyperswarm();
  }

  get peers(): PeerInfo[] { return [...this._peers.values()]; }
  get peerCount(): number { return this._peers.size; }

  async start(): Promise<void> {
    this.swarm.join(HIVE_TOPIC, { server: true, client: true });

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
    console.log(`[p2p] Joined HIVE network — topic: ${HIVE_TOPIC.toString('hex').slice(0, 16)}...`);
  }

  async stop(): Promise<void> {
    await this.swarm.destroy();
  }
}
