import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';
import { KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, SyncManager, ClaimRegistry } from '@hive/core';
import { runAutonomousExtraction, discoverObjective } from '@hive/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

const PORT = Number(process.env.HIVE_PORT ?? 8080);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
const PEER_API = process.env.HIVE_PEER ?? '';
const HIVE_OBJECTIVE = process.env.HIVE_OBJECTIVE ?? '';
const EXTRACT_INTERVAL_MS = Number(process.env.HIVE_EXTRACT_INTERVAL_MS ?? 30 * 60 * 1000); // 30min
const EXTRACT_MAX_FRAGMENTS = Number(process.env.HIVE_EXTRACT_MAX_FRAGMENTS ?? 10);

// ── Bootstrap node & P2P ────────────────────────────────────────────────────
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`\n🐝 H.I.V.E node: ${identity.nodeId}`);
console.log(`   Data dir : ${DATA_DIR}`);

const knowledgeStore = new KnowledgeStore(DATA_DIR, identity);
await knowledgeStore.ready();
console.log(`   KnowledgeStore ready ✓`);

const p2pNode = new HiveP2PNode(knowledgeStore.corestore);
await p2pNode.start();

const peerApis = PEER_API ? [PEER_API] : [];
const embedderUrl = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';
const syncManager = new SyncManager(knowledgeStore, identity.nodeId, peerApis, embedderUrl);
syncManager.start();

p2pNode.on('peer', () => {
  if (peerApis.length) syncManager.syncOnce().catch(() => {});
});

// Announce ourselves to known peers so they sync back (bidirectional)
const MY_API_URL = `http://127.0.0.1:${PORT}`;
for (const peerUrl of peerApis) {
  fetch(`${peerUrl}/api/register-peer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl: MY_API_URL }),
    signal: AbortSignal.timeout(5000),
  }).then(() => console.log(`[p2p] Announced to ${peerUrl}`))
    .catch(() => console.log(`[p2p] Could not announce to ${peerUrl} (offline?)`));
}

// ── Fastify server ───────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(staticPlugin, { root: UI_DIR, prefix: '/' });

// ── POST /api/query ──────────────────────────────────────────────────────────
app.post<{ Body: { question: string; top_k?: number; use_llm?: boolean } }>(
  '/api/query',
  async (req, reply) => {
    const { question, top_k = 5, use_llm = true } = req.body;
    if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

    const { fragments, has_hive_data, embedder_online } = await queryByText(question, top_k);

    if (!use_llm) return { fragments, has_hive_data, embedder_online, answer: null, mode: 'raw' };

    if (!GEMINI_KEY) {
      return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
    }

    try {
      const { answer, mode } = await synthesize(question, fragments, GEMINI_KEY, has_hive_data);
      return { answer, mode, fragments, has_hive_data, embedder_online };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  },
);

// ── GET /api/fragments ───────────────────────────────────────────────────────
app.get<{ Querystring: { limit?: string; offset?: string } }>(
  '/api/fragments',
  async (req) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    const all: any[] = [];
    for await (const f of knowledgeStore.query({ limit: 1000 })) {
      all.push(f);
    }
    const page = all.slice(offset, offset + limit);
    return { total: all.length, offset, limit, fragments: page };
  },
);

// ── GET /api/node-info ───────────────────────────────────────────────────────
app.get('/api/node-info', async () => ({
  nodeId: identity.nodeId,
  port: PORT,
  apiUrl: `http://127.0.0.1:${PORT}`,
}));

// ── POST /api/register-peer ──────────────────────────────────────────────────
// Remote node calls this to announce itself → triggers bidirectional sync
app.post<{ Body: { apiUrl: string } }>('/api/register-peer', async (req) => {
  const { apiUrl } = req.body;
  if (!apiUrl) return { ok: false, error: 'apiUrl required' };
  syncManager.addPeer(apiUrl);
  syncManager.syncOnce().catch(() => {});
  console.log(`[p2p] Peer registered via HTTP: ${apiUrl}`);
  return { ok: true, nodeId: identity.nodeId };
});

// ── GET /api/peers ───────────────────────────────────────────────────────────
app.get('/api/peers', async () => ({
  peers: p2pNode.peers,
  peerApis,
}));

// ── GET /api/topics ──────────────────────────────────────────────────────────
// Returns knowledge summary grouped by node_id — reads from HNSW (has titles)
app.get('/api/topics', async () => {
  const byNode: Record<string, { nodeId: string; titles: string[]; count: number }> = {};
  const seenTitles = new Set<string>();
  try {
    const res = await fetch(`${embedderUrl}/fragments?limit=1000`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { nodes: [] };
    const data = (await res.json()) as { fragments: any[] };
    for (const f of data.fragments ?? []) {
      const nid: string = f.node_id ?? 'unknown';
      if (!byNode[nid]) byNode[nid] = { nodeId: nid, titles: [], count: 0 };
      byNode[nid].count++;
      if (f.title && !seenTitles.has(f.title)) { seenTitles.add(f.title); byNode[nid].titles.push(f.title); }
    }
  } catch {}
  return { nodes: Object.values(byNode) };
});

// ── GET /api/status ──────────────────────────────────────────────────────────
app.get('/api/status', async () => {
  const embedder = await getEmbedderStatus();
  return {
    api: 'ok',
    nodeId: identity.nodeId,
    nodeIdShort: identity.nodeId.slice(0, 20),
    embedder_online: embedder !== null,
    indexed: embedder?.indexed ?? 0,
    model: embedder?.model ?? null,
    gemini_configured: Boolean(GEMINI_KEY),
    peers: p2pNode.peerCount,
  };
});

// ── Activity log (ring buffer) — must be declared before logEvent ────────────
interface ActivityEvent { ts: string; type: 'start'|'fragment'|'done'|'error'|'sync'; msg: string; }
const activityLog: ActivityEvent[] = [];
let nextCycleAt: number | null = null;
let extracting = false;

function logEvent(type: ActivityEvent['type'], msg: string) {
  const ev: ActivityEvent = { ts: new Date().toISOString(), type, msg };
  activityLog.push(ev);
  if (activityLog.length > 50) activityLog.shift();
  console.log(`[${type}] ${msg}`);
}

// ── Resolve objective (explicit config or auto-discovered from network) ───────
const claimRegistry = new ClaimRegistry(DATA_DIR);
await claimRegistry.ready();

let resolvedObjective = HIVE_OBJECTIVE;
if (!resolvedObjective && GEMINI_KEY) {
  logEvent('start', 'No HIVE_OBJECTIVE — assigning topics from knowledge tree...');
  try {
    resolvedObjective = await discoverObjective(peerApis, GEMINI_KEY, identity.nodeId, DATA_DIR, 3, claimRegistry);
    logEvent('start', `Assigned objective: "${resolvedObjective}"`);
  } catch (e: any) {
    logEvent('error', `Topic assignment failed: ${e.message}`);
  }
}

// Register claims in the registry (even for explicit objectives, claim matching topics)
if (resolvedObjective) {
  try {
    const { loadTree, assignTopics: _assign } = await import('@hive/core');
    const leaves = loadTree();
    const objLower = resolvedObjective.toLowerCase();
    // Find leaves whose keywords match the objective
    const matched = leaves.filter(leaf =>
      leaf.keywords.some(kw => objLower.includes(kw.toLowerCase())) ||
      objLower.includes(leaf.name_en.toLowerCase())
    ).slice(0, 5);
    for (const leaf of matched) {
      await claimRegistry.claim(leaf.id, identity.nodeId);
    }
    if (matched.length) {
      logEvent('start', `Registered claims for ${matched.length} matching topics in knowledge tree`);
    }
  } catch { /* topic tree not available yet */ }
}

// ── Autonomous extraction loop (multi-topic) ─────────────────────────────────
if (resolvedObjective) {
  logEvent('start', `Autonomous mode active`);

  const runLoop = async () => {
    extracting = true;
    nextCycleAt = null;

    // Get current claims for this BEE — may have grown since last cycle
    let claims = await claimRegistry.getClaimsForBee(identity.nodeId);
    if (!claims.length) {
      // Fallback: single topic from resolved objective
      claims = [{ topicId: 'default', beeId: identity.nodeId, claimedAt: '', renewedAt: '', fragmentCount: 0, isPrimary: true }];
    }

    const fragsPerTopic = Math.max(3, Math.floor(EXTRACT_MAX_FRAGMENTS / claims.length));
    let totalIndexed = 0;
    let totalTokens = 0;

    logEvent('start', `Starting cycle: ${claims.length} topic(s), ~${fragsPerTopic} fragments each`);

    for (const claim of claims) {
      // Build focused objective for this specific topic
      let topicObjective = resolvedObjective;
      if (claim.topicId !== 'default') {
        try {
          const { loadTree, buildObjectiveFromTopics } = await import('@hive/core');
          const leaf = loadTree().find(t => t.id === claim.topicId);
          if (leaf) topicObjective = buildObjectiveFromTopics([leaf]);
        } catch { /* tree unavailable, use resolved */ }
      }

      logEvent('start', `Topic: ${claim.topicId}`);
      try {
        const result = await runAutonomousExtraction(
          topicObjective,
          { maxFragments: fragsPerTopic, maxMinutes: Math.ceil(8 / claims.length) },
          knowledgeStore,
          embedderUrl,
          (frag) => logEvent('fragment', `[${claim.topicId.split('/').pop()}] "${frag.title ?? frag.id}"`),
        );
        totalIndexed += result.fragmentsIndexed;
        totalTokens += result.budget.tokensUsed;

        // Renew claim with updated fragment count
        await claimRegistry.claim(claim.topicId, identity.nodeId, claim.fragmentCount + result.fragmentsIndexed);
      } catch (e: any) {
        logEvent('error', `Topic ${claim.topicId}: ${e.message}`);
      }
    }

    logEvent('done', `Cycle complete: ${totalIndexed} fragments | ${totalTokens} tokens | ${claims.length} topics`);
    extracting = false;
    nextCycleAt = Date.now() + EXTRACT_INTERVAL_MS;
    logEvent('start', `Next cycle in ${Math.round(EXTRACT_INTERVAL_MS / 60_000)}min`);
    setTimeout(runLoop, EXTRACT_INTERVAL_MS);
  };

  setTimeout(runLoop, 10_000);
  nextCycleAt = Date.now() + 10_000;
} else {
  logEvent('start', 'No HIVE_OBJECTIVE and no GEMINI_API_KEY — autonomous extraction disabled');
}

// ── GET /api/claims ───────────────────────────────────────────────────────────
app.get('/api/claims', async () => {
  const active = await claimRegistry.getAllActiveClaims();
  const claims = Object.entries(active).flatMap(([topicId, beeIds]) =>
    beeIds.map(beeId => ({ topicId, beeId, fragmentCount: 0 }))
  );
  return { claims, nodeId: identity.nodeId };
});

// ── GET /api/activity ─────────────────────────────────────────────────────────
app.get('/api/activity', async () => ({
  events: [...activityLog].reverse(),
  extracting,
  nextCycleAt,
  objective: HIVE_OBJECTIVE || null,
}));

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n   API  → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   UI   → http://127.0.0.1:${PORT}/`);
  console.log(`   Peer → ${PEER_API || '(no bootstrap peer)'}`);
  console.log(`   Gemini → ${GEMINI_KEY ? 'configured ✓' : 'NOT SET'}\n`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
