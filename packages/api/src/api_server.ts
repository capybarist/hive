import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';
import { KnowledgeStore, loadOrCreateIdentity, HiveP2PNode, SyncManager } from '@hive/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');

const PORT = Number(process.env.HIVE_PORT ?? 8080);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const DATA_DIR = resolve(process.env.HIVE_DATA_DIR ?? join(__dirname, '../../../data'));
const IDENTITY_DIR = join(DATA_DIR, 'identity');
const PEER_API = process.env.HIVE_PEER ?? '';

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
  // When a new peer joins Hyperswarm, also trigger a sync via HTTP
  if (peerApis.length) syncManager.syncOnce().catch(() => {});
});

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
  dataDir: DATA_DIR,
}));

// ── GET /api/peers ───────────────────────────────────────────────────────────
app.get('/api/peers', async () => ({
  peers: p2pNode.peers,
  peerApis,
}));

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

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\n   API  → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   UI   → http://127.0.0.1:${PORT}/`);
  console.log(`   Peer → ${PEER_API || '(no bootstrap peer)'}`);
  console.log(`   Gemini → ${GEMINI_KEY ? 'configured ✓' : 'NOT SET'}\n`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
