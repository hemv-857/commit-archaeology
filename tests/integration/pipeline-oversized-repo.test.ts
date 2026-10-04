import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixtures, FIXTURE_OWNER, FIXTURE_NAME } from "../fixtures/make-fixture-repos";

/**
 * Oversized repositories must be refused before any git process starts.
 *
 * A blobless clone of a multi-GB repo (vercel/next.js is 2.5 GB / 36k commits)
 * holds a worker slot until CLONE_TIMEOUT_MS and then fails in `git log` anyway.
 *
 * This file owns its own MAX_REPO_SIZE_KB: `config()` is a process-wide
 * singleton, so the cap must be in the environment *before* anything imports it.
 * The accept path (fixture at 12,000 KB vs the 500 MB default) is covered by
 * tests/integration/pipeline.test.ts.
 */
process.env.MAX_REPO_SIZE_KB = "1000";

let fixtureDir: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-toobig-"));
  await buildFixtures(fixtureDir);
  process.env.MOCK_GITHUB = "1";
  process.env.FIXTURE_REPO_DIR = path.join(fixtureDir, "repos");
  process.env.DATA_DIR = path.join(fixtureDir, "data");
  process.env.REDIS_URL = "";
  process.env.DATABASE_URL = "";
  process.env.OPENAI_API_KEY = "";
});

describe("oversized repo guard", () => {
  it("rejects before cloning, names the limit, and leaks no temp dir", async () => {
    const { runScan } = await import("@/server/pipeline");
    const { config, tmpRoot } = await import("@/server/config");

    // Precondition: the mock fixture really does report a size, otherwise the
    // guard would be skipped and this test would pass for the wrong reason.
    expect(config().maxRepoSizeKb).toBe(1000);

    const job = {
      id: "toobig-job",
      owner: FIXTURE_OWNER,
      name: FIXTURE_NAME,
      url: `https://github.com/${FIXTURE_OWNER}/${FIXTURE_NAME}`,
      status: "running" as const,
      progress: { stage: "queued" as const, pct: 0, message: "" },
      error: null,
      storyUrl: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };

    const stages: string[] = [];
    await expect(
      runScan(job, async (p) => {
        stages.push(p.stage);
      })
    ).rejects.toThrow(/too large to excavate/i);

    // It must fail at validate — never reaching clone.
    expect(stages).not.toContain("clone");
    expect(stages).not.toContain("history");

    const entries = await fs.readdir(tmpRoot).catch(() => [] as string[]);
    expect(entries.filter((e) => e.includes("toobig-job"))).toHaveLength(0);
  });
});