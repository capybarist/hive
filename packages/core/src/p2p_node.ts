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
    private localCoreKey?: Buffer,   // public key of our local fragments Hypercore
    private localApiUrl?: string,    // HTTP API URL of this node, shared with peers for HTTP sync
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
      // Root cause of previous failures: Hypercore.createProtocolStream() (called
      // internally by store.replicate()) creates its OWN Protomux on the socket.
      // Creating a second Protomux via Protomux.from(socket) corrupts both.
      //
      // Fix: start store.replicate() first, then wait for the noise handshake
      // and add our key-exchange channel to CORESTORE'S internal Protomux
      // (stream.noiseStream.userData). No conflict, no corruption.
      //
      // Dynamic attachment: when we later call store.get({ key: theirCoreKey }),
      // Corestore's streamTracker.attachAll() auto-attaches it to all active
      // replication sessions — no manual wiring needed.
      const replStream = (this.store as any).replicate(socket);

      replStream.noiseStream.opened.then(() => {
        const mux: any = replStream.noiseStream.userData;
        const channel = mux.createChannel({ protocol: 'hive/core-keys/v1' });
        if (!channel) return; // mux closed already

        // msg[0]: 32-byte core public key (raw Buffer)
        // msg[1]: HTTP API URL of the sender (UTF-8 string) — used for HTTP sync fallback
        const keyMessage = channel.addMessage({ encoding: c.raw });
        const urlMessage = channel.addMessage({ encoding: c.string });

        keyMessage.onmessage = async (theirCoreKey: Buffer) => {
          try {
            const peerCore = (this.store as any).get({ key: theirCoreKey });
            await peerCore.ready();
            this.emit('peer-core', theirCoreKey, peerId);
            console.log(`[p2p] Got core key from ${peerId}: ${theirCoreKey.toString('hex').slice(0, 16)}... (len=${peerCore.length})`);
          } catch (e: any) {
            console.log(`[p2p] Could not open peer core: ${e.message}`);
          }
        };

        urlMessage.onmessage = (theirApiUrl: string) => {
          if (theirApiUrl) {
            console.log(`[p2p] Got API URL from ${peerId}: ${theirApiUrl}`);
            this.emit('peer-api', theirApiUrl, peerId);
          }
        };

        channel.open();
        if (this.localCoreKey) keyMessage.send(this.localCoreKey);
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
