/**
 * Reclaims clone directories orphaned by a crash.
 *
 * `cloneRepo` cleans up in a `finally`, but a SIGKILL, OOM or deploy mid-scan
 * skips that. On a persistent volume those directories accumulate forever and
 * eventually fill the disk. This sweeps anything older than a scan can
 * legitimately take.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpRoot, config } from "@/server/config";
import { logger } from "@/server/logger";

/** A scan can legitimately run for cloneTimeout + git log timeout. */
export function orphanAgeMs(): number {
  return config().cloneTimeoutMs * 3;
}

export interface SweepResult {
  removed: string[];
  bytesFreed: number;
}

/**
 * Removes clone dirs older than `maxAgeMs`. Directories are named
 * `scan-<jobId>`; anything else is left alone so we never delete a directory we
 * do not own.
 */
export async function sweepOrphanClones(
  root: string = tmpRoot,
  maxAgeMs: number = orphanAgeMs(),
  now: number = Date.now()
): Promise<SweepResult> {
  const removed: string[] = [];
  let bytesFreed = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { removed, bytesFreed }; // nothing has ever been cloned
  }

  for (const name of entries) {
    if (!name.startsWith("scan-")) continue;
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue; // possibly still in flight
      const size = await dirSize(dir);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(name);
      bytesFreed += size;
    } catch {
      /* raced with cleanup, or unreadable — skip it */
    }
  }

  if (removed.length > 0) {
    logger().warn(
      { root, removed: removed.length, mb: Math.round(bytesFreed / 1024 / 1024) },
      "swept orphaned clone directories"
    );
  }
  return { removed, bytesFreed };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) await walk(child);
      else {
        try {
          total += (await fs.stat(child)).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

declare global {
  var __ca_sweeper: ReturnType<typeof setInterval> | undefined;
}

/** Boot sweep + recurring sweep. Idempotent; returns a stop function. */
export function startCloneSweeper(intervalMs = 10 * 60_000): () => void {
  if (globalThis.__ca_sweeper) return () => clearInterval(globalThis.__ca_sweeper);
  void sweepOrphanClones().catch(() => {});
  const timer = setInterval(() => {
    void sweepOrphanClones().catch(() => {});
  }, intervalMs);
  // Never hold the process open just for the sweeper.
  timer.unref?.();
  globalThis.__ca_sweeper = timer;
  return () => clearInterval(timer);
}