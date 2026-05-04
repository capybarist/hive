/**
 * Objective Discovery — P2P topic self-assignment using the topic tree
 *
 * When a BEE starts with no HIVE_OBJECTIVE:
 * 1. Reads the topic_tree.json (the knowledge map)
 * 2. Checks the claim_registry (what's already covered by the network)
 * 3. Assigns uncovered/under-covered topics to this BEE
 * 4. Returns a concrete extraction objective
 */

import { ClaimRegistry, assignTopics, buildObjectiveFromTopics } from '@hive/core';

export async function discoverObjective(
  peerApis: string[],
  _apiKey: string,
  beeId: string,
  dataDir: string,
  capacity = 3,
  existingRegistry?: ClaimRegistry,  // reuse if already open
): Promise<string> {
  const ownRegistry = !existingRegistry;
  const registry = existingRegistry ?? new ClaimRegistry(dataDir);
  if (!existingRegistry) await registry.ready();

  try {
    // Sync remote claims from peers before assigning
    for (const peerUrl of peerApis) {
      try {
        const res = await fetch(`${peerUrl}/api/claims`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = (await res.json()) as { claims: Array<{ topicId: string; beeId: string; fragmentCount: number }> };
          for (const c of data.claims ?? []) {
            if (c.beeId !== beeId) {
              await registry.claim(c.topicId, c.beeId, c.fragmentCount);
            }
          }
        }
      } catch { /* peer offline */ }
    }

    const topics = await assignTopics(beeId, registry, capacity);
    if (!topics.length) return 'Find recent scientific content about artificial intelligence and machine learning';
    console.log(`[discovery] Assigned ${topics.length} topic(s): ${topics.map(t => t.id).join(', ')}`);
    return buildObjectiveFromTopics(topics);
  } finally {
    if (ownRegistry) await registry.close();
  }
}

export async function scanNetworkTopics(peerApis: string[]) {
  const results: Array<{ peerUrl: string; nodeId: string; titles: string[]; count: number }> = [];
  for (const url of peerApis) {
    try {
      const res = await fetch(`${url}/api/topics`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { nodes: Array<{ nodeId: string; titles: string[]; count: number }> };
      for (const node of data.nodes ?? []) results.push({ peerUrl: url, ...node });
    } catch {}
  }
  return results;
}
