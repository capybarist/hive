import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';
import { KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, ClaimRegistry, SyncManager } from '@hive/core';
import { runAutonomousExtraction, discoverObjective } from '@hive/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

const PORT = Number(process.env.HIVE_PORT ?? 8080);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
const PEER_API = process.env.HIVE_PEER ?? '';   // kept for bootstrap announcements only
const HIVE_OBJECTIVE = process.env.HIVE_OBJECTIVE ?? '';
const HIVE_TOPIC_DOMAIN = process.env.BEE_TOPIC_DOMAIN ?? '';   // soft domain preference
const EXTRACT_INTERVAL_MS = Number(process.env.HIVE_EXTRACT_INTERVAL_MS ?? 30 * 60 * 1000);
const EXTRACT_MAX_FRAGMENTS = Number(process.env.HIVE_EXTRACT_MAX_FRAGMENTS ?? 10);

// ── Bootstrap node & P2P ────────────────────────────────────────────────────
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`\n🐝 HIVE node: ${identity.nodeId}`);
console.log(`   Data dir : ${DATA_DIR}`);

const knowledgeStore = new KnowledgeStore(DATA_DIR, identity);
await knowledgeStore.ready();
console.log(`   KnowledgeStore ready ✓`);

const embedderUrl = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Pass local core key so peers can open it for replication
const p2pNode = new HiveP2PNode(knowledgeStore.corestore, knowledgeStore.coreKey);
await p2pNode.start();

// Drive HNSW from local Hypercore history (past + live blocks)
knowledgeStore.watchFragments(embedderUrl).catch(console.error);
console.log(`   HNSW watch started ✓`);

// When a peer's core key arrives, watch that remote core for new fragments too
p2pNode.on('peer-core', (remoteCoreKey: Buffer) => {
  knowledgeStore.watchRemoteCore(remoteCoreKey, embedderUrl).catch(console.error);
});

// ── HTTP sync fallback ───────────────────────────────────────────────────────
// Hyperswarm DHT requires open UDP which may be blocked in some environments
// (e.g. Codespaces). SyncManager polls peer HTTP APIs as a reliable fallback
// so BEEs always share data even when native Hypercore replication can't connect.
const syncManager = PEER_API
  ? new SyncManager(knowledgeStore, identity.nodeId, [PEER_API], embedderUrl)
  : null;
if (syncManager) {
  syncManager.start();
  console.log(`   HTTP sync → ${PEER_API} ✓`);
}

// ── Fastify server ───────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(staticPlugin, { root: UI_DIR, prefix: '/' });

// ── POST /api/query ──────────────────────────────────────────────────────────
app.post<{ Body: { question: string; top_k?: number; use_llm?: boolean; history?: Array<{role: string; content: string}> } }>(
  '/api/query',
  async (req, reply) => {
    const { question, top_k = 5, use_llm = true, history = [] } = req.body;
    if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

    let { fragments, has_hive_data, embedder_online } = await queryByText(question, top_k);

    // Federated query: if local HNSW has no relevant data, ask peer BEEs.
    // This handles the case where extraction happened on a different node and
    // sync hasn't propagated yet (or Hyperswarm is unavailable).
    if (!has_hive_data && PEER_API) {
      try {
        const peerRes = await fetch(`${PEER_API}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, top_k, use_llm: false }),
          signal: AbortSignal.timeout(6_000),
        });
        if (peerRes.ok) {
          const peerData = (await peerRes.json()) as any;
          if (peerData.has_hive_data) {
            fragments = peerData.fragments ?? fragments;
            has_hive_data = true;
            console.log(`[federated] Got ${fragments.length} fragments from ${PEER_API}`);
          }
        }
      } catch { /* peer unreachable — fall through to hybrid mode */ }
    }

    if (!use_llm) return { fragments, has_hive_data, embedder_online, answer: null, mode: 'raw' };

    if (!GEMINI_KEY) {
      return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });
    }

    try {
      const { answer, mode } = await synthesize(question, fragments, GEMINI_KEY, has_hive_data, history);
      return { answer, mode, fragments, has_hive_data, embedder_online };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  },
);

// ── GET /api/fragments ───────────────────────────────────────────────────────
// Reads from the HNSW embedder (not Hypercore) — ensures fragments are
// available for sync even when Hypercore/Autobase writes fail.
app.get<{ Querystring: { limit?: string; offset?: string } }>(
  '/api/fragments',
  async (req) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    try {
      const res = await fetch(`${embedderUrl}/fragments?limit=1000`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { total: 0, offset, limit, fragments: [] };
      const data = (await res.json()) as { total: number; fragments: any[] };
      const page = (data.fragments ?? []).slice(offset, offset + limit);
      return { total: data.total, offset, limit, fragments: page };
    } catch {
      return { total: 0, offset, limit, fragments: [] };
    }
  },
);

// ── GET /api/node-info ───────────────────────────────────────────────────────
app.get('/api/node-info', async () => ({
  nodeId: identity.nodeId,
  port: PORT,
  apiUrl: `http://127.0.0.1:${PORT}`,
}));

// ── POST /api/register-peer ──────────────────────────────────────────────────
// Kept for claim-registry announcements. Data sync is now Hypercore-native.
app.post<{ Body: { apiUrl: string } }>('/api/register-peer', async (req) => {
  const { apiUrl } = req.body;
  if (!apiUrl) return { ok: false, error: 'apiUrl required' };
  console.log(`[p2p] Peer announced: ${apiUrl}`);
  return { ok: true, nodeId: identity.nodeId };
});

// ── GET /api/peers ───────────────────────────────────────────────────────────
app.get('/api/peers', async () => ({
  peers: p2pNode.peers,
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

// ── GET /api/claims ──────────────────────────────────────────────────────────
app.get('/api/claims', async () => {
  const active = await claimRegistry.getAllActiveClaims();
  const claims = [];
  for (const [topicId, beeIds] of Object.entries(active)) {
    for (const beeId of beeIds) {
      claims.push({ topicId, beeId, fragmentCount: 0 });
    }
  }
  return { claims };
});

// ── POST /api/claims ─────────────────────────────────────────────────────────
app.post<{ Body: { claims: Array<{ topicId: string; beeId: string; fragmentCount: number }> } }>(
  '/api/claims',
  async (req) => {
    const { claims } = req.body;
    if (Array.isArray(claims)) {
      for (const c of claims) {
        if (c.topicId && c.beeId) {
          await claimRegistry.claim(c.topicId, c.beeId, c.fragmentCount);
        }
      }
    }
    return { ok: true };
  }
);

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
    resolvedObjective = await discoverObjective(PEER_API ? [PEER_API] : [], GEMINI_KEY, identity.nodeId, DATA_DIR, 3, claimRegistry, HIVE_TOPIC_DOMAIN || undefined);
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
    
    const newClaims = [];
    for (const leaf of matched) {
      await claimRegistry.claim(leaf.id, identity.nodeId);
      newClaims.push({ topicId: leaf.id, beeId: identity.nodeId, fragmentCount: 0 });
    }
    
    // Broadcast our claims to the bootstrap peer so others can see them
    if (PEER_API && newClaims.length > 0) {
      try {
        await fetch(`${PEER_API}/api/claims`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims: newClaims }),
          signal: AbortSignal.timeout(3000)
        });
        logEvent('start', `Pushed ${newClaims.length} claims to bootstrap peer`);
      } catch (err: any) {
        logEvent('error', `Failed to push claims to bootstrap peer: ${err.message}`);
      }
    }
    
    if (matched.length) {
      logEvent('start', `Registered claims for ${matched.length} matching topics in knowledge tree`);
    }
  } catch { /* topic tree not available yet */ }
}

// ── Autonomous extraction loop (multi-topic) ─────────────────────────────────
if (resolvedObjective) {
  logEvent('start', `Autonomous mode active`);

  const MAX_TOPICS_PER_CYCLE = 5; // cap to keep cycles under ~10 min

  const runLoop = async () => {
    extracting = true;
    nextCycleAt = null;
    let totalIndexed = 0;
    let totalTokens = 0;

    try {
      let claims = await claimRegistry.getClaimsForBee(identity.nodeId);
      if (!claims.length) {
        claims = [{ topicId: 'default', beeId: identity.nodeId, claimedAt: '', renewedAt: '', fragmentCount: 0, isPrimary: true }];
      }

      // Cap topics per cycle so cycles don't run indefinitely
      const activeClaims = claims.slice(0, MAX_TOPICS_PER_CYCLE);
      const fragsPerTopic = Math.max(3, Math.floor(EXTRACT_MAX_FRAGMENTS / activeClaims.length));
      logEvent('start', `Starting cycle: ${activeClaims.length}/${claims.length} topics, ~${fragsPerTopic} frags each`);

      for (const claim of activeClaims) {
        let topicObjective = resolvedObjective;
        if (claim.topicId !== 'default') {
          try {
            const { loadTree, buildObjectiveFromTopics } = await import('@hive/core');
            const leaf = loadTree().find(t => t.id === claim.topicId);
            if (leaf) topicObjective = buildObjectiveFromTopics([leaf]);
          } catch { /* use resolved */ }
        }

        logEvent('start', `Topic: ${claim.topicId}`);
        const topicMaxMin = Math.ceil(8 / activeClaims.length);
        // Hard timeout: 2× budget + 2 min buffer for in-flight operations.
        // Guards against store.save() or b.flush() hanging beyond their own timeouts.
        const topicDeadlineMs = (topicMaxMin * 2 + 2) * 60_000;
        try {
          const result = await Promise.race([
            runAutonomousExtraction(
              topicObjective,
              { maxFragments: fragsPerTopic, maxMinutes: topicMaxMin },
              knowledgeStore,
              embedderUrl,
              (frag) => logEvent('fragment', `[${claim.topicId.split('/').pop()}] "${frag.title ?? frag.id}"`),
            ),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`topic deadline exceeded (${topicMaxMin * 2 + 2}min)`)), topicDeadlineMs)
            ),
          ]);
          totalIndexed += result.fragmentsIndexed;
          totalTokens += result.budget.tokensUsed;
          await claimRegistry.claim(claim.topicId, identity.nodeId, claim.fragmentCount + result.fragmentsIndexed);
        } catch (e: any) {
          logEvent('error', `Topic ${claim.topicId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      logEvent('error', `Cycle failed: ${e.message}`);
    } finally {
      // Always reset — never leave the spinner stuck
      extracting = false;
      nextCycleAt = Date.now() + EXTRACT_INTERVAL_MS;
      logEvent('done', `Cycle complete: ${totalIndexed} fragments | ${totalTokens} tokens`);
      logEvent('start', `Next cycle in ${Math.round(EXTRACT_INTERVAL_MS / 60_000)}min`);
      setTimeout(runLoop, EXTRACT_INTERVAL_MS);
    }
  };

  const initialJitter = 5_000 + Math.random() * 60_000;
  setTimeout(runLoop, initialJitter);
  nextCycleAt = Date.now() + initialJitter;
} else {
  logEvent('start', 'No HIVE_OBJECTIVE and no GEMINI_API_KEY — autonomous extraction disabled');
}

// ── GET /api/state — full BEE debug state ────────────────────────────────────
app.get('/api/state', async () => {
  const embedder = await getEmbedderStatus();
  const activeClaims = await claimRegistry.getAllActiveClaims();
  const myClaims = await claimRegistry.getClaimsForBee(identity.nodeId);
  return {
    nodeId: identity.nodeId,
    port: PORT,
    dataDir: DATA_DIR,
    objective: resolvedObjective,
    embedder: embedder ?? { status: 'offline' },
    peers: p2pNode.peers,
    myClaims: myClaims.map(c => ({ topicId: c.topicId, fragments: c.fragmentCount, renewed: c.renewedAt })),
    networkClaims: Object.fromEntries(
      Object.entries(activeClaims).map(([topic, bees]) => [topic, bees])
    ),
    extracting,
    nextCycleAt,
  };
});

// ── GET /api/activity ─────────────────────────────────────────────────────────
app.get('/api/activity', async () => ({
  events: [...activityLog].reverse(),
  extracting,
  nextCycleAt,
  objective: resolvedObjective || null,
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
