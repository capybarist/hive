import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';
import { KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, ClaimRegistry, PeerRegistry, isLLMConfigured, validateLLMKey, buildDeclaredSources } from '@hive/core';
import type { PeerMeta, BeeManifest } from '@hive/core';
import { runAutonomousExtraction, discoverObjective } from '@hive/agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

// Read the package.json version once at startup so /api/status and the UI
// can advertise which build is running. Fails silently to 'unknown' if the
// file can't be read (e.g. zipped/bundled deployments).
let HIVE_VERSION = 'unknown';
try {
  const pkgPath = resolve(__dirname, '../../../package.json');
  const pkgJson = JSON.parse(await (await import('node:fs/promises')).readFile(pkgPath, 'utf8'));
  HIVE_VERSION = String(pkgJson.version ?? 'unknown');
} catch { /* fall back to 'unknown' */ }

const PORT = Number(process.env.HIVE_PORT ?? 8080);
// ── HIVE_MODE (v0.7) ────────────────────────────────────────────────────────
// Three modes selectable at runtime, all served by the same binary:
//   bee   — producer only: extractor + Hypercore + Hyperswarm. No embedder,
//           no LLM, no query API. ~150 MB target after v0.7 cleanup. THIS IS
//           THE DEFAULT: most operators want to contribute to the network,
//           not stand up a full consumer node.
//   queen — consumer/indexer: Qdrant + embedder + LLM + queries. No local
//           extractor, no local Hypercore writes. Replaces the legacy
//           `aggregator` name (still accepted as a v0.6 alias).
//   hive  — both in one process. Single-machine quickstart for dev and
//           power users who want extractor + query API together. Behaves
//           identically to v0.6.x's single-binary node.
//
// Capability flags below let the rest of the code ask "do I run X?"
// without sprinkling HIVE_MODE checks everywhere. Add a new flag instead
// of branching on the literal string.
const RAW_HIVE_MODE = (process.env.HIVE_MODE ?? 'bee').toLowerCase();
const HIVE_MODE = (
  RAW_HIVE_MODE === 'aggregator' ? 'queen' :          // v0.6 alias
  RAW_HIVE_MODE === 'bee' || RAW_HIVE_MODE === 'queen' || RAW_HIVE_MODE === 'hive' ? RAW_HIVE_MODE :
  'bee'                                               // unknown values fall back to 'bee' (the safe default)
) as 'bee' | 'queen' | 'hive';
if (RAW_HIVE_MODE === 'aggregator') {
  console.warn(`[v0.7] HIVE_MODE=aggregator is a v0.6 alias and will be removed in v0.8. Use HIVE_MODE=queen.`);
}
if (RAW_HIVE_MODE !== HIVE_MODE && RAW_HIVE_MODE !== 'aggregator') {
  console.warn(`[v0.7] Unknown HIVE_MODE=${RAW_HIVE_MODE}, defaulting to '${HIVE_MODE}'. Valid: bee | queen | hive.`);
}

const IS_BEE   = HIVE_MODE === 'bee';
const IS_QUEEN = HIVE_MODE === 'queen';
const IS_HIVE  = HIVE_MODE === 'hive';

// Capability flags (what does this mode do?). These are derived once at
// boot so the rest of the file reads as "if (HAS_EXTRACTOR) ..." instead
// of "if (HIVE_MODE === 'bee' || HIVE_MODE === 'hive') ...".
const HAS_EXTRACTOR           = IS_BEE  || IS_HIVE;   // runs the autonomous Wikipedia forager
const HAS_LOCAL_STORE         = IS_BEE  || IS_HIVE;   // writes its own Hypercore (signed fragments)
const HAS_QUERY_API           = IS_QUEEN || IS_HIVE;  // /api/query + LLM synthesis
const HAS_LOCAL_EMBED         = IS_QUEEN || IS_HIVE;  // talks to embedder for /add and /search
const HAS_REMOTE_REPLICATION  = IS_QUEEN || IS_HIVE;  // downloads peer Hypercores into the local index
const HAS_DASHBOARD_PROXY     = IS_QUEEN;             // /api/crawl proxies a bee for external dashboards

// Bees still join Hyperswarm so queens can discover them and pull their
// Hypercore — but a producer-only bee doesn't ingest anything itself.
const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
// HIVE_PEER is DEPRECATED since v0.6.4: discovery is fully Hyperswarm-based and
// the meta exchange (coreKey + publicKey + claimsCoreKey) happens over the
// Protomux `hive/meta/v1` channel on the same socket. We still read the env
// so users with old configs don't see crashes, but we ignore it for sync.
const LEGACY_PEER_API = process.env.HIVE_PEER ?? '';
if (LEGACY_PEER_API) {
  console.warn(`[deprecated] HIVE_PEER=${LEGACY_PEER_API} ignored since v0.6.4 — discovery is Hyperswarm-only. Unset this env var to silence this warning.`);
}
// Runtime overrides set via `POST /api/config`. Stored under the data volume
// so they survive container recreates. Loaded before any LLM check so the
// /api/config-set provider takes effect immediately on next boot without
// needing to edit the host's .env. See v0.6.4.3.
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
      // Only override LLM-related keys — anything else stays under host control.
      if (!/^LLM_/.test(key)) continue;
      process.env[key] = value;
      applied++;
    }
    if (applied > 0) console.log(`[config] Applied ${applied} runtime override(s) from ${RUNTIME_ENV_PATH}`);
  }
} catch { /* runtime env load failed — fall back to docker env */ }

const HIVE_OBJECTIVE = process.env.HIVE_OBJECTIVE ?? '';
const HIVE_TOPIC_DOMAIN = process.env.BEE_TOPIC_DOMAIN ?? '';   // soft domain preference
// v0.7.2.3: default lowered from 30 min → 1 s. The 30-min pause was
// a v0.5/v0.6 hedge against LLM rate limits — the LLM is no longer
// in the extraction loop (see autonomous_extractor.ts since v0.6.1).
// Wikipedia's API tolerates well over 60 req/s for our query shape,
// so a 1 s gap between cycles is polite without leaving the node idle.
// Operators can still raise this via HIVE_EXTRACT_INTERVAL_MS if they
// run on metered bandwidth or want to be extra-conservative.
const EXTRACT_INTERVAL_MS = Number(process.env.HIVE_EXTRACT_INTERVAL_MS ?? 1000);
const EXTRACT_MAX_FRAGMENTS = Number(process.env.HIVE_EXTRACT_MAX_FRAGMENTS ?? 10);
const EXTRACT_BUDGET_MINUTES = Number(process.env.HIVE_EXTRACT_BUDGET_MINUTES ?? 8);

// ── Bootstrap node & P2P ────────────────────────────────────────────────────
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`\n🐝 HIVE node: ${identity.nodeId}`);
console.log(`   Data dir : ${DATA_DIR}`);

const knowledgeStore = new KnowledgeStore(DATA_DIR, identity);
await knowledgeStore.ready();
console.log(`   KnowledgeStore ready ✓`);

// Registry of peer node_id → public key. Populated from the meta exchange
// over the Hyperswarm/Protomux channel (no HTTP). Drives full ed25519
// signature verification on every fragment received via Hypercore.
const peerRegistry = new PeerRegistry();
peerRegistry.register(identity.nodeId, identity.publicKeyHex);

const embedderUrl = process.env.EMBEDDER_URL ?? 'http://127.0.0.1:7700';

// Claim registry is initialised here so it's available when we build the
// PeerMeta below. The full ready() + sweep is set up later in the file —
// here we just need its coreKey, which is available after ready().
const claimRegistry = new ClaimRegistry(DATA_DIR, knowledgeStore.corestore);
await claimRegistry.ready();

// ── BeeManifest (v0.7.3) — publish this node's source declaration ───────────
// Written to the local Hyperbee so any queen that replicates our core can read
// it and populate /api/directory. Only bees/hive have a local store to write to.
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
  };
  await knowledgeStore.publishManifest(beeManifest);
  const srcList = beeManifest.declared_sources.map(s => s.id).join(', ');
  console.log(`   Manifest  → sources: ${srcList} | policy: ${beeManifest.declared_sources[0]?.policy ?? 'drift-ok'} | replication: ${beeManifest.replication}`);

  // v0.7.6 — claim partitions in the ClaimRegistry so other bees see what we
  // cover and can pick non-overlapping partitions. Encoded as the existing
  // topicId field with shape "<source_id>:<partition_key>" so the legacy
  // topic-claim path stays untouched (claims with no ":" are still topics).
  //
  // Why opt-in: bees without a HIVE_PARTITION declared just skip this loop
  // and behave exactly as in v0.7.5 — coordination cost only paid when
  // operator explicitly splits work across peers.
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

// PeerMeta — what we advertise to every Hyperswarm peer we connect with.
// Sent once per connection over the `hive/meta/v1` Protomux channel.
// There is NO HTTP fallback for this exchange since v0.6.4.
const localMeta: PeerMeta = {
  nodeId: identity.nodeId,
  publicKey: identity.publicKeyHex,
  coreKey: knowledgeStore.coreKey.toString('hex'),
  claimsCoreKey: claimRegistry.coreKey?.toString('hex') ?? '',
};
const p2pNode = new HiveP2PNode(knowledgeStore.corestore, localMeta);

// ── Register ALL p2p listeners BEFORE start() ────────────────────────────────
// Hyperswarm peers can connect and emit events during start()'s flush() window.
// Any listener registered after start() would miss those early events.

// One inbound `peer-meta` event per peer = full bootstrap in a single shot:
//   1. learn the peer's pubkey + node_id for signature verification (always)
//   2. open + download the peer's fragments Hypercore (only if HAS_REMOTE_REPLICATION)
//   3. open + download the peer's claims Hypercore (only if HAS_REMOTE_REPLICATION)
// A `bee` (producer-only) registers the peer's identity so it can verify any
// claims-core writes that arrive over the shared Corestore, but it does NOT
// download the peer's fragments core — bees are publishers, not consumers.
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
      knowledgeStore.watchRemoteCore(remoteCoreKey, meta.nodeId, embedderUrl, peerRegistry).catch(err =>
        console.warn(`[repl] watchRemoteCore crashed: ${err?.message ?? err}`),
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

// Start P2P AFTER all listeners are registered so no early peer events are missed
await p2pNode.start();

// Drive local Hypercore → embedder. Needs both: (a) we write our own fragments
// (HAS_LOCAL_STORE) and (b) we have an embedder to push them to (HAS_LOCAL_EMBED).
// In `bee` mode (a) is true but (b) is false — the bee publishes its Hypercore
// for queens to consume, but doesn't keep a local vector index. Skipping
// watchFragments in `bee` mode is the single biggest RAM win of the role split.
if (HAS_LOCAL_STORE && HAS_LOCAL_EMBED) {
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
// Only registered when this node has the query API (queen or hive). A
// producer-only bee doesn't carry an embedder or LLM config — queries
// should go to a queen instead.
if (HAS_QUERY_API) app.post<{ Body: { question: string; top_k?: number; use_llm?: boolean; history?: Array<{role: string; content: string}>; filters?: Record<string, unknown> } }>(
  '/api/query',
  async (req, reply) => {
    const { question, top_k = 5, use_llm = true, history = [], filters } = req.body;
    if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

    const { fragments, has_hive_data, embedder_online } = await queryByText(question, top_k, filters);

    // No federated HTTP query since v0.6.4 — when a peer is connected via
    // Hyperswarm its fragments arrive via Hypercore replication and are
    // already in our local embedder. If they aren't yet, the right answer
    // is "we don't have data" rather than poking the peer over HTTP.

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
// Reads from Hypercore (the signed source-of-truth) so the response carries
// the canonical fragment with hash + signature intact. Previous versions
// read from the embedder's metadata table, which dropped hash/signature and
// re-served whatever the embedder happened to remember.
//
// Aggregator mode keeps reading from the embedder because the aggregator
// owns no local Hypercore — it has only Qdrant + the replicated cores it
// streams to the embedder.
app.get<{ Querystring: { limit?: string; offset?: string } }>(
  '/api/fragments',
  async (req) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    // Queens have no local Hypercore — they aggregate from peers into Qdrant.
    // Bees and hive-mode read from their own signed Hypercore so the response
    // carries hash + signature for the fragments they authored.
    if (!HAS_LOCAL_STORE) {
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
    }

    // BEE mode — stream from Hypercore via KnowledgeStore.query()
    const all: any[] = [];
    for await (const frag of knowledgeStore.query({})) {
      all.push(frag);
      if (all.length >= 5000) break;   // hard cap to avoid OOM on huge stores
    }
    const page = all.slice(offset, offset + limit);
    return { total: all.length, offset, limit, fragments: page };
  },
);

// ── GET /api/node-info ───────────────────────────────────────────────────────
app.get('/api/node-info', async () => ({
  nodeId: identity.nodeId,
  port: PORT,
  version: HIVE_VERSION,
}));

// ── GET /api/peers ───────────────────────────────────────────────────────────
app.get('/api/peers', async () => ({
  peers: p2pNode.peers,
}));

// ── GET /api/topics ──────────────────────────────────────────────────────────
// Returns knowledge summary grouped by node_id.
// 1. Claim registry → which bees are active (always accurate, synced over Hypercore)
// 2. Fragment scan (limit=1000) → article titles for the listed bees
// 3. /count-by-node → exact Qdrant count per node_id (replaces the misleading
//    sample-proportional counts that come from step 2)
app.get('/api/topics', async () => {
  const byNode: Record<string, { nodeId: string; titles: string[]; count: number }> = {};
  const activeClaimNodes = new Set<string>();

  // Step 1 — claim registry (source of truth for active peers)
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

  // Step 2 — fragment sample for article titles
  const seenTitles = new Set<string>();
  try {
    const res = await fetch(`${embedderUrl}/fragments?limit=1000`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as { fragments: any[] };
      for (const f of data.fragments ?? []) {
        const nid: string = f.node_id ?? 'unknown';
        if (!byNode[nid]) byNode[nid] = { nodeId: nid, titles: [], count: 0 };
        byNode[nid].count++;  // preliminary; overwritten in step 3
        if (f.title && !seenTitles.has(f.title)) { seenTitles.add(f.title); byNode[nid].titles.push(f.title); }
      }
    }
  } catch {}

  // Step 3 — accurate per-node counts from Qdrant (fast with node_id payload index)
  const nodeIds = Object.keys(byNode);
  if (nodeIds.length > 0) {
    try {
      const countRes = await fetch(`${embedderUrl}/count-by-node`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ids: nodeIds }),
        signal: AbortSignal.timeout(5000),
      });
      if (countRes.ok) {
        const counts = (await countRes.json()) as Record<string, number>;
        for (const [nid, cnt] of Object.entries(counts)) {
          if (byNode[nid]) byNode[nid].count = cnt;
        }
      }
    } catch {}
  }

  // Step 4 — filter zombie peers: no active claim + fewer than 500 fragments
  // means it's a disconnected peer whose Qdrant data is historical only.
  const nodes = Object.values(byNode).filter(n =>
    activeClaimNodes.has(n.nodeId) || n.count >= 500,
  );

  return { nodes };
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
    version: HIVE_VERSION,
    mode: HIVE_MODE,
    nodeId: identity.nodeId,
    nodeIdShort: identity.nodeId.slice(0, 20),
    embedder_online: embedder !== null,
    indexed: embedder?.indexed ?? 0,
    model: embedder?.model ?? null,
    backend: (embedder as any)?.backend ?? 'hnsw',
    llm_configured: isLLMConfigured(),
    llm_ok: llmHealthy,
    llm_provider: process.env.LLM_PROVIDER ?? 'ollama',
    peers: p2pNode.peerCount,
    coreKey: knowledgeStore.coreKey?.toString('hex') ?? null,
    claimsCoreKey: claimRegistry.coreKey?.toString('hex') ?? null,
    publicKey: identity.publicKeyHex,
  };
});

// ── GET /api/crawl — Wikipedia forager state ─────────────────────────────────
// On a bee: reads the local persistent queue + visited files.
// On the aggregator: proxies to the peer bee (the aggregator itself doesn't
// crawl — it only ingests fragments via Hypercore replication). This lets
// the public dashboard query one URL regardless of where the crawler is.
app.get('/api/crawl', async () => {
  // Aggregator/queen doesn't crawl, but it serves public dashboards
  // (e.g. the capybarahome /hive widget) that need a single endpoint
  // for forager state. This is dashboard plumbing, NOT node-to-node
  // HIVE communication — those nodes talk via Hyperswarm + Hypercore
  // exclusively since v0.6.4. The /api/crawl forwarder simply
  // proxies whichever bee is configured as `HIVE_DASHBOARD_BEE_URL`
  // (defaults to `http://bee-1:8080` for the standard docker-compose
  // topology). Without an explicit bee URL, returns an empty-queue
  // payload so dashboards don't break.
  if (HAS_DASHBOARD_PROXY) {
    const beeUrl = process.env.HIVE_DASHBOARD_BEE_URL ?? 'http://bee-1:8080';
    try {
      const res = await fetch(`${beeUrl}/api/crawl`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { queue_size: 0, visited_size: 0, next_in_queue: [], recent_visited: [], source: beeUrl, hint: `bee returned ${res.status}` };
      const data = await res.json() as object;
      return { ...data, source_bee: beeUrl };
    } catch (e: any) {
      return { queue_size: 0, visited_size: 0, next_in_queue: [], recent_visited: [], source: beeUrl, error: e?.message ?? 'bee unreachable' };
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

// ── GET /api/directory — all known BeeManifests (v0.7.3) ─────────────────────
// Queens return their own manifest + all remote manifests received via
// watchRemoteCore. Bees return their own manifest only (they don't replicate
// peer cores, so remoteManifests stays empty).
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

// claimRegistry is initialised earlier (needed for PeerMeta).
// Both modes use it for network visibility.

// ── Queen-only startup log ─────────────────────────────────────────────────
if (IS_QUEEN) {
  logEvent('start', 'Queen mode active — indexing all peer fragments into Qdrant');
  logEvent('start', `Qdrant backend @ ${process.env.QDRANT_URL ?? 'http://localhost:6333'}`);
  logEvent('start', 'Waiting for BEEs to connect via Hyperswarm...');
}

// ── Extractor setup: resolve objective and prepare claims (bee + hive) ─────
let resolvedObjective = HAS_EXTRACTOR ? HIVE_OBJECTIVE : '';
if (HAS_EXTRACTOR && !resolvedObjective) {
  logEvent('start', 'No HIVE_OBJECTIVE — assigning topics from knowledge tree...');
  try {
    // peerApis empty — Hyperswarm has already populated claimRegistry with
    // any peer claims it has seen via Hypercore replication. There is no
    // HTTP fallback for cross-peer claim discovery since v0.6.4.
    resolvedObjective = await discoverObjective([], '', identity.nodeId, DATA_DIR, 3, claimRegistry, HIVE_TOPIC_DOMAIN || undefined);
    logEvent('start', `Assigned objective: "${resolvedObjective}"`);
  } catch (e: any) {
    logEvent('error', `Topic assignment failed: ${e.message}`);
  }
}

// Register claims in the registry (BEE mode only). Replication is automatic:
// any peer connected via Hyperswarm gets our `claims` Hypercore appended
// blocks and learns about our topics through `watchRemoteClaims`. No HTTP
// push needed since v0.6.4.
if (HAS_EXTRACTOR && resolvedObjective) {
  try {
    const { loadTree } = await import('@hive/core');
    const leaves = loadTree();
    const objLower = resolvedObjective.toLowerCase();
    const matched = leaves.filter(leaf =>
      leaf.keywords.some(kw => objLower.includes(kw.toLowerCase())) ||
      objLower.includes(leaf.name_en.toLowerCase())
    ).slice(0, 5);

    for (const leaf of matched) {
      await claimRegistry.claim(leaf.id, identity.nodeId);
    }

    if (matched.length) {
      logEvent('start', `Registered ${matched.length} claims (replicated via Hypercore to all peers)`);
    }
  } catch { /* topic tree not available yet */ }
}

// ── LLM health tracking ───────────────────────────────────────────────────────
// null = not yet validated, true = last call succeeded, false = key error
let llmHealthy: boolean | null = null;

if (isLLMConfigured()) {
  validateLLMKey(process.env.LLM_PROVIDER ?? 'ollama', process.env.LLM_API_KEY ?? '')
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

    // Sweep claims from dead BEEs so their topics are visible as uncovered
    // to the next `discoverObjective`. Without this, a crashed BEE held
    // topics hostage for CLAIM_TTL_MS = 30 minutes with no operator signal.
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
  if (!HAS_EXTRACTOR) return; // queen never extracts — it only indexes peer fragments
  if (extractionLoopRunning) return;
  // v0.6 made extraction LLM-free; bees no longer need an LLM key to crawl.
  // We still check for `hive` mode because the operator there may use the
  // same key for queries — but extraction itself runs without it.
  if (IS_HIVE && !isLLMConfigured()) {
    logEvent('start', 'LLM not configured — queries will fail, but extraction proceeds.');
  }
  if (!resolvedObjective) {
    try {
      resolvedObjective = await discoverObjective([], '', identity.nodeId, DATA_DIR, 3, claimRegistry, HIVE_TOPIC_DOMAIN || undefined);
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

if (HAS_EXTRACTOR) startExtractionIfReady();

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

  // Persist under the data volume (mounted) instead of /hive/.env (ephemeral).
  // Loaded automatically on next boot — see the RUNTIME_ENV_PATH loader at
  // the top of this file. Fixes the bug where UI-set provider was lost on
  // container recreate (v0.6.4.3).
  try {
    const fs = await import('node:fs/promises');
    let content = '';
    try { content = await fs.readFile(RUNTIME_ENV_PATH, 'utf8'); } catch { /* first write */ }
    content = upsertEnvLine(content, 'LLM_PROVIDER', provider);
    content = upsertEnvLine(content, 'LLM_API_KEY', apiKey.trim());
    if (model?.trim()) content = upsertEnvLine(content, 'LLM_MODEL', model.trim());
    await fs.writeFile(RUNTIME_ENV_PATH, content, 'utf8');
    await fs.chmod(RUNTIME_ENV_PATH, 0o600).catch(() => {});   // best-effort: don't expose API key
  } catch (e: any) {
    console.warn(`[config] Could not persist runtime override to ${RUNTIME_ENV_PATH}: ${e?.message ?? e}`);
  }

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
  console.log(`\n   HIVE  → v${HIVE_VERSION}`);
  console.log(`   Mode  → ${HIVE_MODE.toUpperCase()}`);
  console.log(`   API  → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   UI   → http://127.0.0.1:${PORT}/`);
  console.log(`   Peers → Hyperswarm discovery (no HTTP bootstrap since v0.6.4)`);
  if (HAS_QUERY_API) {
    const provider = process.env.LLM_PROVIDER ?? 'gemini';
    console.log(`   LLM  → ${provider} ${isLLMConfigured() ? '✓' : '(NOT SET)'}`);
  }
  if (HAS_LOCAL_EMBED) {
    console.log(`   Embedder → ${embedderUrl}`);
  }
  if (IS_QUEEN) {
    console.log(`   Qdrant → ${process.env.QDRANT_URL ?? 'http://localhost:6333'}`);
  }
  console.log();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// No HTTP announcement to a bootstrap peer since v0.6.4 — Hyperswarm
// discovery + the Protomux `hive/meta/v1` channel cover everything that
// /api/register-peer used to do.
