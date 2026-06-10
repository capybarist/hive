// Direct mode test suite (docs/direct-mode.md §5).
// Run: npx tsx src/test_direct_mode.ts
//
// Covers, offline (no network beyond 127.0.0.1, no ONNX model — vectors are
// deterministic fakes; signatures and the pipeline don't care what the floats
// are, only that they're signed inline):
//   · unit: deterministic ids/chunking, signature verify (happy + tampered +
//     unknown bee), meta is inside the signed payload
//   · ingest contract: 401 / 403 / whole-batch 400 atomicity / gzip / >500
//   · idempotency: same batch twice → unchanged == batch.length, row count stable
//   · E2E: fixture CatalogSource (3 docs) → DirectTransport over real HTTP →
//     queen LanceDB; incremental sweep skips unchanged; changed doc updates
//     in place (mergeInsert) without growing the row count; vector search
//     returns the ingested fragments with meta intact.
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import {
  loadOrCreateIdentity, buildSignedFragmentV08, verifyFragmentV08,
  type FragmentV08, type FragmentV08Input, type NodeIdentity,
} from '@hive/core';
import { QueenIndex, LanceVectorIndex, chunkDocument, encodeVector } from '@hive/embeddings-node';
import {
  DirectTransport, CatalogInventory, runCatalogSweep, isCatalogSource,
  type CatalogSource, type CatalogEntry, type FetchResult, type VerbatimFragment,
} from '@hive/agent';
import { registerIngestRoute, parseTrustedBees, MAX_INGEST_BATCH } from './ingest.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const tmp = (label: string) => mkdtempSync(join(tmpdir(), `hive-direct-${label}-`));

// Deterministic fake embedding: same text → same 768-d vector. Stands in for
// the e5 model so the suite runs with no model download; the signed-inline-
// vector invariant is what's under test, not embedding quality.
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(768);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  for (let i = 0; i < 768; i++) { h = Math.imul(h ^ (h >>> 15), 2246822519); v[i] = ((h >>> 0) / 0xffffffff) - 0.5; }
  // L2-normalize so cosine distances behave.
  let norm = 0; for (let i = 0; i < 768; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 768; i++) v[i] = v[i]! / norm;
  return v;
}

function buildFragment(identity: NodeIdentity, id: string, text: string, meta?: Record<string, unknown>): FragmentV08 {
  const input: FragmentV08Input = {
    id,
    node_id: identity.nodeId,
    node_pubkey: identity.publicKeyHex,
    text,
    lang: 'en',
    title: id,
    source: 'fixture-catalog',
    source_type: 'custom',
    url: `https://fixture.test/${id}`,
    retrieved_at: '2026-06-10T00:00:00.000Z',
    extracted_at: new Date().toISOString(),
    confidence: 0.9,
    meta,
  };
  return buildSignedFragmentV08(input, encodeVector(fakeEmbed(text)), identity);
}

// ── Fixture CatalogSource — 3 documents, fully in-memory ────────────────────
class FixtureCatalog implements CatalogSource {
  readonly id = 'fixture-catalog';
  readonly displayName = 'Fixture Catalog';
  readonly licence = 'CC0-1.0';
  docs = new Map<string, { text: string; lastModified: string }>([
    ['doc-a', { text: 'Article 1. Direct mode delivers signed fragments over HTTP.', lastModified: '2026-06-01' }],
    ['doc-b', { text: 'Article 2. Verifiability rides on the ed25519 signature, not the transport.', lastModified: '2026-06-02' }],
    ['doc-c', { text: 'Article 3. Deterministic fragment ids make retries idempotent.', lastModified: '2026-06-03' }],
  ]);

  describe() {
    return {
      id: this.id, displayName: this.displayName, icon: '🗂️', kind: 'catalog' as const,
      sourceType: 'custom', defaultLanguages: ['en'], scope: null,
    };
  }
  async *listAll(): AsyncIterable<CatalogEntry> {
    for (const [sourceId, d] of this.docs) yield { sourceId, url: `https://fixture.test/${sourceId}`, lastModified: d.lastModified };
  }
  async *changedSince(date: Date): AsyncIterable<CatalogEntry> {
    for (const [sourceId, d] of this.docs) {
      // Inclusive (>=): a doc modified the same instant the last sweep started
      // must not slip through. Over-reporting is free — content_hash skips it.
      if (new Date(d.lastModified) >= date) yield { sourceId, url: `https://fixture.test/${sourceId}`, lastModified: d.lastModified };
    }
  }
  async fetchEntry(entry: CatalogEntry): Promise<FetchResult> {
    const d = this.docs.get(entry.sourceId);
    if (!d) throw new Error(`no such doc ${entry.sourceId}`);
    const vf: VerbatimFragment = {
      id: entry.sourceId, text: d.text, source: entry.url, title: entry.sourceId,
      doi: null, confidence: 0.9, meta: { anchor: `art-${entry.sourceId}`, valid_from: d.lastModified },
    };
    return { fragments: [vf], outboundLinks: [], refreshPolicy: { ttlSeconds: 3600 } };
  }
  normalize(url: string): string { return url; }
  owns(url: string): boolean { return url.startsWith('https://fixture.test/'); }
  async seed(): Promise<string[]> { return []; }
  async fetch(url: string): Promise<FetchResult> { return this.fetchEntry({ sourceId: url.split('/').pop()!, url }); }
  partitions(): string[] { return ['*']; }
}

async function main(): Promise<void> {
  const beeIdentity = loadOrCreateIdentity(tmp('bee-id'));
  const strangerIdentity = loadOrCreateIdentity(tmp('stranger-id'));

  // ── 1. Unit: determinism + signatures ──────────────────────────────────
  console.log('\n[1] determinism + signature verification');
  {
    const sections = [{ heading_path: ['T'], text: 'Some section text for chunking determinism. '.repeat(10) }];
    const a = chunkDocument(sections); const b = chunkDocument(sections);
    ok(JSON.stringify(a) === JSON.stringify(b), 'chunkDocument is deterministic (same input → same chunks/ids)');

    const f1 = buildFragment(beeIdentity, 'doc-x_c0', 'hello world', { anchor: 'a1' });
    const f2 = buildFragment(beeIdentity, 'doc-x_c0', 'hello world', { anchor: 'a1' });
    ok(f1.id === f2.id && f1.content_hash === f2.content_hash, 'same source unit → same id + content_hash (idempotency invariant)');
    ok(verifyFragmentV08(f1, beeIdentity.publicKeyHex), 'signature verifies against the signer pubkey');
    ok(!verifyFragmentV08(f1, strangerIdentity.publicKeyHex), 'signature does NOT verify against an unknown bee pubkey');
    const tampered = { ...f1, text: 'hello world!' };
    ok(!verifyFragmentV08(tampered, beeIdentity.publicKeyHex), 'tampered text breaks verification');
    const metaTampered = { ...f1, meta: { anchor: 'a2' } };
    ok(!verifyFragmentV08(metaTampered, beeIdentity.publicKeyHex), 'meta sits inside the signed payload (tampered meta breaks verification)');
  }

  // ── 2. Ingest endpoint contract ─────────────────────────────────────────
  console.log('\n[2] /internal/ingest contract');
  const queenDir = tmp('queen');
  const queenIndex = new QueenIndex(queenDir);
  await queenIndex.ready();
  const app = Fastify({ logger: false });
  registerIngestRoute(app, queenIndex, {
    token: 'test-secret',
    trustedBees: parseTrustedBees(`${beeIdentity.nodeId}:${beeIdentity.publicKeyHex}`),
  });

  const batch = [
    buildFragment(beeIdentity, 'doc-1_c0', 'First test document body.', { anchor: 'art-1' }),
    buildFragment(beeIdentity, 'doc-2_c0', 'Second test document body.'),
    buildFragment(beeIdentity, 'doc-3_c0', 'Third test document body.'),
  ];
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/internal/ingest', headers: { 'content-type': 'application/json', ...headers }, payload: payload as any });

  {
    const r = await post({ bee_id: beeIdentity.nodeId, batch });
    ok(r.statusCode === 401, `missing token → 401 (got ${r.statusCode})`);
    const r2 = await post({ bee_id: beeIdentity.nodeId, batch }, { authorization: 'Bearer wrong' });
    ok(r2.statusCode === 401, `wrong token → 401 (got ${r2.statusCode})`);
    const r3 = await post({ bee_id: 'unknown-bee', batch }, { authorization: 'Bearer test-secret' });
    ok(r3.statusCode === 403, `unknown bee_id → 403 (got ${r3.statusCode})`);

    // Whole-batch atomicity: one tampered fragment poisons the batch.
    const poisoned = [batch[0]!, { ...batch[1]!, text: 'tampered!!' }, batch[2]!];
    const r4 = await post({ bee_id: beeIdentity.nodeId, batch: poisoned }, { authorization: 'Bearer test-secret' });
    const body4 = r4.json() as { rejected: string[]; reason: string };
    ok(r4.statusCode === 400, `tampered fragment → whole batch 400 (got ${r4.statusCode})`);
    ok(Array.isArray(body4.rejected) && body4.rejected.length === 1 && body4.rejected[0] === 'doc-2_c0', 'response names the rejected fragment ids');
    ok((await queenIndex.count()) === 0, 'atomicity: nothing from a rejected batch reaches LanceDB');

    const r5 = await post({ bee_id: beeIdentity.nodeId, batch: new Array(MAX_INGEST_BATCH + 1).fill(batch[0]) }, { authorization: 'Bearer test-secret' });
    ok(r5.statusCode === 400, `batch > ${MAX_INGEST_BATCH} → 400 (got ${r5.statusCode})`);

    // Happy path + gzip.
    const gz = gzipSync(Buffer.from(JSON.stringify({ bee_id: beeIdentity.nodeId, batch }), 'utf8'));
    const r6 = await post(gz, { authorization: 'Bearer test-secret', 'content-encoding': 'gzip' });
    const body6 = r6.json() as { upserted: number; unchanged: number };
    ok(r6.statusCode === 200, `gzip batch accepted → 200 (got ${r6.statusCode}: ${r6.body.slice(0, 120)})`);
    ok(body6.upserted === 3 && body6.unchanged === 0, `first delivery: upserted=3 unchanged=0 (got ${JSON.stringify(body6)})`);

    // Idempotency: identical re-delivery is a no-op.
    const r7 = await post({ bee_id: beeIdentity.nodeId, batch }, { authorization: 'Bearer test-secret' });
    const body7 = r7.json() as { upserted: number; unchanged: number };
    ok(body7.unchanged === batch.length && body7.upserted === 0, `re-ingest same batch: unchanged == batch.length (got ${JSON.stringify(body7)})`);
    ok((await queenIndex.count()) === 3, 'row count stable after double delivery');
  }

  // ── 3. E2E: fixture catalog → DirectTransport → queen over real HTTP ────
  console.log('\n[3] E2E direct sweep (fixture CatalogSource, localhost only)');
  {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const beeDir = tmp('bee-data');
    const transport = new DirectTransport({
      queenUrl: `http://127.0.0.1:${port}`,
      token: 'test-secret',
      beeId: beeIdentity.nodeId,
      dataDir: beeDir,
      maxAttempts: 2,
    });
    await transport.ready();

    const catalog = new FixtureCatalog();
    ok(isCatalogSource(catalog), 'fixture satisfies isCatalogSource()');
    const inventory = new CatalogInventory(beeDir, catalog.id);
    await inventory.load();

    // The chunk → embed(fake) → sign → save pipeline, as the extractor runs it.
    const publish = async (vf: VerbatimFragment) => {
      const chunks = chunkDocument([{ heading_path: vf.title ? [vf.title] : [], text: vf.text }]);
      for (const ch of chunks) {
        const chunkId = chunks.length > 1 ? `${vf.id}_c${ch.chunk_index}` : vf.id;
        await transport.save(buildFragment(beeIdentity, chunkId, ch.text, vf.meta));
      }
    };

    const countBefore = await queenIndex.count();
    const sweep1 = await runCatalogSweep(catalog, inventory, publish);
    await transport.flush();
    ok(sweep1.new === 3 && sweep1.changed === 0 && sweep1.errors === 0 && sweep1.complete, `full sweep: 3 new (got ${JSON.stringify(sweep1)})`);
    ok(sweep1.missing.length === 0, 'completeness check: diff(catalog ids, inventory ids) is empty');
    const countAfter = await queenIndex.count();
    ok(countAfter === countBefore + 3, `queen indexed the 3 fixture docs (rows ${countBefore} → ${countAfter})`);
    ok(transport.localFragmentCount === 3, 'bee inventory recorded 3 delivered fragments');

    // Incremental sweep: nothing changed → everything skipped via changedSince.
    const sweep2 = await runCatalogSweep(catalog, inventory, publish);
    await transport.flush();
    ok(sweep2.new === 0 && sweep2.changed === 0, `incremental sweep with no changes is a no-op (got ${JSON.stringify(sweep2)})`);

    // Change one document → re-delivered + updated IN PLACE (mergeInsert).
    catalog.docs.set('doc-b', { text: 'Article 2 (amended). The transport never carried the guarantee.', lastModified: new Date().toISOString() });
    const sweep3 = await runCatalogSweep(catalog, inventory, publish);
    await transport.flush();
    ok(sweep3.changed === 1 && sweep3.new === 0, `changed doc detected by content_hash (got ${JSON.stringify(sweep3)})`);
    ok((await queenIndex.count()) === countAfter, 'update replaced the row — count did not grow');

    // Queen-side vector search returns the ingested fragment, meta intact.
    const idx = new LanceVectorIndex(queenDir);
    await idx.ready();
    const hits = await idx.search(Array.from(fakeEmbed('Article 2 (amended). The transport never carried the guarantee.')), 3);
    ok(hits.length > 0 && hits[0]!.id === 'doc-b', `vector search returns the updated fragment (top hit: ${hits[0]?.id})`);
    ok(hits[0]!.text.includes('amended'), 'stored text is the updated version');
    ok((hits[0]!.meta as any)?.anchor === 'art-doc-b', `meta round-trips verbatim through ingest + LanceDB (got ${JSON.stringify(hits[0]!.meta)})`);

    await app.close();
  }

  console.log(`\n══ direct-mode suite: ${pass} passed, ${fail} failed ══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
