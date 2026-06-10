// LanceDB backend for VectorIndex (HIVE v0.8 default vector store).
// Embedded (in-process), disk-backed, Node-native. Dedup by an in-memory
// id → content_hash map loaded at ready() (P2P fragments are immutable →
// skip known ids; direct-mode ingest upserts by id via mergeInsert and uses
// the content_hash to count unchanged re-deliveries).
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
  /** id → content_hash of every stored fragment. */
  private known = new Map<string, string>();
  /** Tables created before v1.1 have no `meta` column; writes must match the
   *  on-disk schema, so we strip `meta` for them (logged once). */
  private hasMetaCol = true;
  private warnedNoMeta = false;
  constructor(private dir: string) {}

  async ready(): Promise<void> {
    this.db = await lancedb.connect(this.dir);
    const names = await this.db.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.db.openTable(TABLE);
      const schema = await this.table.schema();
      this.hasMetaCol = schema.fields.some((f: { name: string }) => f.name === 'meta');
      // Load id → content_hash for dedup + unchanged detection.
      const rows = await this.table.query().select(['id', 'content_hash']).toArray();
      for (const r of rows) this.known.set(r.id as string, (r.content_hash as string) ?? '');
      console.log(`[lance] opened '${TABLE}' — ${this.known.size} known ids${this.hasMetaCol ? '' : ' (pre-v1.1 schema: no meta column)'}`);
    } else {
      console.log(`[lance] table '${TABLE}' not created yet (will create on first upsert)`);
    }
  }

  has(id: string): boolean { return this.known.has(id); }

  /** Normalize records to the on-disk schema: meta is always a string column
   *  on tables that have it, and absent on tables that don't. */
  private toRows(records: IndexRecord[]): Record<string, unknown>[] {
    return records.map((r) => {
      const { meta, ...rest } = r;
      if (!this.hasMetaCol) {
        if (meta && !this.warnedNoMeta) {
          this.warnedNoMeta = true;
          console.warn(`[lance] dropping fragment meta: table '${TABLE}' predates the meta column (recreate the index to keep it)`);
        }
        return rest as unknown as Record<string, unknown>;
      }
      return { ...rest, meta: meta ?? '' } as Record<string, unknown>;
    });
  }

  async upsertBatch(records: IndexRecord[]): Promise<number> {
    const fresh = records.filter((r) => r.id && !this.known.has(r.id) && r.vector?.length === EMBEDDING_DIM);
    if (fresh.length === 0) return 0;
    if (!this.db) throw new Error('LanceVectorIndex not ready()');
    const data = this.toRows(fresh);
    if (!this.table) {
      this.table = await this.db.createTable(TABLE, data);
    } else {
      await this.table.add(data);
    }
    for (const r of fresh) this.known.set(r.id, r.content_hash);
    return fresh.length;
  }

  async mergeUpsertBatch(records: IndexRecord[]): Promise<{ upserted: number; unchanged: number }> {
    if (!this.db) throw new Error('LanceVectorIndex not ready()');
    const changed: IndexRecord[] = [];
    let unchanged = 0;
    for (const r of records) {
      if (!r.id || r.vector?.length !== EMBEDDING_DIM) continue;
      if (this.known.get(r.id) === r.content_hash) { unchanged++; continue; }
      changed.push(r);
    }
    if (changed.length > 0) {
      const data = this.toRows(changed);
      if (!this.table) {
        this.table = await this.db.createTable(TABLE, data);
      } else {
        await this.table
          .mergeInsert('id')
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(data);
      }
      for (const r of changed) this.known.set(r.id, r.content_hash);
    }
    return { upserted: changed.length, unchanged };
  }

  async search(vector: number[], k: number, filters?: SearchFilters): Promise<SearchHit[]> {
    if (!this.table) return [];
    // `search(vector)` returns a VectorQuery; distanceType isn't on the
    // Query|VectorQuery union type, so widen to call it.
    let q: any = (this.table.search(vector) as any).distanceType('cosine').limit(k);
    const where = whereClause(filters);
    if (where) q = q.where(where);
    const rows = (await q.toArray()) as Record<string, any>[];
    return rows.map((r: Record<string, any>) => {
      let meta: Record<string, unknown> | undefined;
      if (typeof r.meta === 'string' && r.meta.length > 0) {
        try { meta = JSON.parse(r.meta); } catch { /* opaque to core — return nothing */ }
      }
      return {
        id: r.id as string,
        score: 1 - (r._distance as number),   // cosine distance → similarity
        text: r.text as string,
        title: (r.title as string) ?? '',
        url: (r.url as string) ?? '',
        source: (r.source as string) ?? '',
        source_type: (r.source_type as string) ?? '',
        lang: (r.lang as string) ?? '',
        node_id: (r.node_id as string) ?? '',
        ...(meta ? { meta } : {}),
      };
    });
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
