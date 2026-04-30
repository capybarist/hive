import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { queryByText, getEmbedderStatus } from './query_engine.js';
import { synthesize } from './llm_client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '../../ui');
const PORT = 8080;

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });
await app.register(staticPlugin, { root: UI_DIR, prefix: '/' });

// ── POST /api/query ─────────────────────────────────────────────────────────
app.post<{
  Body: { question: string; top_k?: number; use_llm?: boolean };
}>('/api/query', async (req, reply) => {
  const { question, top_k = 5, use_llm = true } = req.body;
  if (!question?.trim()) return reply.code(400).send({ error: 'question required' });

  const { fragments, has_hive_data, embedder_online } = await queryByText(question, top_k);

  if (!use_llm) return { fragments, has_hive_data, embedder_online, answer: null, mode: 'raw' };

  if (!GEMINI_KEY) {
    return reply.code(503).send({
      error: 'GEMINI_API_KEY not configured on server. Add it to .env',
    });
  }

  try {
    const { answer, mode } = await synthesize(question, fragments, GEMINI_KEY);
    return { answer, mode, fragments, has_hive_data, embedder_online };
  } catch (err: any) {
    return reply.code(502).send({ error: err.message });
  }
});

// ── GET /api/status ──────────────────────────────────────────────────────────
app.get('/api/status', async () => {
  const embedder = await getEmbedderStatus();
  return {
    api: 'ok',
    embedder_online: embedder !== null,
    indexed: embedder?.indexed ?? 0,
    model: embedder?.model ?? null,
    gemini_configured: Boolean(GEMINI_KEY),
  };
});

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\n🐝 H.I.V.E API running → http://127.0.0.1:${PORT}`);
  console.log(`   UI     → http://127.0.0.1:${PORT}/`);
  console.log(`   Status → http://127.0.0.1:${PORT}/api/status`);
  console.log(`   Gemini → ${GEMINI_KEY ? 'configured ✓' : 'NOT SET — add GEMINI_API_KEY to .env'}\n`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
