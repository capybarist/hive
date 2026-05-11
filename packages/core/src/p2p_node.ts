import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import Protomux from 'protomux';
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
    private localCoreKey?: Buffer,   // public key of our local fragments Hypercore
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

      // ── Core-key exchange + Hypercore replication ──────────────────────────
      // Each BEE has its own Corestore with a unique 'fragments' core key.
      // Corestore only replicates cores that BOTH sides have open.
      // Solution: use a Protomux channel to exchange core keys before replication,
      // then open the peer's core locally so Corestore replication can deliver data.
      const mux = Protomux.from(socket) || new Protomux(socket);
      const channel = mux.createChannel({ protocol: 'hive/core-keys/v1' });
      const keyMessage = channel.addMessage({ encoding: c.raw });

      keyMessage.onmessage = async (theirCoreKey: Buffer) => {
        try {
          // Open peer's core read-only — Corestore replication will now sync it
          const peerCore = (this.store as any).get({ key: theirCoreKey });
          await peerCore.ready();
          this.emit('peer-core', theirCoreKey, peerId);
          console.log(`[p2p] Got core key from ${peerId}: ${theirCoreKey.toString('hex').slice(0, 16)}... (len=${peerCore.length})`);
        } catch (e: any) {
          console.log(`[p2p] Could not open peer core: ${e.message}`);
        }
      };

      channel.open();
      if (this.localCoreKey) {
        keyMessage.send(this.localCoreKey);
      }

      // Replication session over the same socket
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

    // Don't let flush() hang the node indefinitely
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
