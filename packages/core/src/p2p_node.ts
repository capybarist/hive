import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
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

  constructor(private store: Corestore) {
    super();
    this.swarm = new Hyperswarm();
  }

  get peers(): PeerInfo[] { return [...this._peers.values()]; }
  get peerCount(): number { return this._peers.size; }

  async start(): Promise<void> {
    this.swarm.join(HIVE_TOPIC, { server: true, client: true });

    this.swarm.on('connection', (socket: any, peerInfo: any) => {
      const peerId = (peerInfo.publicKey as Buffer).toString('hex').slice(0, 16);

      // ── Hypercore native replication ───────────────────────────────────────
      // Each connection gets its OWN Corestore session so closing a peer
      // only closes that session — the write session in KnowledgeStore is unaffected.
      // Pass the socket (NoiseSecretStream) directly; Corestore reads socket.isInitiator
      // and handles piping internally.
      const replSession = (this.store as any).session();
      replSession.replicate(socket);

      socket.on('close', () => {
        replSession.close().catch(() => {});
        this._peers.delete(peerId);
        this.emit('peer-left', peerId);
        console.log(`[p2p] Peer left: ${peerId}`);
      });

      socket.on('error', () => {});

      this._peers.set(peerId, { peerId, connectedAt: new Date().toISOString() });
      this.emit('peer', peerId);
      console.log(`[p2p] Peer connected: ${peerId} (total: ${this._peers.size})`);
    });

    await this.swarm.flush();
    console.log(`[p2p] Joined HIVE network — topic: ${HIVE_TOPIC.toString('hex').slice(0, 16)}...`);
  }

  async stop(): Promise<void> {
    await this.swarm.destroy();
  }
}
