import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';
import { KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, ClaimRegistry, SyncManager, isLLMConfigured, validateLLMKey } from '@hive/core';
import { runAutonomousExtraction, discoverObjective } from '@hive/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

const PORT = Number(process.env.HIVE_PORT ?? 8080);
const HIVE_MODE = (process.env.HIVE_MODE ?? 'bee') as 'bee' | 'aggregator';
const IS_AGGREGATOR = HIVE_MODE === 'aggregator';
const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
const PEER_API = process.env.HIVE_PEER ?? '';   // kept for bootstrap announcements only
const HIVE_OBJECTIVE = process.env.HIVE_OBJECTIVE ?? '';
const HIVE_TOPIC_DOMAIN = process.env.BEE_TOPIC_DOMAIN ?? '';   // soft domain preference
const EXTRACT_INTERVAL_MS = Number(process.env.HIVE_EXTRACT_INTERVAL_MS ?? 30 * 60 * 1000);
const EXTRACT_MAX_FRAGMENTS = Number(process.env.HIVE_EXTRACT_MAX_FRAGMENTS ?? 10);
const EXTRACT_BUDGET_MINUTES = Number(process.env.HIVE_EXTRACT_BUDGET_MINUTES ?? 8);

// ── Bootstrap node & P2P ────────────────────────────────────────────────────
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`\n🐝 HIVE node: ${identity.nodeId}`);
console.log(`   Data dir : ${DATA_DIR}`);

const knowledgeStore = new KnowledgeStore(DATA_DIR, identity);
await knowledgeStore.ready();
console.log(`   KnowledgeStore ready ✓`);

const embedderUrl = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// URL we advertise to peers so they can fetch our coreKey via HTTP and then
// start the native Hypercore replication. Defaults to loopback for shell
// development (single host). In Docker / cross-host setups you MUST set
// HIVE_API_URL to a value the peer can reach — e.g. `http://bee-1:8080` for
// docker-compose, or `https://hive.example.com` for public deployment.
// Wrong value here means peers receive a URL that resolves to nothing on
// their end → HTTP /api/status fails → coreKey never exchanged → native
// Hypercore replication never starts → fragments don't propagate.
const localApiUrl = process.env.HIVE_API_URL ?? `http://127.0.0.1:${PORT}`;
const p2pNode = new HiveP2PNode(knowledgeStore.corestore, localApiUrl);

// ── Register ALL p2p listeners BEFORE start() ────────────────────────────────
// Hyperswarm peers can connect and emit events during start()'s flush() window.
// Any listener registered after start() would miss those early events.

// When a peer's core key is known, start native Hypercore replication.
p2pNode.on('peer-core', (remoteCoreKey: Buffer) => {
  knowledgeStore.watchRemoteCore(remoteCoreKey, embedderUrl).catch(console.error);
});

// ── Peer discovery via P2P + native Hypercore replication ────────────────────
let syncManager: SyncManager | null = null;
if (PEER_API) {
  syncManager = new SyncManager(knowledgeStore, identity.nodeId, [PEER_API], embedderUrl);
  syncManager.start();
  console.log(`   HTTP sync → ${PEER_API} ✓`);
}

p2pNode.on('peer-api', async (peerApiUrl: string, peerId: string) => {
  // 1. HTTP sync fallback
  if (!syncManager) {
    syncManager = new SyncManager(knowledgeStore, identity.nodeId, [], embedderUrl);
    syncManager.start();
  }
  syncManager.addPeer(peerApiUrl);
  syncManager.syncOnce().catch(() => {});

  // 2. Native Hypercore replication: fetch core key via HTTP, then open + download
  try {
    const res = await fetch(`${peerApiUrl}/api/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return;
    const data = await res.json() as any;
    if (!data.coreKey) return;

    const remoteCoreKey = Buffer.from(data.coreKey, 'hex');
    const peerCore = (knowledgeStore.corestore as any).get({ key: remoteCoreKey });
    await peerCore.ready();
    peerCore.download({ start: 0, end: -1 });
    console.log(`[p2p] Core key fetched from ${peerApiUrl} — native replication started`);
    p2pNode.emit('peer-core', remoteCoreKey, peerId);
  } catch {
    // HTTP fetch failed — HTTP sync still works as fallback
  }
});

// Start P2P AFTER all listeners are registered so no early peer events are missed
await p2pNode.start();

// Drive local Hypercore → embedder (BEE mode only — aggregator has no local extraction)
if (!IS_AGGREGATOR) {
  knowledgeStore.watchFragments(embedderUrl).catch(console.error);
  console.log(`   Local watch started ✓`);
}

// ── Fastify server ───────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
});
await app.register(staticPlugin, { root: UI_DIR, prefix: '/' });

// ── POST /api/query ──────────────────────────────────────────────────────────
app.post<{ Body: { question: string; top_k?: number; use_llm?: boolean; history?: Array<{role: string; content: string}>; filters?: Record<string, unknown> } }>(
  '/api/query',
  async (req, reply) => {
    const { question, top_k = 5, use_llm = true, history = [], filters } = req.body;
    if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

    let { fragments, has_hive_data, embedder_online } = await queryByText(question, top_k, filters);

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

    if (!isLLMConfigured()) {
      return reply.code(503).send({ error: 'LLM not configured — set LLM_PROVIDER + LLM_API_KEY, or LLM_PROVIDER=ollama for local inference' });
    }

    try {
      const { answer, mode } = await synthesize(question, fragments, '', has_hive_data, history);
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
  apiUrl: localApiUrl,
}));

// ── POST /api/register-peer ──────────────────────────────────────────────────
// Peers call this on startup so the seed node learns about them and starts
// pulling their fragments. This makes the topology bidirectional:
// BEE-2 → syncs from BEE-1 (via PEER_API config)
// BEE-1 → syncs from BEE-2 (via this registration)
app.post<{ Body: { apiUrl: string } }>('/api/register-peer', async (req) => {
  const { apiUrl } = req.body;
  if (!apiUrl) return { ok: false, error: 'apiUrl required' };
  syncManager?.addPeer(apiUrl);
  syncManager?.syncOnce().catch(() => {});   // immediate pull
  console.log(`[sync] Peer registered: ${apiUrl}`);
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
    mode: HIVE_MODE,
    nodeId: identity.nodeId,
    nodeIdShort: identity.nodeId.slice(0, 20),
    embedder_online: embedder !== null,
    indexed: embedder?.indexed ?? 0,
    model: embedder?.model ?? null,
    backend: (embedder as any)?.backend ?? 'hnsw',
    llm_configured: isLLMConfigured(),
    llm_ok: llmHealthy,
    llm_provider: process.env.LLM_PROVIDER ?? 'gemini',
    peers: p2pNode.peerCount,
    coreKey: knowledgeStore.coreKey?.toString('hex') ?? null,
  };
});

// ── GET /api/crawl — Wikipedia forager state ─────────────────────────────────
// On a bee: reads the local persistent queue + visited files.
// On the aggregator: proxies to the peer bee (the aggregator itself doesn't
// crawl — it only ingests fragments via Hypercore replication). This lets
// the public dashboard query one URL regardless of where the crawler is.
app.get('/api/crawl', async () => {
  // Aggregator → proxy to peer bee
  if (HIVE_MODE === 'aggregator') {
    const peerUrl = process.env.HIVE_PEER ?? '';
    if (!peerUrl) {
      return { error: 'no peer configured', mode: HIVE_MODE };
    }
    try {
      const res = await fetch(`${peerUrl}/api/crawl`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { error: `peer ${res.status}`, mode: HIVE_MODE };
      const data = await res.json() as object;
      return { ...data, source_peer: peerUrl };
    } catch (e: any) {
      return { error: e.message, mode: HIVE_MODE };
    }
  }

  // Bee → read local queue files
  const { promises: fsP } = await import('node:fs');
  const queuePath = join(DATA_DIR, 'crawl_queue.jsonl');
  const visitedPath = join(DATA_DIR, 'crawl_visited.jsonl');
  async function lineCount(p: string): Promise<number> {
    try {
      const s = await fsP.readFile(p, 'utf8');
      return s.split('\n').filter(l => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }
  async function headLines(p: string, n: number): Promise<string[]> {
    try {
      const s = await fsP.readFile(p, 'utf8');
      return s.split('\n').filter(l => l.trim().length > 0).slice(0, n);
    } catch {
      return [];
    }
  }
  async function tailLines(p: string, n: number): Promise<string[]> {
    try {
      const s = await fsP.readFile(p, 'utf8');
      return s.split('\n').filter(l => l.trim().length > 0).slice(-n).reverse();
    } catch {
      return [];
    }
  }
  const [queueSize, visitedSize, nextInQueue, recentVisited] = await Promise.all([
    lineCount(queuePath),
    lineCount(visitedPath),
    headLines(queuePath, 10),    // queue is FIFO — first lines are next to process
    tailLines(visitedPath, 10),  // visited grows append — last lines are most recent
  ]);
  return {
    queue_size: queueSize,
    visited_size: visitedSize,
    next_in_queue: nextInQueue,
    recent_visited: recentVisited,
  };
});

// ── GET /api/stats — aggregator summary (fragment/BEE/topic counts) ──────────
app.get('/api/stats', async () => {
  try {
    const res = await fetch(`${embedderUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { error: 'embedder unavailable', mode: HIVE_MODE };
    return { mode: HIVE_MODE, ...(await res.json() as object) };
  } catch {
    return { error: 'stats unavailable', mode: HIVE_MODE };
  }
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

// ── Claim registry (both modes use it for network visibility) ────────────────
const claimRegistry = new ClaimRegistry(DATA_DIR);
await claimRegistry.ready();

// ── Aggregator mode: just index, never extract ────────────────────────────────
if (IS_AGGREGATOR) {
  logEvent('start', 'Aggregator mode active — indexing all peer fragments into Qdrant');
  logEvent('start', `Qdrant backend @ ${process.env.QDRANT_URL ?? 'http://localhost:6333'}`);
  logEvent('start', 'Waiting for BEEs to connect via Hyperswarm...');
}

// ── BEE mode: resolve objective and start extraction ─────────────────────────
let resolvedObjective = IS_AGGREGATOR ? '' : HIVE_OBJECTIVE;
if (!IS_AGGREGATOR && !resolvedObjective) {
  logEvent('start', 'No HIVE_OBJECTIVE — assigning topics from knowledge tree...');
  try {
    resolvedObjective = await discoverObjective(PEER_API ? [PEER_API] : [], '', identity.nodeId, DATA_DIR, 3, claimRegistry, HIVE_TOPIC_DOMAIN || undefined);
    logEvent('start', `Assigned objective: "${resolvedObjective}"`);
  } catch (e: any) {
    logEvent('error', `Topic assignment failed: ${e.message}`);
  }
}

// Register claims in the registry (BEE mode only)
if (!IS_AGGREGATOR && resolvedObjective) {
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

// ── LLM health tracking ───────────────────────────────────────────────────────
// null = not yet validated, true = last call succeeded, false = key error
let llmHealthy: boolean | null = null;

if (isLLMConfigured()) {
  validateLLMKey(process.env.LLM_PROVIDER ?? 'gemini', process.env.LLM_API_KEY ?? '')
    .then(err => { llmHealthy = err === null; })
    .catch(() => { llmHealthy = false; });
}

// ── Autonomous extraction loop (BEE mode only) ───────────────────────────────
let extractionLoopRunning = false;
const MAX_TOPICS_PER_CYCLE = 5;

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
        const topicMaxMin = Math.ceil(EXTRACT_BUDGET_MINUTES / activeClaims.length);
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
              (ok) => { llmHealthy = ok; },
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

async function startExtractionIfReady() {
  if (IS_AGGREGATOR) return; // aggregator never extracts — it only indexes peer fragments
  if (extractionLoopRunning) return;
  if (!isLLMConfigured()) {
    logEvent('start', 'LLM not configured — set LLM_PROVIDER + LLM_API_KEY to enable autonomous extraction.');
    return;
  }
  if (!resolvedObjective) {
    try {
      resolvedObjective = await discoverObjective(PEER_API ? [PEER_API] : [], '', identity.nodeId, DATA_DIR, 3, claimRegistry, HIVE_TOPIC_DOMAIN || undefined);
      logEvent('start', `Assigned objective: "${resolvedObjective}"`);
    } catch (e: any) {
      logEvent('error', `Topic assignment failed: ${e.message}`);
    }
  }
  if (!resolvedObjective) return;

  extractionLoopRunning = true;
  logEvent('start', 'Autonomous mode active');
  const delay = 2_000 + Math.random() * 8_000;
  setTimeout(runLoop, delay);
  nextCycleAt = Date.now() + delay;
}

if (!IS_AGGREGATOR) startExtractionIfReady();

// ── POST /api/config — set LLM provider + API key at runtime ─────────────────
function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content) ? content.replace(re, line) : (content + (content && !content.endsWith('\n') ? '\n' : '') + line + '\n');
}

app.post<{ Body: { provider: string; apiKey: string; model?: string } }>('/api/config', async (req, reply) => {
  const { provider, apiKey, model } = req.body ?? {};
  const VALID = ['gemini', 'claude', 'openai', 'groq', 'ollama'];
  if (!VALID.includes(provider)) return reply.code(400).send({ error: `Invalid provider. Valid: ${VALID.join(', ')}` });
  if (provider !== 'ollama' && !apiKey?.trim()) return reply.code(400).send({ error: 'apiKey is required' });

  // Validate key before saving — for ollama, validates that the server is reachable
  const validationError = await validateLLMKey(provider, provider === 'ollama' ? '' : apiKey.trim());
  if (validationError) return reply.code(400).send({ error: `Validation failed: ${validationError}` });

  process.env.LLM_PROVIDER = provider;
  if (provider !== 'ollama') process.env.LLM_API_KEY = apiKey.trim();
  if (model?.trim()) process.env.LLM_MODEL = model.trim();
  llmHealthy = true; // validation already passed above

  const envPath = resolve(join(__dirname, '../../../.env'));
  try {
    let content = '';
    try { content = await readFile(envPath, 'utf8'); } catch {}
    content = upsertEnvLine(content, 'LLM_PROVIDER', provider);
    content = upsertEnvLine(content, 'LLM_API_KEY', apiKey.trim());
    if (model?.trim()) content = upsertEnvLine(content, 'LLM_MODEL', model.trim());
    await writeFile(envPath, content, 'utf8');
  } catch { /* .env write failed — in-memory update still works for this session */ }

  await startExtractionIfReady();
  return { ok: true, provider };
});

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
  console.log(`\n   Mode → ${HIVE_MODE.toUpperCase()}`);
  console.log(`   API  → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   UI   → http://127.0.0.1:${PORT}/`);
  console.log(`   Peer → ${PEER_API || '(no bootstrap peer)'}`);
  if (!IS_AGGREGATOR) {
    const provider = process.env.LLM_PROVIDER ?? 'gemini';
    console.log(`   LLM  → ${provider} ${isLLMConfigured() ? '✓' : '(NOT SET)'}`);
  } else {
    console.log(`   Qdrant → ${process.env.QDRANT_URL ?? 'http://localhost:6333'}`);
  }
  console.log();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Announce ourselves to the bootstrap peer so it adds us to its SyncManager.
// This makes data flow bidirectionally: we pull from peer, peer pulls from us.
if (PEER_API) {
  fetch(`${PEER_API}/api/register-peer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl: localApiUrl }),
    signal: AbortSignal.timeout(5_000),
  })
    .then(r => { if (r.ok) console.log(`[sync] Announced to bootstrap peer ${PEER_API}`); })
    .catch(e => console.warn(`[sync] Could not announce to ${PEER_API}: ${e.message}`));
}
