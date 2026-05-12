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

export class HiveP2PNode extends EventEmitter {
  private swarm: Hyperswarm;
  private _peers = new Map<string, PeerInfo>();

  constructor(
    private store: Corestore,
    private localApiUrl?: string,  // HTTP URL of this node — sent to peers for sync + core key discovery
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

      // ── Metadata exchange (HTTP URL only) ─────────────────────────────────
      // After the noise handshake, add a lightweight channel on CORESTORE'S mux
      // to exchange HTTP API URLs. Core key exchange intentionally moved to HTTP
      // (GET /api/status) to avoid any Protomux timing conflicts with replication.
      replStream.noiseStream.opened.then(() => {
        const mux: any = replStream.noiseStream.userData;
        const channel = mux.createChannel({ protocol: 'hive/meta/v1' });
        if (!channel) return;

        const urlMessage = channel.addMessage({ encoding: c.string });
        urlMessage.onmessage = (theirApiUrl: string) => {
          if (theirApiUrl) {
            console.log(`[p2p] Got API URL from ${peerId}: ${theirApiUrl}`);
            this.emit('peer-api', theirApiUrl, peerId);
          }
        };

        channel.open();
        if (this.localApiUrl) urlMessage.send(this.localApiUrl);
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
