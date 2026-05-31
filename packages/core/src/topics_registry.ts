import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';

/**
 * Public Topics Registry (v0.9, ROADMAP §3).
 *
 * A well-known public Hyperswarm topic where PUBLIC bees announce a small card
 * describing the specialised topic they feed (e.g. "python", "medicine"). Any
 * node can join to *browse* what public topics exist on the network and how many
 * bees cover each — without replicating anyone's content. A developer's queen
 * reads this list and picks which topics to actually subscribe to (default:
 * just the general one).
 *
 * Deliberately separate from `HiveP2PNode`: that one replicates Hypercores on
 * every connection. The registry must NOT — it's announce-only. So it runs its
 * own lightweight Hyperswarm and exchanges newline-delimited JSON cards on the
 * raw Noise stream (no corestore, no Protomux, no content replication).
 *
 * PRIVATE bees never join the registry → they stay invisible (their topic hex is
 * shared out-of-band). Queens join to collect; they don't announce a card.
 *
 * Scaling note: every participant connects to every other on the registry topic
 * (O(N²)). Fine for a young network; a gossip/sampling layer + per-pubkey
 * rate-limit + reputation is the documented mitigation for later.
 */
export const REGISTRY_TOPIC = createHash('sha256').update('hive-topics-registry-v1').digest();

/** A bee's self-description of the public topic it feeds. */
export interface TopicCard {
  topic_name: string;     // e.g. "python" (or "hive-network-v0.1" for general)
  topic_hex: string;      // sha256(topic_name) hex — how a queen subscribes
  adapter: string;        // primary source adapter (wikipedia-en, arxiv, rss, web, …)
  scope_summary?: string; // short human label of the scope (category, feeds, …)
  sample_url?: string;    // one representative URL, if any
  node_id: string;
  pubkey: string;         // ed25519 pubkey hex (signs the fragments)
  updated_at: string;     // ISO timestamp; cards older than CARD_TTL_MS are pruned
}

/** Aggregated view of one public topic across all announcing bees. */
export interface TopicSummary {
  topic_name: string;
  topic_hex: string;
  bee_count: number;
  adapters: string[];
  samples: string[];
}

const CARD_TTL_MS = 30 * 60_000;     // a card is stale after 30 min without refresh
const MAX_LINE_BYTES = 64 * 1024;    // guard against a peer flooding the line buffer

export class TopicsRegistry extends EventEmitter {
  private swarm: Hyperswarm;
  private cards = new Map<string, TopicCard>(); // node_id → card (others only)
  private myCard: TopicCard | null;
  private started = false;

  constructor(myCard: TopicCard | null = null) {
    super();
    this.myCard = myCard;
    this.swarm = new Hyperswarm();
  }

  /** Update (or clear) the card this node announces. Effective on next connect. */
  setCard(card: TopicCard | null): void { this.myCard = card; }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.swarm.on('connection', (conn: any) => {
      // Announce our card immediately (if we have one — queens don't).
      if (this.myCard) {
        try { conn.write(JSON.stringify({ ...this.myCard, updated_at: new Date().toISOString() }) + '\n'); }
        catch { /* peer may have already gone */ }
      }
      // Collect cards the peer sends. Newline-delimited JSON, one card per line.
      let buf = '';
      conn.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (buf.length > MAX_LINE_BYTES) { buf = ''; return; }
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const card = JSON.parse(line) as TopicCard;
            if (card?.topic_name && card?.node_id && card?.pubkey) {
              card.updated_at = card.updated_at || new Date().toISOString();
              this.cards.set(card.node_id, card);
              this.emit('card', card);
            }
          } catch { /* ignore malformed line */ }
        }
      });
      conn.on('error', () => {});
      conn.on('close', () => {});
    });

    this.swarm.join(REGISTRY_TOPIC, { server: true, client: true });
    await Promise.race([this.swarm.flush(), new Promise(r => setTimeout(r, 8_000))]);
  }

  /** Live cards (TTL-pruned), including our own so the local node sees itself. */
  private freshCards(): TopicCard[] {
    const now = Date.now();
    const out: TopicCard[] = [];
    for (const [id, c] of this.cards) {
      if (now - new Date(c.updated_at).getTime() > CARD_TTL_MS) { this.cards.delete(id); continue; }
      out.push(c);
    }
    if (this.myCard) out.push({ ...this.myCard });
    return out;
  }

  /** Public topics grouped by name, most-covered first. */
  get topics(): TopicSummary[] {
    const byName = new Map<string, TopicSummary>();
    for (const c of this.freshCards()) {
      let s = byName.get(c.topic_name);
      if (!s) {
        s = { topic_name: c.topic_name, topic_hex: c.topic_hex, bee_count: 0, adapters: [], samples: [] };
        byName.set(c.topic_name, s);
      }
      s.bee_count++;
      if (c.adapter && !s.adapters.includes(c.adapter)) s.adapters.push(c.adapter);
      if (c.sample_url && s.samples.length < 5 && !s.samples.includes(c.sample_url)) s.samples.push(c.sample_url);
    }
    return [...byName.values()].sort((a, b) => b.bee_count - a.bee_count);
  }

  get cardCount(): number { return this.cards.size; }

  async stop(): Promise<void> { await this.swarm.destroy(); }
}
