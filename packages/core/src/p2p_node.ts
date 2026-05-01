import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import type Corestore from 'corestore';

// All HIVE nodes discover each other using this fixed topic
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

  get peers(): PeerInfo[] {
    return [...this._peers.values()];
  }

  get peerCount(): number {
    return this._peers.size;
  }

  async start(): Promise<void> {
    this.swarm.join(HIVE_TOPIC, { server: true, client: true });

    this.swarm.on('connection', (socket: any, peerInfo: any) => {
      const peerId = (peerInfo.publicKey as Buffer).toString('hex').slice(0, 16);

      this._peers.set(peerId, {
        peerId,
        connectedAt: new Date().toISOString(),
      });

      // Native Hypercore P2P replication — socket.isInitiator is set by Hyperswarm
      (this.store as any).replicate(socket);

      this.emit('peer', peerId);
      console.log(`[p2p] Peer connected: ${peerId} (total: ${this._peers.size})`);

      socket.on('close', () => {
        this._peers.delete(peerId);
        this.emit('peer-left', peerId);
        console.log(`[p2p] Peer left: ${peerId}`);
      });

      socket.on('error', () => {});
    });

    await this.swarm.flush();
    console.log(`[p2p] Joined HIVE network — topic: ${HIVE_TOPIC.toString('hex').slice(0, 16)}...`);
  }

  async stop(): Promise<void> {
    await this.swarm.destroy();
  }
}
