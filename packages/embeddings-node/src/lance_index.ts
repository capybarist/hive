// LanceDB backend for VectorIndex (HIVE v0.8 default vector store).
// Embedded (in-process), disk-backed, Node-native. Dedup by an in-memory
// known-ids set loaded at ready() (fragments are immutable → skip known).
import * as lancedb from '@lancedb/lancedb';
import type { IndexRecord, SearchFilters, SearchHit, VectorIndex } from './vector_index.js';
import { EMBEDDING_DIM } from './schema.js';

const TABLE = 'fragments';

function escapeSql(v: string): string { return v.replace(/'/g, "''"); }

function whereClause(f?: SearchFilters): string | null {
  if (!f) return null;
  const parts: string[] = [];
  if (f.lang) parts.push(`lang = '${escapeSql(f.lang)}'`);
  if (f.source_type) parts.push(`source_type = '${escapeSql(f.source_type)}'`);
  if (f.node_id) parts.push(`node_id = '${escapeSql(f.node_id)}'`);
  if (f.status) parts.push(`status = '${escapeSql(f.status)}'`);
  return parts.length ? parts.join(' AND ') : null;
}

export class LanceVectorIndex implements VectorIndex {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private known = new Set<string>();
  constructor(private dir: string) {}

  async ready(): Promise<void> {
    this.db = await lancedb.connect(this.dir);
    const names = await this.db.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.db.openTable(TABLE);
      // Load known ids for dedup (parity with the v0.7 qdrant _known_ids set).
      const rows = await this.table.query().select(['id']).toArray();
      for (const r of rows) this.known.add(r.id as string);
      console.log(`[lance] opened '${TABLE}' — ${this.known.size} known ids`);
    } else {
      console.log(`[lance] table '${TABLE}' not created yet (will create on first upsert)`);
    }
  }

  has(id: string): boolean { return this.known.has(id); }

  async upsertBatch(records: IndexRecord[]): Promise<number> {
    const fresh = records.filter((r) => r.id && !this.known.has(r.id) && r.vector?.length === EMBEDDING_DIM);
    if (fresh.length === 0) return 0;
    if (!this.db) throw new Error('LanceVectorIndex not ready()');
    const data = fresh as unknown as Record<string, unknown>[];
    if (!this.table) {
      this.table = await this.db.createTable(TABLE, data);
    } else {
      await this.table.add(data);
    }
    for (const r of fresh) this.known.add(r.id);
    return fresh.length;
  }

  async search(vector: number[], k: number, filters?: SearchFilters): Promise<SearchHit[]> {
    if (!this.table) return [];
    // `search(vector)` returns a VectorQuery; distanceType isn't on the
    // Query|VectorQuery union type, so widen to call it.
    let q: any = (this.table.search(vector) as any).distanceType('cosine').limit(k);
    const where = whereClause(filters);
    if (where) q = q.where(where);
    const rows = (await q.toArray()) as Record<string, any>[];
    return rows.map((r: Record<string, any>) => ({
      id: r.id as string,
      score: 1 - (r._distance as number),   // cosine distance → similarity
      text: r.text as string,
      title: (r.title as string) ?? '',
      url: (r.url as string) ?? '',
      source: (r.source as string) ?? '',
      source_type: (r.source_type as string) ?? '',
      lang: (r.lang as string) ?? '',
      node_id: (r.node_id as string) ?? '',
    }));
  }

  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  async optimize(keepMs: number): Promise<void> {
    if (!this.table) return;
    const cleanupOlderThan = new Date(Date.now() - Math.max(0, keepMs));
    await this.table.optimize({ cleanupOlderThan });
  }

  async countByNode(nodeIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (!this.table) { for (const n of nodeIds) out[n] = 0; return out; }
    for (const n of nodeIds) {
      out[n] = await this.table.countRows(`node_id = '${escapeSql(n)}'`);
    }
    return out;
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null;
  }
}
