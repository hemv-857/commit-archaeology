import { describe, expect, it } from "vitest";
import { buildComparison, comparisonVerdict } from "@/lib/compare";
import { SCHEMA_VERSION } from "@/lib/types";
import type { RepoStory } from "@/lib/types";

function make(over: Partial<RepoStory> = {}): RepoStory {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: {
      owner: "a",
      name: "repo",
      url: "https://github.com/a/repo",
      description: null,
      stars: 0,
      forks: 0,
      primaryLanguage: null,
      defaultBranch: "main",
      headSha: "a".repeat(40),
      isFork: false,
      archived: false,
    },
    stats: {
      totalCommits: 100,
      totalPRs: 20,
      matchedPRs: 5,
      avgPRFiles: 2,
      avgPRAdditions: 30,
      hotfixesPerMonth: 4,
      revertCount: 1,
      contributors: 5,
      firstCommitAt: "2020-01-01T00:00:00Z",
      lastCommitAt: "2024-01-01T00:00:00Z",
      historyDays: 1000,
    },
    timeline: [],
    eras: [
      {
        id: "e1",
        title: "Era one",
        start: "2020-01-01T00:00:00Z",
        end: "2021-01-01T00:00:00Z",
        startSha: "a".repeat(40),
        endSha: "b".repeat(40),
        commitCount: 50,
        authors: 2,
        dominantPaths: [],
        beat: null,
        summary: "s",
        netAdditions: 1,
        netDeletions: 1,
      },
    ],
    incidents: [],
    hotspots: [],
    churn: [],
    authors: [],
    busFactor: { score: 3, label: "moderate", topAuthorsShare: 0.5, contributors: 5, topAuthorCommits: 50 },
    totalCommitsInHistory: 100,
    prIndex: [],
    meta: {
      analyzerVersion: "1.0.0",
      analysisMs: 1,
      githubApiCalls: 1,
      cloned: true,
      aiBeats: "skipped",
    },
    scannedAt: "2024-01-01T00:00:00Z",
    ...over,
  };
}

const row = (rows: ReturnType<typeof buildComparison>["rows"], label: string) =>
  rows.find((r) => r.label === label)!;

describe("buildComparison", () => {
  it("emits a row per metric with formatted values", () => {
    const { rows } = buildComparison(make(), make());
    expect(rows.length).toBeGreaterThan(8);
    expect(row(rows, "commits").a).toBe("100");
    expect(row(rows, "contributors").b).toBe("5");
    expect(row(rows, "hotfix frequency").a).toBe("4/mo");
    expect(row(rows, "top author share").a).toBe("50%");
  });

  it("marks neutral metrics as neither better", () => {
    const { rows } = buildComparison(make(), make());
    // More commits / eras / history is not "better".
    expect(row(rows, "commits").better).toBeNull();
    expect(row(rows, "history").better).toBeNull();
  });

  it("higher is better for contributors and bus factor", () => {
    const a = make({ stats: { ...make().stats, contributors: 10 } });
    const b = make();
    const { rows } = buildComparison(a, b);
    expect(row(rows, "contributors").better).toBe("a");

    const a2 = make({ busFactor: { ...make().busFactor, score: 6 } });
    expect(row(buildComparison(a2, b).rows, "bus factor").better).toBe("a");
  });

  it("lower is better for hotfix frequency, reverts and incidents", () => {
    const calm = make({
      stats: { ...make().stats, hotfixesPerMonth: 0.5, revertCount: 0 },
    });
    const { rows } = buildComparison(calm, make());
    expect(row(rows, "hotfix frequency").better).toBe("a");
    expect(row(rows, "reverts").better).toBe("a");
  });

  it("lower top-author share is healthier", () => {
    const spread = make({ busFactor: { ...make().busFactor, topAuthorsShare: 0.2 } });
    const { rows } = buildComparison(spread, make());
    expect(row(rows, "top author share").better).toBe("a");
  });

  it("ties yield no winner", () => {
    const { rows } = buildComparison(make(), make());
    for (const r of rows) expect(r.better).toBeNull();
  });

  it("labels direction only where it is meaningful", () => {
    const { rows } = buildComparison(make(), make());
    expect(row(rows, "bus factor").hint).toMatch(/higher/i);
    expect(row(rows, "hotfix frequency").hint).toMatch(/lower/i);
    expect(row(rows, "commits").hint).toBeUndefined();
  });

  it("passes both era lists and the longer count", () => {
    const one = make();
    const two = make({
      eras: [
        ...one.eras,
        { ...one.eras[0]!, id: "e2", title: "Era two", start: "2021-06-01T00:00:00Z" },
      ],
    });
    const { erasA, erasB, maxEras } = buildComparison(one, two);
    expect(erasA).toHaveLength(1);
    expect(erasB).toHaveLength(2);
    expect(maxEras).toBe(2);
  });

  it("handles repos with no eras", () => {
    const { erasA, erasB, maxEras } = buildComparison(make({ eras: [] }), make());
    expect(erasA).toHaveLength(0);
    expect(erasB).toHaveLength(1);
    expect(maxEras).toBe(1);
  });
});

describe("comparisonVerdict", () => {
  it("names the healthier side and the count", () => {
    const strong = make({
      stats: { ...make().stats, hotfixesPerMonth: 0, revertCount: 0, contributors: 20 },
      busFactor: { ...make().busFactor, score: 6, topAuthorsShare: 0.2 },
    });
    const weak = make();
    const { rows } = buildComparison(strong, weak);
    const verdict = comparisonVerdict("strong/repo", "weak/repo", rows);
    expect(verdict).toMatch(/^strong\/repo looks healthier on \d+ of \d+ comparable metrics\.$/);
  });

  it("calls an even split a split", () => {
    const a = make({ stats: { ...make().stats, hotfixesPerMonth: 0, revertCount: 0 } });
    const b = make({ stats: { ...make().stats, contributors: 50 }, busFactor: { ...make().busFactor, score: 6 } });
    const { rows } = buildComparison(a, b);
    expect(comparisonVerdict("x/y", "z/w", rows)).toMatch(/split the \d+ comparable metrics evenly/);
  });

  it("says so when nothing is comparable", () => {
    // All neutral metrics — e.g. two identical repos.
    const { rows } = buildComparison(make(), make());
    expect(comparisonVerdict("x/y", "z/w", rows)).toMatch(/No metric here has a clear/);
  });
});
describe("formatting", () => {
  it("pluralises avg PR size", () => {
    const one = make({ stats: { ...make().stats, avgPRFiles: 1 } });
    const many = make({ stats: { ...make().stats, avgPRFiles: 3 } });
    const { rows } = buildComparison(one, many);
    expect(row(rows, "avg PR size").a).toBe("1 file");
    expect(row(rows, "avg PR size").b).toBe("3 files");
  });
});
