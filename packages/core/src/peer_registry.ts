/**
 * PeerRegistry — in-memory `node_id → publicKeyHex` map populated from
 * `/api/status` during peer-API exchange.
 *
 * Each bee advertises its ed25519 public key alongside its core key. When
 * we receive a fragment claiming to be from `node_id=X`, we look up X's
 * known public key and verify the ed25519 signature against it. If we
 * don't know X yet, the fragment is dropped — better miss a few minutes
 * of replication after first contact than accept unsigned data.
 *
 * Why in-memory: the registry is rebuilt from `/api/status` on every
 * connect, so persisting it would just risk staleness (a bee rotates
 * keys → we'd still trust the old one). Hyperswarm reconnects refresh
 * the entries naturally.
 *
 * Why not Hypercore: the registry is a derived index of "who's online
 * right now and what's their key", not source-of-truth content. Same
 * argument as crawl_queue.
 */
export class PeerRegistry {
  private byNodeId = new Map<string, string>();   // node_id → pubkey hex
  private knownPubkeys = new Set<string>();        // pubkey hex set

  /**
   * Register a peer's identity. Idempotent — calling twice with the
   * same node_id/pubkey is a no-op. If a node_id is seen with a
   * DIFFERENT pubkey, that's a key rotation OR an impersonation; we
   * log and refuse to overwrite without an explicit `force`.
   */
  register(nodeId: string, publicKeyHex: string, force = false): boolean {
    if (!nodeId || !publicKeyHex) return false;
    const existing = this.byNodeId.get(nodeId);
    if (existing && existing !== publicKeyHex && !force) {
      console.warn(`[peer-registry] Refusing to overwrite ${nodeId} pubkey (existing=${existing.slice(0, 16)}, new=${publicKeyHex.slice(0, 16)}). Pass force=true to rotate.`);
      return false;
    }
    this.byNodeId.set(nodeId, publicKeyHex);
    this.knownPubkeys.add(publicKeyHex);
    return true;
  }

  /** Get the public key we've learned for a given node_id, or null. */
  pubkeyFor(nodeId: string): string | null {
    return this.byNodeId.get(nodeId) ?? null;
  }

  has(nodeId: string): boolean {
    return this.byNodeId.has(nodeId);
  }

  size(): number {
    return this.byNodeId.size;
  }

  entries(): Array<{ nodeId: string; publicKey: string }> {
    return [...this.byNodeId.entries()].map(([nodeId, publicKey]) => ({ nodeId, publicKey }));
  }
}
