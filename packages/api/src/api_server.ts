import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { synthesize, type RetrievedFragment } from './llm_client.js';
import {
  KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, ClaimRegistry, PeerRegistry,
  isLLMConfigured, validateLLMKey, buildDeclaredSources,
  EMBEDDING_MODEL, EMBEDDING_DIM, CHUNKER_VERSION, SCHEMA_VERSION,
  type FragmentV08,
} from '@hive/core';
import type { PeerMeta, BeeManifest } from '@hive/core';
import { QueenIndex } from '@hive/embeddings-node';
import { runAutonomousExtraction } from '@hive/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

// Build/version label for /api/status and the UI badge. Falls back to 'unknown'
// silently if package.json is unreachable (e.g. bundled deployments).
let HIVE_VERSION = 'unknown';
try {
  const pkgPath = resolve(__dirname, '../../../package.json');
  const pkgJson = JSON.parse(await (await import('node:fs/promises')).readFile(pkgPath, 'utf8'));
  HIVE_VERSION = String(pkgJson.version ?? 'unknown');
} catch { /* fall back to 'unknown' */ }

const PORT = Number(process.env.HIVE_PORT ?? 8080);
// ── HIVE_MODE — bee | queen | hive ─────────────────────────────────────────
// bee   — producer-only: extractor + Hypercore + Hyperswarm.
// queen — consumer-only: in-process LanceDB + LLM + queries; no extractor,
//         no local Hypercore writes (only peer replication).
// hive  — both in one process (single-machine quickstart / dev).
const RAW_HIVE_MODE = (process.env.HIVE_MODE ?? 'bee').toLowerCase();
const HIVE_MODE = (
  RAW_HIVE_MODE === 'aggregator' ? 'queen' :          // v0.6 alias
  RAW_HIVE_MODE === 'bee' || RAW_HIVE_MODE === 'queen' || RAW_HIVE_MODE === 'hive' ? RAW_HIVE_MODE :
  'bee'
) as 'bee' | 'queen' | 'hive';
if (RAW_HIVE_MODE === 'aggregator') {
  console.warn(`[v0.8] HIVE_MODE=aggregator is the v0.6 alias and is going away — use HIVE_MODE=queen.`);
}
if (RAW_HIVE_MODE !== HIVE_MODE && RAW_HIVE_MODE !== 'aggregator') {
  console.warn(`[v0.8] Unknown HIVE_MODE=${RAW_HIVE_MODE}, defaulting to '${HIVE_MODE}'. Valid: bee | queen | hive.`);
}

const IS_BEE   = HIVE_MODE === 'bee';
const IS_QUEEN = HIVE_MODE === 'queen';
const IS_HIVE  = HIVE_MODE === 'hive';

// Capability flags derived once at boot.
const HAS_EXTRACTOR           = IS_BEE  || IS_HIVE;
const HAS_LOCAL_STORE         = IS_BEE  || IS_HIVE;
const HAS_QUERY_API           = IS_QUEEN || IS_HIVE;
const HAS_QUEEN_INDEX         = IS_QUEEN || IS_HIVE;   // owns the LanceDB index
const HAS_REMOTE_REPLICATION  = IS_QUEEN || IS_HIVE;   // downloads peer Hypercores
const HAS_DASHBOARD_PROXY     = IS_QUEEN;              // proxies /api/crawl to a bee for external dashboards

const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
const INDEX_DIR = join(DATA_DIR, 'lancedb');

// Runtime overrides for LLM provider/key (UI-driven), persisted under the data
// volume so they survive container recreates.
const RUNTIME_ENV_PATH = join(DATA_DIR, '.runtime.env');
try {
  const fs = await import('node:fs');
  if (fs.existsSync(RUNTIME_ENV_PATH)) {
    const raw = fs.readFileSync(RUNTIME_ENV_PATH, 'utf8');
    let applied = 0;
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, key, value] = m;
      if (!/^LLM_/.test(key)) continue;     // only LLM_* — anything else stays under host control
      process.env[key] = value;
      applied++;
    }
    if (applied > 0) console.log(`[config] Applied ${applied} runtime override(s) from ${RUNTIME_ENV_PATH}`);
  }
} catch { /* fall back to docker env */ }

const HIVE_OBJECTIVE = process.env.HIVE_OBJECTIVE ?? '';
const HIVE_TOPIC_DOMAIN = process.env.BEE_TOPIC_DOMAIN ?? '';
const EXTRACT_INTERVAL_MS = Number(process.env.HIVE_EXTRACT_INTERVAL_MS ?? 1000);
const EXTRACT_MAX_FRAGMENTS = Number(process.env.HIVE_EXTRACT_MAX_FRAGMENTS ?? 10);
const EXTRACT_BUDGET_MINUTES = Number(process.env.HIVE_EXTRACT_BUDGET_MINUTES ?? 8);

// ── Bootstrap ──────────────────────────────────────────────────────────────
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`\n🐝 HIVE v${HIVE_VERSION} node: ${identity.nodeId}`);
console.log(`   Data dir : ${DATA_DIR}`);

const knowledgeStore = new KnowledgeStore(DATA_DIR, identity);
await knowledgeStore.ready();
console.log(`   KnowledgeStore ready ✓`);

const peerRegistry = new PeerRegistry();
peerRegistry.register(identity.nodeId, identity.publicKeyHex);

// In-process v0.8 vector index. ONLY the queen/hive role owns one — bees are
// producers that ship signed vectors over P2P, not consumers.
const queenIndex: QueenIndex | null = HAS_QUEEN_INDEX ? new QueenIndex(INDEX_DIR) : null;
if (queenIndex) {
  await queenIndex.ready();
  console.log(`   QueenIndex ready ✓ (LanceDB @ ${INDEX_DIR}, model=${EMBEDDING_MODEL})`);
}

// Helper: upsert a batch of v0.8 fragments into the queen's index, supplying
// pubkeys from the registry so QueenIndex.verifyFragmentV08 has what it needs.
async function indexFragmentsIntoQueen(batch: FragmentV08[]): Promise<void> {
  if (!queenIndex || batch.length === 0) return;
  const pubkeyByNode: Record<string, string> = {};
  for (const f of batch) {
    const pk = peerRegistry.pubkeyFor(f.node_id) ?? f.node_pubkey;
    if (pk) pubkeyByNode[f.node_id] = pk;
  }
  try {
    const res = await queenIndex.upsertFragments(batch, { pubkeyByNode });
    if (res.skipped > 0) console.log(`[queen] upsert: +${res.added} added, ${res.skipped} skipped (drop counters: ${JSON.stringify(queenIndex.stats().dropped)})`);
  } catch (e: any) {
    console.warn(`[queen] upsertFragments failed: ${e?.message ?? e}`);
  }
}

const claimRegistry = new ClaimRegistry(DATA_DIR, knowledgeStore.corestore);
await claimRegistry.ready();

// ── BeeManifest (v0.7.3, v0.8 fields populated) ────────────────────────────
if (HAS_LOCAL_STORE) {
  const beeManifest: BeeManifest = {
    bee_id: identity.nodeId,
    declared_sources: buildDeclaredSources(),
    declared_languages: (process.env.HIVE_LANGUAGES ?? 'en').split(',').map(s => s.trim()).filter(Boolean),
    replication: (['none', 'neighbors', 'all'].includes(process.env.HIVE_BEE_REPLICATE ?? '')
      ? process.env.HIVE_BEE_REPLICATE as 'none' | 'neighbors' | 'all'
      : 'all'),
    version: HIVE_VERSION,
    published_at: new Date().toISOString(),
    // v0.8 — embedding/schema standard this bee writes.
    embedding_model: EMBEDDING_MODEL,
    embedding_dim: EMBEDDING_DIM,
    chunker_version: CHUNKER_VERSION,
    schema_version: SCHEMA_VERSION,
  };
  await knowledgeStore.publishManifest(beeManifest);
  const srcList = beeManifest.declared_sources.map(s => s.id).join(', ');
  console.log(`   Manifest  → sources: ${srcList} | policy: ${beeManifest.declared_sources[0]?.policy ?? 'drift-ok'} | replication: ${beeManifest.replication}`);
  console.log(`   v0.8     → model=${EMBEDDING_MODEL} dim=${EMBEDDING_DIM} chunker=${CHUNKER_VERSION} schema=${SCHEMA_VERSION}`);

  for (const decl of beeManifest.declared_sources) {
    if (decl.partition) {
      const claimId = `${decl.id}:${decl.partition}`;
      try {
        await claimRegistry.claim(claimId, identity.nodeId);
        console.log(`   Partition claimed: ${claimId}`);
      } catch (e: any) {
        console.warn(`   Partition claim failed for ${claimId}: ${e?.message ?? e}`);
      }
    }
  }
}

const localMeta: PeerMeta = {
  nodeId: identity.nodeId,
  publicKey: identity.publicKeyHex,
  coreKey: knowledgeStore.coreKey.toString('hex'),
  claimsCoreKey: claimRegistry.coreKey?.toString('hex') ?? '',
};
const p2pNode = new HiveP2PNode(knowledgeStore.corestore, localMeta);

// ── peer-meta handler — register identity + spin up remote watcher ─────────
// MUST be registered BEFORE p2pNode.start() so early peer events aren't lost.
p2pNode.on('peer-meta', (meta: PeerMeta, peerId: string) => {
  try {
    peerRegistry.register(meta.nodeId, meta.publicKey);

    if (!HAS_REMOTE_REPLICATION) {
      console.log(`[p2p] Peer ${meta.nodeId.slice(0, 16)} registered (mode=${HIVE_MODE}, no remote replication)`);
      return;
    }

    const remoteCoreKey = Buffer.from(meta.coreKey, 'hex');
    const peerCore = (knowledgeStore.corestore as any).get({ key: remoteCoreKey });
    peerCore.ready().then(() => {
      peerCore.download({ start: 0, end: -1 });
      console.log(`[p2p] Replication started for ${meta.nodeId.slice(0, 16)} (peer ${peerId})`);
      // v0.8 — stream fragments straight into the in-process QueenIndex.
      knowledgeStore.watchRemoteCoreV08(remoteCoreKey, meta.nodeId, indexFragmentsIntoQueen).catch(err =>
        console.warn(`[repl] watchRemoteCoreV08 crashed: ${err?.message ?? err}`),
      );
    }).catch((err: any) => console.warn(`[p2p] peerCore.ready failed for ${peerId}: ${err?.message ?? err}`));

    if (meta.claimsCoreKey) {
      const claimsKey = Buffer.from(meta.claimsCoreKey, 'hex');
      claimRegistry.watchRemoteClaims(claimsKey).catch(err =>
        console.warn(`[claims] watchRemoteClaims crashed: ${err?.message ?? err}`),
      );
    }
  } catch (e: any) {
    console.warn(`[p2p] peer-meta handling failed for ${peerId}: ${e.message}`);
  }
});

await p2pNode.start();

// v0.8 — peering self-heal. When a node is isolated (peerCount=0) for more than
// a minute, refresh the Hyperswarm discovery so the announce/lookup round-trips
// the DHT again. Without this, the initial holepunch after a deploy occasionally
// misses on the Hetzner box (two containers behind the same NAT) and the
// operator has to docker-restart the queen to recover; see CLAUDE.md "discovery
// glitch". Only matters when a node expects peers — pure-bee in this single-box
// setup still wants the queen to find it, and the queen always wants peers.
setInterval(() => {
  if (p2pNode.peerCount === 0) {
    console.log('[p2p] peerCount=0 — refreshing Hyperswarm discovery');
    p2pNode.rejoin().catch((err) =>
      console.warn(`[p2p] rejoin failed: ${err?.message ?? err}`),
    );
  }
}, 60_000).unref();

// Hive mode: local bee writes also need to flow into the local queen index.
// (Pure bees and pure queens skip this — bee mode has no queenIndex, queen
// mode has no local writes.)
if (IS_HIVE && queenIndex) {
  knowledgeStore.watchLocalCoreV08(indexFragmentsIntoQueen).catch(err =>
    console.warn(`[local-watch] crashed: ${err?.message ?? err}`),
  );
  console.log(`   Local→QueenIndex watch started ✓`);
}

// ── Fastify ─────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
});
await app.register(staticPlugin, { root: UI_DIR, prefix: '/' });

// ── POST /api/query ────────────────────────────────────────────────────────
// Queen/hive only. The queen embeds the QUESTION (the one place the queen
// embeds in v0.8), searches LanceDB, applies the recalibrated retrieval gate,
// and hands the hits to the LLM grounded-verdict pass.
if (HAS_QUERY_API && queenIndex) app.post<{ Body: { question: string; top_k?: number; use_llm?: boolean; history?: Array<{role: string; content: string}>; filters?: Record<string, unknown> } }>(
  '/api/query',
  async (req, reply) => {
    const { question, top_k = 8, use_llm = true, history = [], filters } = req.body;
    if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

    const { hits, has_hive_data } = await queenIndex.query(question, top_k, filters as any);
    const fragments: RetrievedFragment[] = hits.map(h => ({
      id: h.id,
      text: h.text,
      title: h.title,
      url: h.url,
      source: h.source,
      source_type: h.source_type,
      lang: h.lang,
      node_id: h.node_id,
      score: h.score,
      relevant: h.relevant,
    }));

    if (!use_llm) return { fragments, has_hive_data, embedder_online: true, answer: null, mode: 'raw' };

    if (!isLLMConfigured()) {
      return reply.code(503).send({ error: 'LLM not configured — set LLM_PROVIDER + LLM_API_KEY, or LLM_PROVIDER=ollama for local inference' });
    }

    try {
      const { answer, mode, grounded } = await synthesize(question, fragments, has_hive_data, history);
      // Gate decides what fragments to SEND the LLM; the LLM's grounded verdict
      // decides whether the answer actually rests on them. Badge + chips follow
      // the LLM, not the gate — otherwise topically-near-but-wrong hits show
      // "Verified by HIVE" over an answer that admits it has no such data.
      const verified = has_hive_data && grounded;
      return {
        answer,
        mode,
        fragments: verified ? fragments : [],
        has_hive_data: verified,
        embedder_online: true,
      };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  },
);

// ── GET /api/fragments — list local-store fragments (bee/hive) ─────────────
// Bees and hive-mode read from their own signed Hypercore (hash + signature
// intact). Pure queens own no local store, so they return empty — the queen's
// canonical fragment view in v0.8 is the LanceDB index (queried via /api/query).
app.get<{ Querystring: { limit?: string; offset?: string } }>(
  '/api/fragments',
  async (req) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    if (!HAS_LOCAL_STORE) return { total: 0, offset, limit, fragments: [] };

    const all: FragmentV08[] = [];
    for await (const frag of knowledgeStore.query({})) {
      all.push(frag);
      if (all.length >= 5000) break;       // hard cap to avoid OOM on huge stores
    }
    const page = all.slice(offset, offset + limit);
    return { total: all.length, offset, limit, fragments: page };
  },
);

// ── GET /api/node-info ─────────────────────────────────────────────────────
app.get('/api/node-info', async () => ({
  nodeId: identity.nodeId,
  port: PORT,
  version: HIVE_VERSION,
}));

// ── GET /api/peers ─────────────────────────────────────────────────────────
app.get('/api/peers', async () => ({ peers: p2pNode.peers }));

// ── GET /api/topics — knowledge summary grouped by node_id ─────────────────
// 1. Claim registry → active bees + their topics.
// 2. Queen index countByNode → exact per-bee fragment count.
app.get('/api/topics', async () => {
  const byNode: Record<string, { nodeId: string; titles: string[]; count: number }> = {};
  const activeClaimNodes = new Set<string>();

  try {
    const activeClaims = await claimRegistry.getAllActiveClaims();
    for (const [topicId, beeIds] of Object.entries(activeClaims)) {
      for (const beeId of beeIds) {
        activeClaimNodes.add(beeId);
        if (!byNode[beeId]) byNode[beeId] = { nodeId: beeId, titles: [], count: 0 };
        if (!byNode[beeId].titles.includes(topicId)) byNode[beeId].titles.push(topicId);
      }
    }
  } catch {}

  if (queenIndex) {
    const nodeIds = Object.keys(byNode);
    if (nodeIds.length > 0) {
      try {
        const counts = await queenIndex['idx'].countByNode(nodeIds);
        for (const [nid, cnt] of Object.entries(counts)) {
          if (byNode[nid]) byNode[nid].count = cnt;
        }
      } catch (e: any) {
        console.warn(`[topics] countByNode failed: ${e?.message ?? e}`);
      }
    }
  }

  // Filter zombie peers: no active claim + zero/low count means it's a
  // disconnected peer whose data hasn't replicated.
  const nodes = Object.values(byNode).filter(n => activeClaimNodes.has(n.nodeId) || n.count >= 500);
  return { nodes };
});

// ── GET /api/claims ────────────────────────────────────────────────────────
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

app.post<{ Body: { claims: Array<{ topicId: string; beeId: string; fragmentCount: number }> } }>(
  '/api/claims',
  async (req) => {
    const { claims } = req.body;
    if (Array.isArray(claims)) {
      for (const c of claims) {
        if (c.topicId && c.beeId) await claimRegistry.claim(c.topicId, c.beeId, c.fragmentCount);
      }
    }
    return { ok: true };
  }
);

// ── GET /api/status ────────────────────────────────────────────────────────
app.get('/api/status', async () => {
  const indexed = queenIndex ? await queenIndex.count() : 0;
  return {
    api: 'ok',
    version: HIVE_VERSION,
    mode: HIVE_MODE,
    nodeId: identity.nodeId,
    nodeIdShort: identity.nodeId.slice(0, 20),
    embedder_online: true,                   // in-process; either we booted or we didn't
    indexed,
    // v0.8.4 — bee/hive nodes also report how many fragments they've signed
    // locally (the Hypercore size). Distinct from `indexed` (LanceDB count on
    // the queen) so a bee dashboard can show a meaningful number.
    local_fragments: HAS_LOCAL_STORE ? knowledgeStore.localFragmentCount : 0,
    model: queenIndex ? EMBEDDING_MODEL : null,
    backend: queenIndex ? 'lancedb' : null,
    schema_version: SCHEMA_VERSION,
    chunker_version: CHUNKER_VERSION,
    llm_configured: isLLMConfigured(),
    llm_ok: llmHealthy,
    llm_provider: process.env.LLM_PROVIDER ?? 'gemini',
    peers: p2pNode.peerCount,
    coreKey: knowledgeStore.coreKey?.toString('hex') ?? null,
    claimsCoreKey: claimRegistry.coreKey?.toString('hex') ?? null,
    publicKey: identity.publicKeyHex,
  };
});

// ── GET /api/crawl — forager state (bee/hive own queue files; queen proxies) ─
// v0.8.4 — queen now fans out across every URL in HIVE_DASHBOARD_BEE_URLS
// (comma-separated). Result: aggregate queue/visited counts plus a per-bee
// breakdown so external dashboards can render multi-bee deployments. The
// legacy single-URL HIVE_DASHBOARD_BEE_URL still works (treated as one URL).
app.get('/api/crawl', async () => {
  if (HAS_DASHBOARD_PROXY) {
    const raw = process.env.HIVE_DASHBOARD_BEE_URLS
      ?? process.env.HIVE_DASHBOARD_BEE_URL
      ?? 'http://bee-1:8080';
    const beeUrls = raw.split(',').map(s => s.trim()).filter(Boolean);
    const perBee = await Promise.all(beeUrls.map(async (url) => {
      try {
        const res = await fetch(`${url}/api/crawl`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { url, queue_size: 0, visited_size: 0, next_in_queue: [], recent_visited: [], error: `HTTP ${res.status}` };
        const data = await res.json() as { queue_size?: number; visited_size?: number; next_in_queue?: string[]; recent_visited?: string[] };
        return {
          url,
          queue_size: data.queue_size ?? 0,
          visited_size: data.visited_size ?? 0,
          next_in_queue: data.next_in_queue ?? [],
          recent_visited: data.recent_visited ?? [],
        };
      } catch (e: any) {
        return { url, queue_size: 0, visited_size: 0, next_in_queue: [], recent_visited: [], error: e?.message ?? 'bee unreachable' };
      }
    }));
    const queue_size = perBee.reduce((s, b) => s + b.queue_size, 0);
    const visited_size = perBee.reduce((s, b) => s + b.visited_size, 0);
    // Interleave queues + recents so the dashboard sees fresh items from every bee.
    const next_in_queue = perBee.flatMap(b => b.next_in_queue.slice(0, 5)).slice(0, 10);
    const recent_visited = perBee.flatMap(b => b.recent_visited.slice(0, 5)).slice(0, 10);
    return { queue_size, visited_size, next_in_queue, recent_visited, bees: perBee };
  }

  const { promises: fsP } = await import('node:fs');
  const queuePath = join(DATA_DIR, 'crawl_queue.jsonl');
  const visitedPath = join(DATA_DIR, 'crawl_visited.jsonl');
  async function lineCount(p: string): Promise<number> {
    try { return (await fsP.readFile(p, 'utf8')).split('\n').filter(l => l.trim().length > 0).length; }
    catch { return 0; }
  }
  async function headLines(p: string, n: number): Promise<string[]> {
    try { return (await fsP.readFile(p, 'utf8')).split('\n').filter(l => l.trim().length > 0).slice(0, n); }
    catch { return []; }
  }
  async function tailLines(p: string, n: number): Promise<string[]> {
    try { return (await fsP.readFile(p, 'utf8')).split('\n').filter(l => l.trim().length > 0).slice(-n).reverse(); }
    catch { return []; }
  }
  const [queueSize, visitedSize, nextInQueue, recentVisited] = await Promise.all([
    lineCount(queuePath),
    lineCount(visitedPath),
    headLines(queuePath, 10),
    tailLines(visitedPath, 10),
  ]);
  return { queue_size: queueSize, visited_size: visitedSize, next_in_queue: nextInQueue, recent_visited: recentVisited };
});

// ── GET /api/directory — local + remote BeeManifests ────────────────────────
app.get('/api/directory', async () => {
  const entries: Array<BeeManifest & { node_id: string; is_self: boolean }> = [];

  if (HAS_LOCAL_STORE) {
    try {
      const local = await knowledgeStore.getLocalManifest();
      if (local) entries.push({ ...local, node_id: identity.nodeId, is_self: true });
    } catch { /* manifest not yet written */ }
  }
  for (const [nodeId, manifest] of knowledgeStore.getRemoteManifests()) {
    entries.push({ ...manifest, node_id: nodeId, is_self: false });
  }

  return { bees: entries, updated_at: new Date().toISOString() };
});

// ── GET /api/stats — aggregate summary (top widgets read this) ─────────────
// Field names match what the capybarahome /hive page expects so the stat trio
// (fragments / bees / topics) actually populates. `topics` here = number of
// distinct (source_id[:partition]) units declared across local + remote
// BeeManifests — i.e. the coverage breadth of the network the queen sees.
app.get('/api/stats', async () => {
  const indexed = queenIndex ? await queenIndex.count() : 0;
  const peers = p2pNode.peerCount;

  // Collect declared sources across every manifest the queen knows about.
  const topicSet = new Set<string>();
  let activeBees = HAS_LOCAL_STORE ? 1 : 0;
  if (HAS_LOCAL_STORE) {
    try {
      const local = await knowledgeStore.getLocalManifest();
      for (const s of local?.declared_sources ?? []) {
        topicSet.add(s.partition ? `${s.id}:${s.partition}` : s.id);
      }
    } catch { /* first boot */ }
  }
  for (const [, manifest] of knowledgeStore.getRemoteManifests()) {
    activeBees++;
    for (const s of manifest.declared_sources ?? []) {
      topicSet.add(s.partition ? `${s.id}:${s.partition}` : s.id);
    }
  }
  // If we haven't received any manifest yet, fall back to peer count.
  if (activeBees === 0) activeBees = peers;

  return {
    mode: HIVE_MODE,
    version: HIVE_VERSION,
    // Public surface the dashboards read.
    fragments: indexed,
    bees: activeBees,
    topics: topicSet.size,
    // Legacy fields kept for backward compat.
    indexed,
    peers,
    model: queenIndex ? EMBEDDING_MODEL : null,
    backend: queenIndex ? 'lancedb' : null,
  };
});

// ── Activity log (ring buffer) ─────────────────────────────────────────────
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

// ── Queen-only startup log ────────────────────────────────────────────────
if (IS_QUEEN) {
  logEvent('start', 'Queen mode — in-process LanceDB index, no Python, no Qdrant');
  logEvent('start', `Index dir: ${INDEX_DIR}`);
  logEvent('start', 'Waiting for BEEs to connect via Hyperswarm...');
}

// ── Extractor setup (bee + hive) ───────────────────────────────────────────
// v0.8 — manifest-driven seeding. HIVE_OBJECTIVE wins when explicitly set; the
// fallback derives from the bee's BeeManifest (partition → scope → adapter
// default) so an operator who only declared sources still gets a sensible
// crawl seed without needing the old topic_tree.json fallback. Soft topic
// domain (HIVE_TOPIC_DOMAIN) is still honoured for adapter selection later in
// the cycle.
function deriveObjectiveFromManifest(): string {
  const sources = buildDeclaredSources();
  if (sources.length === 0) return 'general knowledge';
  const s = sources[0];
  if (s.partition) return s.partition.replace(/^Category:/i, '');
  const scope = (s.scope ?? {}) as Record<string, unknown>;
  if (typeof scope.category_tree === 'string') return scope.category_tree.replace(/^Category:/i, '');
  if (Array.isArray(scope.categories) && scope.categories.length > 0) return (scope.categories as string[]).join(' ');
  if (Array.isArray(scope.domains) && scope.domains.length > 0) return (scope.domains as string[])[0]!;
  if (HIVE_TOPIC_DOMAIN) return HIVE_TOPIC_DOMAIN;
  return s.id.startsWith('wikipedia') ? 'science' : 'general knowledge';
}

let resolvedObjective = HAS_EXTRACTOR ? HIVE_OBJECTIVE : '';
if (HAS_EXTRACTOR && !resolvedObjective) {
  resolvedObjective = deriveObjectiveFromManifest();
  logEvent('start', `No HIVE_OBJECTIVE — seeded from manifest: "${resolvedObjective}"`);
}

// ── LLM health tracking ───────────────────────────────────────────────────
let llmHealthy: boolean | null = null;
if (isLLMConfigured()) {
  validateLLMKey(process.env.LLM_PROVIDER ?? 'gemini', process.env.LLM_API_KEY ?? '')
    .then(err => { llmHealthy = err === null; })
    .catch(() => { llmHealthy = false; });
}

// ── Autonomous extraction loop (bee/hive) ──────────────────────────────────
let extractionLoopRunning = false;
const MAX_TOPICS_PER_CYCLE = 5;

const runLoop = async () => {
    extracting = true;
    nextCycleAt = null;
    let totalIndexed = 0;

    try {
      const released = await claimRegistry.releaseExpired();
      if (released.length > 0) logEvent('sync', `Released ${released.length} stale claims from dead BEEs`);
    } catch (e: any) {
      logEvent('error', `Claim sweep failed: ${e.message}`);
    }

    try {
      let claims = await claimRegistry.getClaimsForBee(identity.nodeId);
      if (!claims.length) {
        claims = [{ topicId: 'default', beeId: identity.nodeId, claimedAt: '', renewedAt: '', fragmentCount: 0, isPrimary: true }];
      }

      const activeClaims = claims.slice(0, MAX_TOPICS_PER_CYCLE);
      const fragsPerTopic = Math.max(3, Math.floor(EXTRACT_MAX_FRAGMENTS / activeClaims.length));
      logEvent('start', `Starting cycle: ${activeClaims.length}/${claims.length} topics, ~${fragsPerTopic} frags each`);

      for (const claim of activeClaims) {
        // v0.8 — partition claims look like "<source_id>:<partition_key>"; the
        // autonomous_extractor reads partition info from the BeeManifest itself
        // and overrides the seed accordingly. Everything else just uses the
        // resolved objective (no more topic_tree leaf lookup).
        const topicObjective = resolvedObjective;

        logEvent('start', `Topic: ${claim.topicId}`);
        const topicMaxMin = Math.ceil(EXTRACT_BUDGET_MINUTES / activeClaims.length);
        // Hard timeout: 2× budget + 2 min buffer for in-flight ops.
        const topicDeadlineMs = (topicMaxMin * 2 + 2) * 60_000;
        try {
          const result = await Promise.race([
            runAutonomousExtraction(
              topicObjective,
              { maxFragments: fragsPerTopic, maxMinutes: topicMaxMin },
              knowledgeStore,
              (frag) => logEvent('fragment', `[${claim.topicId.split('/').pop()}] "${frag.title ?? frag.id}"`),
              (ok) => { llmHealthy = ok; },
            ),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`topic deadline exceeded (${topicMaxMin * 2 + 2}min)`)), topicDeadlineMs)
            ),
          ]);
          totalIndexed += result.fragmentsIndexed;
          await claimRegistry.claim(claim.topicId, identity.nodeId, claim.fragmentCount + result.fragmentsIndexed);
        } catch (e: any) {
          logEvent('error', `Topic ${claim.topicId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      logEvent('error', `Cycle failed: ${e.message}`);
    } finally {
      extracting = false;
      nextCycleAt = Date.now() + EXTRACT_INTERVAL_MS;
      logEvent('done', `Cycle complete: ${totalIndexed} fragments`);
      logEvent('start', `Next cycle in ${Math.round(EXTRACT_INTERVAL_MS / 60_000)}min`);
      setTimeout(runLoop, EXTRACT_INTERVAL_MS);
    }
  };

async function startExtractionIfReady() {
  if (!HAS_EXTRACTOR) return;
  if (extractionLoopRunning) return;
  if (IS_HIVE && !isLLMConfigured()) {
    logEvent('start', 'LLM not configured — queries will fail, but extraction proceeds.');
  }
  if (!resolvedObjective) {
    resolvedObjective = deriveObjectiveFromManifest();
    logEvent('start', `Seeded objective from manifest: "${resolvedObjective}"`);
  }
  if (!resolvedObjective) return;

  extractionLoopRunning = true;
  logEvent('start', 'Autonomous mode active');
  const delay = 2_000 + Math.random() * 8_000;
  setTimeout(runLoop, delay);
  nextCycleAt = Date.now() + delay;
}

if (HAS_EXTRACTOR) startExtractionIfReady();

// ── POST /api/config — set LLM provider + key at runtime ───────────────────
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

  const validationError = await validateLLMKey(provider, provider === 'ollama' ? '' : apiKey.trim());
  if (validationError) return reply.code(400).send({ error: `Validation failed: ${validationError}` });

  process.env.LLM_PROVIDER = provider;
  if (provider !== 'ollama') process.env.LLM_API_KEY = apiKey.trim();
  if (model?.trim()) process.env.LLM_MODEL = model.trim();
  llmHealthy = true;

  try {
    const fs = await import('node:fs/promises');
    let content = '';
    try { content = await fs.readFile(RUNTIME_ENV_PATH, 'utf8'); } catch { /* first write */ }
    content = upsertEnvLine(content, 'LLM_PROVIDER', provider);
    content = upsertEnvLine(content, 'LLM_API_KEY', apiKey.trim());
    if (model?.trim()) content = upsertEnvLine(content, 'LLM_MODEL', model.trim());
    await fs.writeFile(RUNTIME_ENV_PATH, content, 'utf8');
    await fs.chmod(RUNTIME_ENV_PATH, 0o600).catch(() => {});
  } catch (e: any) {
    console.warn(`[config] Could not persist runtime override to ${RUNTIME_ENV_PATH}: ${e?.message ?? e}`);
  }

  await startExtractionIfReady();
  return { ok: true, provider };
});

// ── GET /api/state — full debug state ──────────────────────────────────────
app.get('/api/state', async () => {
  const indexed = queenIndex ? await queenIndex.count() : 0;
  const activeClaims = await claimRegistry.getAllActiveClaims();
  const myClaims = await claimRegistry.getClaimsForBee(identity.nodeId);
  return {
    nodeId: identity.nodeId,
    port: PORT,
    dataDir: DATA_DIR,
    objective: resolvedObjective,
    indexed,
    model: queenIndex ? EMBEDDING_MODEL : null,
    backend: queenIndex ? 'lancedb' : null,
    peers: p2pNode.peers,
    myClaims: myClaims.map(c => ({ topicId: c.topicId, fragments: c.fragmentCount, renewed: c.renewedAt })),
    networkClaims: Object.fromEntries(
      Object.entries(activeClaims).map(([topic, bees]) => [topic, bees])
    ),
    extracting,
    nextCycleAt,
  };
});

// ── GET /api/activity ──────────────────────────────────────────────────────
app.get('/api/activity', async () => ({
  events: [...activityLog].reverse(),
  extracting,
  nextCycleAt,
  objective: resolvedObjective || null,
}));

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n   HIVE  → v${HIVE_VERSION}`);
  console.log(`   Mode  → ${HIVE_MODE.toUpperCase()}`);
  console.log(`   API  → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   UI   → http://127.0.0.1:${PORT}/`);
  console.log(`   Peers → Hyperswarm discovery (no HTTP bootstrap since v0.6.4)`);
  if (HAS_QUERY_API) {
    const provider = process.env.LLM_PROVIDER ?? 'gemini';
    console.log(`   LLM  → ${provider} ${isLLMConfigured() ? '✓' : '(NOT SET)'}`);
  }
  if (HAS_QUEEN_INDEX) {
    console.log(`   Index → LanceDB @ ${INDEX_DIR}`);
    console.log(`   Model → ${EMBEDDING_MODEL} (${EMBEDDING_DIM}d, schema v${SCHEMA_VERSION})`);
  }
  console.log();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// v0.7.7.12 — without this, `docker stop` killed node mid-Hypercore-append,
// forking the bee's core. Close cleanly on SIGTERM (forwarded by the launcher
// script). Requires docker `stop_grace_period` longer than this routine.
let _shuttingDown = false;
async function gracefulShutdown(sig: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${sig} received — closing stores cleanly…`);
  const force = setTimeout(() => {
    console.warn('[shutdown] timed out after 25s — forcing exit');
    process.exit(1);
  }, 25_000);
  try { await app.close(); } catch (e: any) { console.warn(`[shutdown] app.close: ${e?.message ?? e}`); }
  try { await p2pNode.stop(); } catch (e: any) { console.warn(`[shutdown] p2pNode.stop: ${e?.message ?? e}`); }
  try { await claimRegistry.close(); } catch (e: any) { console.warn(`[shutdown] claimRegistry.close: ${e?.message ?? e}`); }
  try { await knowledgeStore.close(); } catch (e: any) { console.warn(`[shutdown] knowledgeStore.close: ${e?.message ?? e}`); }
  try { if (queenIndex) await queenIndex.close(); } catch (e: any) { console.warn(`[shutdown] queenIndex.close: ${e?.message ?? e}`); }
  clearTimeout(force);
  console.log('[shutdown] stores closed — exiting cleanly');
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
