/**
 * Standalone worker entrypoint (`npm run worker`).
 *
 * For production scale-out: run the web app with DISABLE_INLINE_WORKER=1 and
 * point both containers at the same REDIS_URL; this process consumes the
 * BullMQ queue. With the memory queue driver (no REDIS_URL) a standalone
 * worker cannot see jobs from the web process, so it exits with an error.
 */
import { config } from "@/server/config";
import { startWorker } from "@/server/worker-runner";
import { startCloneSweeper } from "@/server/clone-sweeper";
import { getStore } from "@/server/store";
import { logger } from "@/server/logger";

async function main() {
  const cfg = config();
  const log = logger();
  if (cfg.queueDriver !== "bullmq") {
    log.error("Standalone worker requires REDIS_URL (BullMQ queue driver).");
    process.exit(1);
  }
  await getStore();
  // A dedicated worker is the most likely victim of a hard restart, so make
  // sure it reclaims orphaned clones even if the inline worker never booted.
  startCloneSweeper();
  await startWorker();
  log.info({ driver: cfg.queueDriver }, "worker ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
