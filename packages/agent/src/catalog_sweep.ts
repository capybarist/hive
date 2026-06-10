// HIVE direct mode — catalog sweep loop (docs/direct-mode.md §4).
//
// For CatalogSources the corpus is enumerable, so extraction is a SWEEP, not
// a crawl: walk the catalog (full on first run, changedSince() after),
// re-fetch each entry, and use content_hash to decide whether anything
// downstream (chunk → embed → sign → deliver) needs to run at all. Unchanged
// documents cost one fetch and zero embeds — incremental sweeps are nearly
// free.
//
// The bee persists its inventory (sourceId → content_hash) per source in a
// JSON file under the data dir (same pattern as CrawlQueue), which is what
// makes completeness verifiable: after a full sweep, diff(catalog ids,
// inventory ids) must be empty — anything left over is reported as missing.
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { contentHash } from '@hive/core';
import type { CatalogSource, VerbatimFragment } from './forager/source.js';

interface CatalogInventoryFile {
  /** ISO timestamp of the last COMPLETED sweep (start time, so documents that
   *  change mid-sweep are caught by the next changedSince()). */
  last_sweep?: string;
  /** sourceId → content_hash of the document's full verbatim text. */
  docs: Record<string, string>;
}

export class CatalogInventory {
  private data: CatalogInventoryFile = { docs: {} };
  private readonly path: string;

  constructor(dataDir: string, sourceId: string) {
    // sourceIds are registry ids (e.g. 'boe', 'eur-lex') — slug defensively.
    const slug = sourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.path = resolve(dataDir, `catalog_inventory_${slug}.json`);
  }

  async load(): Promise<void> {
    try {
      this.data = JSON.parse(await fs.readFile(this.path, 'utf8')) as CatalogInventoryFile;
      this.data.docs ??= {};
    } catch { /* first sweep — empty inventory */ }
  }

  get lastSweep(): Date | null { return this.data.last_sweep ? new Date(this.data.last_sweep) : null; }
  hashFor(sourceId: string): string | undefined { return this.data.docs[sourceId]; }
  record(sourceId: string, hash: string): void { this.data.docs[sourceId] = hash; }
  ids(): string[] { return Object.keys(this.data.docs); }
  markSweepComplete(startedAt: Date): void { this.data.last_sweep = startedAt.toISOString(); }

  async flush(): Promise<void> {
    try {
      await fs.writeFile(this.path, JSON.stringify(this.data), 'utf8');
    } catch (e: any) {
      console.warn(`[catalog] inventory persist failed (${this.path}): ${e?.message ?? e}`);
    }
  }
}

export interface SweepSummary {
  new: number;
  changed: number;
  unchanged: number;
  errors: number;
  /** Catalog ids absent from the inventory after a FULL sweep (must be empty). */
  missing: string[];
  /** False when the budget ran out mid-sweep (last_sweep is NOT advanced). */
  complete: boolean;
}

export async function runCatalogSweep(
  source: CatalogSource,
  inventory: CatalogInventory,
  /** Called for every fragment of a new/changed document — the bridge into
   *  the chunk → embed → sign → publish pipeline. The caller must NOT apply
   *  the TTL freshness skip here: content_hash already decided this document
   *  changed, and the TTL check would veto legitimate updates. */
  onVerbatim: (vf: VerbatimFragment) => Promise<void>,
  opts: { budgetExhausted?: () => boolean } = {},
): Promise<SweepSummary> {
  const startedAt = new Date();
  const last = inventory.lastSweep;
  const incremental = last !== null;
  const entries = incremental ? source.changedSince(last) : source.listAll();
  const summary: SweepSummary = { new: 0, changed: 0, unchanged: 0, errors: 0, missing: [], complete: true };
  const seenIds: string[] = [];

  console.log(`  [catalog:${source.id}] ${incremental ? `incremental sweep (changed since ${last.toISOString()})` : 'full sweep'} starting`);

  for await (const entry of entries) {
    if (opts.budgetExhausted?.()) { summary.complete = false; break; }
    seenIds.push(entry.sourceId);
    try {
      const result = await source.fetchEntry(entry);
      const docText = result.fragments.map((f) => f.text).join('\n');
      const hash = contentHash(docText);
      const prev = inventory.hashFor(entry.sourceId);
      if (prev === hash) { summary.unchanged++; continue; }
      for (const vf of result.fragments) await onVerbatim(vf);
      inventory.record(entry.sourceId, hash);
      if (prev === undefined) summary.new++; else summary.changed++;
    } catch (e: any) {
      summary.errors++;
      console.warn(`  [catalog:${source.id}] entry failed ${entry.sourceId} (${entry.url}): ${e?.message ?? e}`);
    }
  }

  // Completeness check — only meaningful after a full enumeration.
  if (summary.complete && !incremental) {
    const inv = new Set(inventory.ids());
    summary.missing = seenIds.filter((id) => !inv.has(id));
    if (summary.missing.length > 0) {
      console.warn(`  [catalog:${source.id}] completeness check FAILED — ${summary.missing.length} catalog id(s) not in inventory: ${summary.missing.slice(0, 10).join(', ')}${summary.missing.length > 10 ? ', …' : ''}`);
    }
  }

  if (summary.complete) inventory.markSweepComplete(startedAt);
  await inventory.flush();

  console.log(`  [catalog:${source.id}] sweep ${summary.complete ? 'complete' : 'PARTIAL (budget)'}: ${summary.new} new · ${summary.changed} changed · ${summary.unchanged} unchanged · ${summary.errors} errors`);
  return summary;
}
