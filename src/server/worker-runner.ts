/**
 * Worker runner: registers the scan handler on the active queue driver.
 * Used in two modes:
 *  - inline (default): started from instrumentation.ts inside the web process
 *  - standalone: `npm run worker` (src/worker.ts), for scaled-out deployments
 */
import { scanQueue } from "@/server/queue";
import { getStore } from "@/server/store";
import { runScan } from "@/server/pipeline";
import { progressBus } from "@/server/bus";
import { logger } from "@/server/logger";
import { config } from "@/server/config";
import { startCloneSweeper } from "@/server/clone-sweeper";

let started: Promise<void> | null = null;

declare global {
  var __ca_workerStarted: Promise<void> | undefined;
}

export function startWorker(): Promise<void> {
  globalThis.__ca_workerStarted ??= (started ??= doStart());
  return globalThis.__ca_workerStarted;
}

async function doStart(): Promise<void> {
  const cfg = config();
  const log = logger();
  const queue = scanQueue();
  const bus = progressBus();

  // Reclaim clone dirs left behind by a crash before accepting more work.
  startCloneSweeper();

  await queue.startWorker(async (job, onProgress) => {
    try {
      const story = await runScan(job, onProgress);
      const store = await getStore();
      await store.updateJob(job.id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        storyUrl: `/${story.repo.owner}/${story.repo.name}`,
        progress: { stage: "done", pct: 100, message: "Story ready." },
      });
      await bus.publish(job.id, { stage: "done", pct: 100, message: "Story ready." });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, jobId: job.id, repo: job.url }, "scan failed");
      const store = await getStore();
      await store.updateJob(job.id, {
        status: "failed",
        error: message,
        finishedAt: new Date().toISOString(),
        progress: { stage: "error", pct: 100, message },
      });
      await bus.publish(job.id, { stage: "error", pct: 100, message });
      throw err; // let BullMQ mark the job failed too
    }
  });

  log.info(
    { driver: queue.driver, concurrency: cfg.scanConcurrency, standalone: process.env.WORKER_STANDALONE === "1" },
    "scan worker started"
  );
}
