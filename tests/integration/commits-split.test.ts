import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixtures, FIXTURE_OWNER, FIXTURE_NAME } from "../fixtures/make-fixture-repos";

/**
 * Commits are stored outside the story document and served by their own route
 * (SCHEMA_VERSION 2). These exercise the store half; the HTTP half is covered
 * by tests/e2e/audit.spec.ts.
 */
let fixtureDir: string;
let headSha: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-commits-"));
  await buildFixtures(fixtureDir);
  process.env.MOCK_GITHUB = "1";
  process.env.FIXTURE_REPO_DIR = path.join(fixtureDir, "repos");
  process.env.DATA_DIR = path.join(fixtureDir, "data");
  process.env.REDIS_URL = "";
  process.env.DATABASE_URL = "";
  process.env.OPENAI_API_KEY = "";

  const { runScan } = await import("@/server/pipeline");
  const story = await runScan(
    {
      id: "commits-job",
      owner: FIXTURE_OWNER,
      name: FIXTURE_NAME,
      url: `https://github.com/${FIXTURE_OWNER}/${FIXTURE_NAME}`,
      status: "running" as const,
      progress: { stage: "queued" as const, pct: 0, message: "" },
      error: null,
      storyUrl: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    },
    async () => {}
  );
  headSha = story.repo.headSha;
}, 120_000);

describe("commits are stored beside the story, not inside it", () => {
  it("the story document carries no commits array", async () => {
    const { getStore } = await import("@/server/store");
    const stored = await (await getStore()).getStory(FIXTURE_OWNER, FIXTURE_NAME);
    expect(stored?.story.schemaVersion).toBe(2);
    expect(stored?.story).not.toHaveProperty("commits");
  });

  it("commits are retrievable for the analysed HEAD", async () => {
    const { getStore } = await import("@/server/store");
    const commits = await (await getStore()).getCommits(FIXTURE_OWNER, FIXTURE_NAME, headSha);
    expect(commits.length).toBeGreaterThan(0);
    // Newest-first, as assembled by the pipeline.
    const dates = commits.map((c) => new Date(c.date).getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    for (const c of commits) expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the story document does not grow with the number of commits", async () => {
    const { getStore } = await import("@/server/store");
    const store = await getStore();
    const dir = path.join(fixtureDir, "data", "stories", "acme__widget");
    const storyFile = path.join(dir, `${headSha}.json`);

    const before = (await fs.stat(storyFile)).size;
    const original = await store.getCommits(FIXTURE_OWNER, FIXTURE_NAME, headSha);

    // Re-persist the same story with 1000 commits attached.
    const story = (await store.getStory(FIXTURE_OWNER, FIXTURE_NAME))!.story;
    const many = Array.from({ length: 1000 }, (_, i) => ({
      ...original[i % original.length]!,
      sha: String(i).padStart(40, "0"),
      files: ["some/very/long/path/to/a/file.tsx"],
    }));
    await store.saveStory(story, many);

    // This is the whole point: the document is now independent of commit count.
    expect((await fs.stat(storyFile)).size).toBe(before);
    expect(await store.getCommits(FIXTURE_OWNER, FIXTURE_NAME, headSha)).toHaveLength(1000);

    // Restore for later assertions.
    await store.saveStory(story, original);
  });

  it("an unknown HEAD yields no commits rather than throwing", async () => {
    const { getStore } = await import("@/server/store");
    const commits = await (await getStore()).getCommits(
      FIXTURE_OWNER,
      FIXTURE_NAME,
      "0".repeat(40)
    );
    expect(commits).toEqual([]);
  });

  it("a re-scan of the same HEAD replaces the commit set", async () => {
    const { getStore } = await import("@/server/store");
    const store = await getStore();
    const before = await store.getCommits(FIXTURE_OWNER, FIXTURE_NAME, headSha);

    const story = (await store.getStory(FIXTURE_OWNER, FIXTURE_NAME))!.story;
    // Simulate a narrowed re-scan: same HEAD, fewer commits.
    await store.saveStory(story, before.slice(0, 2));

    const after = await store.getCommits(FIXTURE_OWNER, FIXTURE_NAME, headSha);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.sha)).toEqual(before.slice(0, 2).map((c) => c.sha));
  });
});

describe("schema versioning", () => {
  it("a cached pre-upgrade document is treated as absent, forcing a re-scan", async () => {
    const dir = path.join(fixtureDir, "data", "stories", "acme__widget");
    const file = path.join(dir, "latest.json");
    const original = await fs.readFile(file, "utf8");

    // A v1 document still has `commits` inlined and must not be served.
    const stale = JSON.parse(original);
    stale.story.schemaVersion = 1;
    await fs.writeFile(file, JSON.stringify(stale));

    const { FileStore } = await import("@/server/store");
    // A fresh driver avoids the cached singleton while exercising the real check.
    const fresh = new FileStore(path.join(fixtureDir, "data"));
    expect(await fresh.getStory(FIXTURE_OWNER, FIXTURE_NAME)).toBeNull();

    await fs.writeFile(file, original);
    expect(await fresh.getStory(FIXTURE_OWNER, FIXTURE_NAME)).not.toBeNull();
  });

  it("the current version is 2", async () => {
    const { SCHEMA_VERSION } = await import("@/lib/types");
    expect(SCHEMA_VERSION).toBe(2);
  });
});