import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixtures, FIXTURE_OWNER, FIXTURE_NAME } from "../fixtures/make-fixture-repos";

/**
 * End-to-end pipeline test in MOCK_GITHUB mode: the scan runs against a real
 * local git fixture repo and canned GitHub fixtures — no network.
 */
let fixtureDir: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-pipeline-"));
  await buildFixtures(fixtureDir);
  process.env.MOCK_GITHUB = "1";
  // The app treats FIXTURE_REPO_DIR as the bare-repos dir; GitHub fixture
  // JSONs live in the sibling github/ directory (mirrors public/fixtures).
  process.env.FIXTURE_REPO_DIR = path.join(fixtureDir, "repos");
  process.env.DATA_DIR = path.join(fixtureDir, "data");
  process.env.REDIS_URL = "";
  process.env.DATABASE_URL = "";
  process.env.OPENAI_API_KEY = "";
});

describe("scan pipeline (mock github + git fixture)", () => {
  it(
    "produces a complete story from clone to persisted story",
    { timeout: 120_000 },
    async () => {
      const { runScan } = await import("@/server/pipeline");
    const { getStore } = await import("@/server/store");

    const events: Array<{ stage: string; pct: number }> = [];
    const job = {
      id: "test-job-1",
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

    const story = await runScan(job, async (p) => {
      events.push({ stage: p.stage, pct: p.pct });
    });

    // progress traversed all stages
    const stages = new Set(events.map((e) => e.stage));
    expect(stages.has("clone")).toBe(true);
    expect(stages.has("history")).toBe(true);
    expect(stages.has("compute")).toBe(true);
    expect(stages.has("done")).toBe(true);
    expect(events[events.length - 1]!.pct).toBe(100);

    // repo meta from fixture
    expect(story.repo.owner).toBe("acme");
    expect(story.repo.name).toBe("widget");
    expect(story.repo.stars).toBe(4242);
    expect(story.repo.headSha).toMatch(/^[0-9a-f]{40}$/);

    // stats from the fixture repo (24 commits per fixture metadata)
    expect(story.stats.totalCommits).toBe(24);
    expect(story.stats.totalPRs).toBe(60);
    expect(story.stats.contributors).toBe(3);
    expect(story.stats.revertCount).toBeGreaterThanOrEqual(1);

    // eras: three distinct dev periods in the fixture
    expect(story.eras.length).toBe(3);

    // incidents: fixture has a revert pair and a quickfix pair
    expect(story.incidents.length).toBeGreaterThanOrEqual(2);
    expect(story.incidents.some((i) => i.kind === "revert")).toBe(true);
    expect(story.incidents.some((i) => i.kind === "quickfix")).toBe(true);

    // churn leader is the hot file
    expect(story.churn[0]!.path).toBe("src/core.js");

    // hotspot links PR #1 with its excerpt (newest-first, so look it up by number)
    const core = story.hotspots.find((h) => h.path === "src/core.js")!;
    expect(core.linkedPRs.map((p) => p.number)).toContain(1);
    const pr1 = core.linkedPRs.find((p) => p.number === 1)!;
    expect(pr1.excerpt).toContain("core engine");

    // bus factor: ada dominates? fixture authors are 2-3 — score >= 1
    expect(story.busFactor.score).toBeGreaterThanOrEqual(1);
    expect(story.authors.length).toBe(3);

    // Commits live outside the story document (SCHEMA_VERSION), so the store is
    // the source of truth and the reachable set is derived from it.
    const store = await getStore();
    const commits = await store.getCommits("acme", "widget", story.repo.headSha);
    expect(commits.length).toBeGreaterThan(0);

    // prIndex is trimmed to PRs a stored commit actually references. The fixture's
    // commits cite (#1), (#2), (#23), (#60), (#101), so those must survive or
    // the commit drawer's "pull req" row silently disappears.
    const referenced = new Set(
      commits.map((c) => c.prNumber).filter((n): n is number => n !== null)
    );
    expect(referenced.size).toBeGreaterThan(0);
    const storedPrNumbers = new Set(story.prIndex.map((p) => p.number));
    for (const n of referenced) {
      // Only PRs the fixture actually defines can be present.
      if ([1, 2, 23, 60, 101].includes(n)) {
        expect(storedPrNumbers.has(n), `PR #${n} must stay in prIndex`).toBe(true);
      }
    }
    // And nothing unreachable is carried along. The fixture ships 3 PRs no commit
    // cites (#900-902), so this also proves the trim is wired into the pipeline,
    // not merely available as a helper.
    for (const p of story.prIndex) {
      expect(referenced.has(p.number), `PR #${p.number} is unreachable`).toBe(true);
    }
    expect(story.prIndex.map((p) => p.number)).not.toContain(900);
    expect(story.prIndex.map((p) => p.number)).not.toContain(901);
    expect(story.prIndex.map((p) => p.number)).not.toContain(902);
    expect(story.prIndex.length).toBeLessThan(8); // 5 reachable of 8 served

    // timeline buckets exist
    expect(story.timeline.length).toBeGreaterThanOrEqual(3);

    // persisted: store serves the same story back
    const stored = await store.getStory("acme", "widget");
    expect(stored?.story.repo.headSha).toBe(story.repo.headSha);
    expect(stored?.story.stats.totalCommits).toBe(24);

    // clone scratch dir cleaned up
    const leftover = await fs.readdir(os.tmpdir(), { withFileTypes: true });
    expect(leftover.filter((d) => d.name.startsWith("scan-test-job-1"))).toHaveLength(0);
  });

  it("caches the second scan of the same HEAD", { timeout: 60_000 }, async () => {
    const { getStore } = await import("@/server/store");
    const store = await getStore();
    const stored = await store.getStory("acme", "widget");
    const again = await store.getStoryForSha("acme", "widget", stored!.headSha);
    expect(again?.schemaVersion).toBe(2);
  });
});
