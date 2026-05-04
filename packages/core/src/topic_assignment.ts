import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaimRegistry } from './claim_registry.js';

interface TopicNode {
  id: string;
  name: string;
  name_en: string;
  description: string;
  keywords: string[];
}

interface Field {
  id: string;
  topics: TopicNode[];
}

interface Domain {
  id: string;
  fields: Field[];
}

interface TopicTree {
  domains: Domain[];
}

function loadTree(): TopicNode[] {
  // Try a few candidate paths for topic_tree.json
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(__dirname, '../../../data/topic_tree.json'),
    resolve(process.env.HIVE_DATA_DIR ?? '', '../topic_tree.json'),
    resolve(process.cwd(), 'data/topic_tree.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const tree: TopicTree = JSON.parse(readFileSync(p, 'utf-8'));
      return tree.domains.flatMap(d => d.fields.flatMap(f => f.topics));
    }
  }
  throw new Error('topic_tree.json not found. Expected at data/topic_tree.json');
}

/**
 * Assigns N topic leaves to a BEE, prioritising:
 * 1. Unclaimed topics (nobody covers them)
 * 2. Under-covered topics (only 1 extractor)
 * 3. Topics matching the BEE's existing content (semantic affinity — simplified: keyword match)
 */
export async function assignTopics(
  beeId: string,
  registry: ClaimRegistry,
  capacity = 3,
): Promise<TopicNode[]> {
  const allLeaves = loadTree();
  const activeClaims = await registry.getAllActiveClaims();
  const myCurrentClaims = new Set(
    (await registry.getClaimsForBee(beeId)).map(c => c.topicId)
  );

  // Score each leaf:
  // - unclaimed = highest priority (score 100)
  // - claimed by 1 BEE (not us) = medium priority (score 50)
  // - already claimed by us = keep it (score 10, fills remaining capacity)
  // - claimed by 2+ BEEs = lowest priority (score 1)
  const scored = allLeaves.map(leaf => {
    const claimants = activeClaims[leaf.id] ?? [];
    const coveredByUs = myCurrentClaims.has(leaf.id);
    let score: number;
    if (claimants.length === 0) score = 100;
    else if (coveredByUs) score = 10;
    else if (claimants.length === 1) score = 50;
    else score = Math.max(1, 10 - claimants.length);
    return { leaf, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const assigned = scored.slice(0, capacity).map(s => s.leaf);

  // Register claims in the registry
  for (const topic of assigned) {
    await registry.claim(topic.id, beeId);
  }

  return assigned;
}

export function buildObjectiveFromTopics(topics: TopicNode[]): string {
  if (topics.length === 0) return '';
  if (topics.length === 1) {
    const t = topics[0];
    return `Find recent content about "${t.name_en}" (${t.description}). Keywords: ${t.keywords.slice(0, 5).join(', ')}.`;
  }
  const names = topics.map(t => t.name_en).join(', ');
  const allKeywords = [...new Set(topics.flatMap(t => t.keywords))].slice(0, 10);
  return `Find recent content covering these topics: ${names}. Focus on: ${allKeywords.join(', ')}.`;
}

export { loadTree };
export type { TopicNode };
