/**
 * Scan job queue. Two interchangeable drivers:
 *
 *  - "memory": in-process FIFO with bounded concurrency (default; dev and
 *    small single-node deployments). Progress flows over the in-memory bus.
 *  - "bullmq": Redis-backed, when REDIS_URL is set. Run `npm run worker`
 *    (src/worker.ts) in a separate container to scale scanning horizontally;
 *    progress crosses instances via the Redis pub/sub bus.
 */
import { randomUUID } from "node:crypto";
import type { ScanJob, ScanProgress } from "@/lib/types";
import { config } from "./config";
import { getStore } from "./store";
import { progressBus } from "./bus";

export type ScanHandler = (
  job: ScanJob,
  onProgress: (p: ScanProgress) => Promise<void>
) => Promise<void>;

export interface ScanQueue {
  readonly driver: "memory" | "bullmq";
  enqueue(input: { owner: string; name: string; url: string; ip?: string }): Promise<ScanJob>;
  getJob(id: string): Promise<ScanJob | null>;
  /** Register the handler that performs scans (worker side). */
  startWorker(handler: ScanHandler): Promise<void>;
  stats(): Promise<{ waiting: number; active: number }>;
  /** Scans currently running for one requester IP (memory driver only). */
  activeScansForIp(ip: string): number;
}

/* ------------------------------------------------------------------ */
/* Per-IP active scan tracking (memory driver)                        */
/* ------------------------------------------------------------------ */

/**
 * jobId -> ip for jobs currently running, so a client cannot occupy every
 * worker slot. Entries are removed in the queue's own `finally`, which is the
 * only place guaranteed to run for both success and failure.
 */
const activeByJob = new Map<string, string>();

export function activeScansForIp(ip: string): number {
  let n = 0;
  for (const owner of activeByJob.values()) if (owner === ip) n += 1;
  return n;
}

/* ------------------------------------------------------------------ */
/* Memory driver                                                       */
/* ------------------------------------------------------------------ */

interface MemoryState {
  handler: ScanHandler | null;
  waiting: ScanJob[];
  activeCount: number;
  jobs: Map<string, ScanJob>;
}

function memoryState(): MemoryState {
  const g = globalThis as { __ca_memQueue?: MemoryState };
  g.__ca_memQueue ??= { handler: null, waiting: [], activeCount: 0, jobs: new Map() };
  return g.__ca_memQueue;
}

async function jobSaved(job: ScanJob): Promise<void> {
  try {
    const s = await getStore();
    await s.saveJob(job);
  } catch {
    /* store best-effort */
  }
}

class MemoryQueue implements ScanQueue {
  readonly driver = "memory" as const;
  private readonly state = memoryState();
  private pumping = false;

  async enqueue(input: { owner: string; name: string; url: string; ip?: string }): Promise<ScanJob> {
    await ensureInlineWorker();
    const job: ScanJob = {
      id: randomUUID(),
      owner: input.owner,
      name: input.name,
      url: input.url,
      ip: input.ip,
      status: "queued",
      progress: { stage: "queued", pct: 0, message: "Queued" },
      error: null,
      storyUrl: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.state.jobs.set(job.id, job);
    this.state.waiting.push(job);
    await jobSaved(job);
    void this.pump();
    return job;
  }

  async getJob(id: string): Promise<ScanJob | null> {
    return this.state.jobs.get(id) ?? (await (await getStore()).getJob(id));
  }

  async startWorker(handler: ScanHandler): Promise<void> {
    this.state.handler = handler;
    void this.pump();
  }

  async stats(): Promise<{ waiting: number; active: number }> {
    return { waiting: this.state.waiting.length, active: this.state.activeCount };
  }

  activeScansForIp(ip: string): number {
    return activeScansForIp(ip);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const { config: cfg } = await import("./config");
    const concurrency = cfg().scanConcurrency;
    try {
      while (this.state.waiting.length > 0 && this.state.activeCount < concurrency) {
        const job = this.state.waiting.shift();
        if (!job || !this.state.handler) break;
        this.state.activeCount += 1;
        if (job.ip) activeByJob.set(job.id, job.ip);
        const bus = progressBus();
        void (async () => {
          try {
            job.status = "running";
            await jobSaved(job);
            await this.state.handler!(job, (p) => {
              job.progress = p;
              return Promise.all([
                bus.publish(job.id, p),
                p.stage === "done" || p.stage === "error"
                  ? Promise.resolve()
                  : Promise.resolve(),
              ]).then(() => undefined);
            });
          } catch (err) {
            job.status = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.finishedAt = new Date().toISOString();
            job.progress = { stage: "error", pct: 100, message: job.error };
            await jobSaved(job);
            await progressBus().publish(job.id, job.progress);
          } finally {
            this.state.activeCount -= 1;
            activeByJob.delete(job.id);
            // Persist final status if the handler did not already.
            const final = await this.getJob(job.id);
            if (final && final.status === "running") {
              final.status = "done";
              final.finishedAt = final.finishedAt ?? new Date().toISOString();
              await jobSaved(final);
            }
            void this.pump();
          }
        })();
      }
    } finally {
      this.pumping = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* BullMQ driver                                                       */
/* ------------------------------------------------------------------ */

class BullMQQueue implements ScanQueue {
  readonly driver = "bullmq" as const;
  private queue: import("bullmq").Queue | null = null;
  private worker: import("bullmq").Worker | null = null;

  async #ensureQueue() {
    if (this.queue) return this.queue;
    const { Queue } = await import("bullmq");
    this.queue = new Queue("scan", {
      connection: { url: config().redisUrl! },
    });
    return this.queue;
  }

  async enqueue(input: { owner: string; name: string; url: string; ip?: string }): Promise<ScanJob> {
    const queue = await this.#ensureQueue();
    const job: ScanJob = {
      id: randomUUID(),
      owner: input.owner,
      name: input.name,
      url: input.url,
      ip: input.ip,
      status: "queued",
      progress: { stage: "queued", pct: 0, message: "Queued" },
      error: null,
      storyUrl: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    await queue.add("scan", { job }, { jobId: job.id, removeOnComplete: 500, removeOnFail: 500 });
    const store = await getStore();
    await store.saveJob(job);
    return job;
  }

  async getJob(id: string): Promise<ScanJob | null> {
    const store = await getStore();
    return store.getJob(id);
  }

  async startWorker(handler: ScanHandler): Promise<void> {
    if (this.worker) return;
    const { Worker } = await import("bullmq");
    const bus = progressBus();
    const store = await getStore();
    this.worker = new Worker<{ job: ScanJob }>(
      "scan",
      async (bullJob) => {
        const job = bullJob.data.job;
        job.status = "running";
        await store.saveJob(job);
        try {
          await handler(job, (p) => {
            job.progress = p;
            return bus.publish(job.id, p);
          });
        } catch (err) {
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);
          job.finishedAt = new Date().toISOString();
          job.progress = { stage: "error", pct: 100, message: job.error };
          await store.saveJob(job);
          await bus.publish(job.id, job.progress);
          throw err;
        }
      },
      {
        connection: { url: config().redisUrl! },
        concurrency: config().scanConcurrency,
      }
    );
  }

  async stats(): Promise<{ waiting: number; active: number }> {
    try {
      const queue = await this.#ensureQueue();
      const [waiting, active] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
      ]);
      return { waiting, active };
    } catch {
      return { waiting: 0, active: 0 };
    }
  }

  /**
   * Jobs live in Redis here, so this process cannot see another instance's
   * active jobs. The per-IP rate limit remains the cross-instance guard.
   */
  activeScansForIp(): number {
    return 0;
  }
}

/* ------------------------------------------------------------------ */

let singleton: ScanQueue | null = null;

declare global {
  var __ca_queue: ScanQueue | undefined;
  var __ca_inlineWorker: Promise<void> | undefined;
}

/**
 * Boot the in-process worker on first use. Idempotent and awaited by
 * `enqueue`, so a job is never queued before a handler exists to drain it.
 *
 * Standalone workers (`npm run worker`) call `startWorker()` directly, and
 * scaled web deployments set DISABLE_INLINE_WORKER=1 so only the dedicated
 * worker containers consume the shared BullMQ queue.
 */
export function ensureInlineWorker(): Promise<void> {
  if (process.env.DISABLE_INLINE_WORKER === "1") return Promise.resolve();
  globalThis.__ca_inlineWorker ??= import("@/server/worker-runner").then((m) =>
    m.startWorker()
  );
  return globalThis.__ca_inlineWorker;
}

export function scanQueue(): ScanQueue {
  if (globalThis.__ca_queue) return globalThis.__ca_queue;
  singleton ??= config().queueDriver === "bullmq" ? new BullMQQueue() : new MemoryQueue();
  globalThis.__ca_queue = singleton;
  return singleton;
}
