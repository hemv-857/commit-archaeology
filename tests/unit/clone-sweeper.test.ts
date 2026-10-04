import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepOrphanClones, orphanAgeMs } from "@/server/clone-sweeper";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ca-sweeper-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Creates scan-<id>/repo.git with a file of `bytes` size. */
async function makeClone(jobId: string, bytes = 64): Promise<string> {
  const dir = path.join(root, `scan-${jobId}`);
  await fs.mkdir(path.join(dir, "repo.git"), { recursive: true });
  await fs.writeFile(path.join(dir, "repo.git", "pack"), Buffer.alloc(bytes));
  return dir;
}

async function age(dir: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await fs.utimes(dir, when, when);
}

describe("sweepOrphanClones", () => {
  it("removes a clone older than the threshold and reports bytes freed", async () => {
    const dir = await makeClone("old-job", 2048);
    await age(dir, 60 * 60_000); // 1 hour old

    const result = await sweepOrphanClones(root, 30 * 60_000);
    expect(result.removed).toEqual(["scan-old-job"]);
    expect(result.bytesFreed).toBeGreaterThan(0);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("never touches a clone young enough to be in flight", async () => {
    const dir = await makeClone("live-job");
    // Fresh: a scan that just started looks exactly like this.
    const result = await sweepOrphanClones(root, 30 * 60_000);
    expect(result.removed).toEqual([]);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("only deletes directories it owns (scan- prefix)", async () => {
    const foreign = path.join(root, "important-stuff");
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, "data.txt"), "precious");
    await age(foreign, 60 * 60_000);

    await makeClone("stale-job");
    await age(path.join(root, "scan-stale-job"), 60 * 60_000);

    const result = await sweepOrphanClones(root, 30 * 60_000);
    expect(result.removed).toEqual(["scan-stale-job"]);
    // The unrelated directory survived despite being old.
    await expect(fs.readFile(path.join(foreign, "data.txt"), "utf8")).resolves.toBe(
      "precious"
    );
  });

  it("ignores loose files and symlink-ish entries", async () => {
    await fs.writeFile(path.join(root, "scan-not-a-dir"), "file, not a directory");
    await age(path.join(root, "scan-not-a-dir"), 60 * 60_000);

    const result = await sweepOrphanClones(root, 30 * 60_000);
    expect(result.removed).toEqual([]);
    await expect(
      fs.readFile(path.join(root, "scan-not-a-dir"), "utf8")
    ).resolves.toBe("file, not a directory");
  });

  it("is a no-op when the root does not exist", async () => {
    const result = await sweepOrphanClones(path.join(root, "never-created"), 1000);
    expect(result).toEqual({ removed: [], bytesFreed: 0 });
  });

  it("is idempotent — a second sweep finds nothing left", async () => {
    await makeClone("a");
    await makeClone("b");
    await age(path.join(root, "scan-a"), 60 * 60_000);
    await age(path.join(root, "scan-b"), 60 * 60_000);

    const first = await sweepOrphanClones(root, 30 * 60_000);
    expect(first.removed.sort()).toEqual(["scan-a", "scan-b"]);

    const second = await sweepOrphanClones(root, 30 * 60_000);
    expect(second.removed).toEqual([]);
  });
});

describe("orphanAgeMs", () => {
  it("exceeds a single clone timeout so in-flight scans are safe", async () => {
    const { config } = await import("@/server/config");
    expect(orphanAgeMs()).toBeGreaterThan(config().cloneTimeoutMs);
  });
});