/**
 * CrawlQueue — persistent BFS queue of Wikipedia article titles to fetch.
 *
 * The autonomous extractor uses this to crawl Wikipedia indefinitely:
 * each indexed article emits its internal links into the queue, and on
 * each cycle the agent dequeues a batch and fetches them. Like a search
 * engine forager, with `topic_tree.json` as the initial seed.
 *
 * Storage model — deliberately simple, not Hypercore:
 *   - In-memory Set<string> of titles, ordered by insertion.
 *   - Backed by a JSONL file at /hive/data/crawl_queue.jsonl
 *   - Visited set in /hive/data/crawl_visited.jsonl (so we don't re-enqueue
 *     things we already indexed earlier)
 *   - On startup we read both files. On enqueue we append a line. On dequeue
 *     we rewrite the queue file (small, fast — queue typically <100k entries).
 *
 * Why not Hypercore: Hypercore is for source-of-truth content that must be
 * cryptographically signed and replicated to peers. The crawl queue is purely
 * local bookkeeping — losing it just means the bee re-discovers links from
 * scratch (cheap). Keeping it out of Hypercore avoids polluting the
 * replicated log with millions of "I plan to fetch this" rows.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface CrawlQueueOptions {
  dataDir: string;
  queueFile?: string;     // defaults to {dataDir}/crawl_queue.jsonl
  visitedFile?: string;   // defaults to {dataDir}/crawl_visited.jsonl
  maxQueueSize?: number;  // soft cap so memory doesn't grow unbounded
}

export class CrawlQueue {
  private queue: string[] = [];
  private inQueue = new Set<string>();
  private visited = new Set<string>();
  private queueFile: string;
  private visitedFile: string;
  private maxQueueSize: number;
  private dirty = false;

  constructor(opts: CrawlQueueOptions) {
    this.queueFile = opts.queueFile ?? path.join(opts.dataDir, 'crawl_queue.jsonl');
    this.visitedFile = opts.visitedFile ?? path.join(opts.dataDir, 'crawl_visited.jsonl');
    this.maxQueueSize = opts.maxQueueSize ?? 50_000;
  }

  async load(): Promise<void> {
    // Visited
    try {
      const v = await fs.readFile(this.visitedFile, 'utf8');
      for (const line of v.split('\n')) {
        const t = line.trim();
        if (t) this.visited.add(t);
      }
    } catch { /* file may not exist on first run */ }

    // Queue
    try {
      const q = await fs.readFile(this.queueFile, 'utf8');
      for (const line of q.split('\n')) {
        const t = line.trim();
        if (!t || this.visited.has(t) || this.inQueue.has(t)) continue;
        this.queue.push(t);
        this.inQueue.add(t);
      }
    } catch { /* file may not exist on first run */ }
  }

  size(): number { return this.queue.length; }
  visitedSize(): number { return this.visited.size; }

  /** Add a title to the queue if not already there or visited. */
  enqueue(title: string): boolean {
    const t = title.trim();
    if (!t || this.inQueue.has(t) || this.visited.has(t)) return false;
    if (this.queue.length >= this.maxQueueSize) return false;
    this.queue.push(t);
    this.inQueue.add(t);
    this.dirty = true;
    return true;
  }

  enqueueMany(titles: string[]): number {
    let added = 0;
    for (const t of titles) if (this.enqueue(t)) added++;
    return added;
  }

  /**
   * Take up to N titles from the head of the queue. The titles are removed
   * from the queue but NOT marked visited — call `markVisited(title)` after
   * a successful fetch. Failed fetches stay out of `visited` so a future
   * cycle can re-enqueue them via the normal link-discovery path.
   */
  dequeueBatch(n: number): string[] {
    const out: string[] = [];
    while (out.length < n && this.queue.length > 0) {
      const t = this.queue.shift()!;
      this.inQueue.delete(t);
      out.push(t);
    }
    if (out.length > 0) this.dirty = true;
    return out;
  }

  /** Mark a title visited without dequeuing — e.g. when it was processed via a different code path. */
  markVisited(title: string): void {
    const t = title.trim();
    if (!t || this.visited.has(t)) return;
    this.visited.add(t);
    if (this.inQueue.has(t)) {
      this.inQueue.delete(t);
      this.queue = this.queue.filter(x => x !== t);
    }
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    // Rewrite both files. Small/medium queues; rewrite is fine.
    await fs.mkdir(path.dirname(this.queueFile), { recursive: true });
    await fs.writeFile(this.queueFile, this.queue.map(s => s).join('\n') + (this.queue.length ? '\n' : ''));
    await fs.writeFile(this.visitedFile, [...this.visited].join('\n') + (this.visited.size ? '\n' : ''));
    this.dirty = false;
  }

  summary(): { queue: number; visited: number } {
    return { queue: this.queue.length, visited: this.visited.size };
  }
}
