import { describe, expect, it } from "vitest";
import { buildEras } from "@/server/analysis/eras";
import { findIncidents, isFixLike } from "@/server/analysis/incidents";
import { computeAuthors, computeBusFactor } from "@/server/analysis/authors";
import { computeChurn, buildHotspots } from "@/server/analysis/hotspots";
import { computeStats, buildTimeline } from "@/server/analysis/stats";
import type { PRSummary } from "@/lib/types";
import { makeCommit, file } from "../helpers";

const DAY = 86_400_000;
const t = (iso: string) => new Date(iso).getTime();

describe("buildEras", () => {
  it("splits on >21 day gaps and labels dominant paths", () => {
    const commits = [
      // era 1: January, core (6 commits, above the tiny-era threshold)
      makeCommit({ date: "2024-01-02T00:00:00Z", files: [file("src/core.js")] }),
      makeCommit({ date: "2024-01-05T00:00:00Z", files: [file("src/core.js")] }),
      makeCommit({ date: "2024-01-10T00:00:00Z", files: [file("src/core.js")] }),
      makeCommit({ date: "2024-01-13T00:00:00Z", files: [file("src/core.js")] }),
      makeCommit({ date: "2024-01-16T00:00:00Z", files: [file("src/core.js")] }),
      makeCommit({ date: "2024-01-20T00:00:00Z", files: [file("src/core.js")] }),
      // 40+ day gap → era 2: compiler
      makeCommit({ date: "2024-03-02T00:00:00Z", files: [file("src/compiler/parse.js")] }),
      makeCommit({ date: "2024-03-05T00:00:00Z", files: [file("src/compiler/emit.js")] }),
      makeCommit({ date: "2024-03-08T00:00:00Z", files: [file("src/compiler/parse.js")] }),
      makeCommit({ date: "2024-03-10T00:00:00Z", files: [file("src/compiler/emit.js")] }),
      makeCommit({ date: "2024-03-12T00:00:00Z", files: [file("src/compiler/parse.js")] }),
      makeCommit({ date: "2024-03-15T00:00:00Z", files: [file("src/compiler/parse.js")] }),
      // gap → era 3: cli
      makeCommit({ date: "2024-05-01T00:00:00Z", files: [file("cli/main.js")] }),
      makeCommit({ date: "2024-05-03T00:00:00Z", files: [file("cli/main.js")] }),
      makeCommit({ date: "2024-05-05T00:00:00Z", files: [file("cli/main.js")] }),
      makeCommit({ date: "2024-05-07T00:00:00Z", files: [file("cli/main.js")] }),
      makeCommit({ date: "2024-05-09T00:00:00Z", files: [file("cli/main.js")] }),
      makeCommit({ date: "2024-05-11T00:00:00Z", files: [file("cli/main.js")] }),
    ];
    const eras = buildEras(commits); // ascending order expected
    expect(eras).toHaveLength(3);
    expect(eras[0]!.commitCount).toBe(6);
    expect(eras[0]!.dominantPaths).toContain("src/core.js");
    expect(eras[1]!.dominantPaths.some((p) => p.startsWith("src/compiler"))).toBe(true);
    expect(eras[2]!.dominantPaths).toContain("cli/main.js");
    expect(eras[0]!.title).toContain("Jan");
  });

  it("merges tiny eras into neighbours", () => {
    const commits = [
      makeCommit({ date: "2024-01-01T00:00:00Z", files: [file("a.js")] }),
      makeCommit({ date: "2024-01-02T00:00:00Z", files: [file("a.js")] }),
      makeCommit({ date: "2024-01-03T00:00:00Z", files: [file("a.js")] }),
      makeCommit({ date: "2024-01-04T00:00:00Z", files: [file("a.js")] }),
      makeCommit({ date: "2024-01-05T00:00:00Z", files: [file("a.js")] }),
      makeCommit({ date: "2024-01-06T00:00:00Z", files: [file("a.js")] }),
      // isolated single commit 40 days later (tiny era → merged back)
      makeCommit({ date: "2024-02-16T00:00:00Z", files: [file("b.js")] }),
    ];
    const eras = buildEras(commits);
    expect(eras).toHaveLength(1);
    expect(eras[0]!.commitCount).toBe(7);
  });

  it("returns [] for empty history", () => {
    expect(buildEras([])).toEqual([]);
  });
});

describe("findIncidents", () => {
  it("detects revert pairs (body sha reference)", () => {
    const bad = makeCommit({
      date: "2024-01-02T00:00:00Z",
      subject: "Add feature X",
      files: [file("src/x.js", 50, 0)],
    });
    const revert = makeCommit({
      date: "2024-01-03T06:00:00Z",
      subject: 'Revert "Add feature X"',
      body: `This reverts commit ${bad.sha}.`,
      files: [file("src/x.js", 0, 50)],
    });
    // newest first
    const incidents = findIncidents([revert, bad]);
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.kind).toBe("revert");
    expect(inc.culpritSha).toBe(bad.sha);
    expect(inc.aftermathSha).toBe(revert.sha);
    expect(inc.hoursToRepair).toBeCloseTo(30, 0);
  });

  it("detects quick-fix pairs within the window", () => {
    const culprit = makeCommit({
      date: "2024-02-01T00:00:00Z",
      subject: "Add new scheduler",
      files: [file("src/sched.js", 100, 10)],
    });
    const fixer = makeCommit({
      date: "2024-02-02T12:00:00Z",
      subject: "fix: scheduler deadlocks on empty queue",
      files: [file("src/sched.js", 5, 5)],
    });
    // An older commit so the history spans more than the 14-day window;
    // without it the whole repo fits inside the window and quickfix inference
    // is (correctly) suppressed as non-discriminating.
    const old = makeCommit({
      date: "2023-10-01T00:00:00Z",
      subject: "Initial import",
      files: [file("README.md", 1, 0)],
    });
    const incidents = findIncidents([fixer, culprit, old]);
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.kind).toBe("quickfix");
    expect(inc.culpritSha).toBe(culprit.sha);
    expect(inc.aftermathSha).toBe(fixer.sha);
  });

  it("ignores fixes whose culprit is outside the 14-day window", () => {
    const culprit = makeCommit({
      date: "2024-02-01T00:00:00Z",
      subject: "Add legacy thing",
      files: [file("src/legacy.js", 80, 0)],
    });
    const fixer = makeCommit({
      date: "2024-03-15T00:00:00Z",
      subject: "fix: legacy thing crashes",
      files: [file("src/legacy.js", 4, 4)],
    });
    expect(findIncidents([fixer, culprit])).toHaveLength(0);
  });

  it("isFixLike matches hotfix/patch vocabulary", () => {
    expect(isFixLike("hotfix: patch it")).toBe(true);
    expect(isFixLike("fix crash")).toBe(true);
    expect(isFixLike("feat: shiny new thing")).toBe(false);
  });
});

describe("bus factor", () => {
  const authors = (counts: number[]) =>
    computeAuthors(
      counts.flatMap((c, i) =>
        Array.from({ length: c }, (_, j) =>
          makeCommit({
            date: new Date(t("2024-01-01T00:00:00Z") + j * DAY).toISOString(),
            authorEmail: `p${i}@x.com`,
            authorName: `P${i}`,
          })
        )
      )
    );

  it("flags single-maintainer repos as critical", () => {
    const list = authors([50]);
    const bf = computeBusFactor(list, 50);
    expect(bf.score).toBe(1);
    expect(bf.label).toBe("critical");
  });

  it("scores a healthy spread", () => {
    // 10 authors × 5 commits: the top 5 authors are needed to reach 50%
    const list = authors(Array.from({ length: 10 }, () => 5));
    const bf = computeBusFactor(list, 50);
    expect(bf.score).toBe(5);
    expect(bf.label).toBe("healthy");
  });

  it("handles empty repos", () => {
    const bf = computeBusFactor([], 0);
    expect(bf.score).toBe(1);
    expect(bf.contributors).toBe(0);
  });

  it("computes per-month series", () => {
    const list = computeAuthors([
      makeCommit({ date: "2024-01-05T00:00:00Z" }),
      makeCommit({ date: "2024-01-09T00:00:00Z" }),
      makeCommit({ date: "2024-02-02T00:00:00Z" }),
    ]);
    expect(list[0]!.perMonth).toEqual([
      { month: "2024-01", commits: 2 },
      { month: "2024-02", commits: 1 },
    ]);
  });
});

describe("churn + hotspots", () => {
  const prs: PRSummary[] = [
    {
      number: 1,
      title: "Add core",
      url: "https://github.com/acme/widget/pull/1",
      author: "ada",
      state: "MERGED",
      createdAt: "2024-01-02T00:00:00Z",
      mergedAt: "2024-01-02T00:00:00Z",
      additions: 40,
      deletions: 0,
      changedFiles: 1,
      excerpt: "The original core.",
    },
  ];

  const commits = [
    makeCommit({
      date: "2024-01-02T00:00:00Z",
      subject: "Add core (#1)",
      files: [file("src/core.js", 40, 0)],
    }),
    makeCommit({
      date: "2024-01-03T00:00:00Z",
      files: [file("src/core.js", 10, 10), file("README.md", 5, 0)],
    }),
    makeCommit({
      date: "2024-01-04T00:00:00Z",
      files: [file("src/core.js", 2, 8)],
    }),
  ];

  it("ranks churn and aggregates authors", () => {
    const churn = computeChurn(commits);
    expect(churn[0]!.path).toBe("src/core.js");
    expect(churn[0]!.churn).toBe(70);
    expect(churn[0]!.commits).toBe(3);
    expect(churn[0]!.authors).toBe(1);
  });

  it("links hotspot PRs via squash subjects", () => {
    const hotspots = buildHotspots(commits, prs);
    const core = hotspots.find((h) => h.path === "src/core.js")!;
    expect(core.linkedPRs).toHaveLength(1);
    expect(core.linkedPRs[0]!.number).toBe(1);
    expect(core.linkedPRs[0]!.excerpt).toBe("The original core.");
  });
});

describe("stats + timeline", () => {
  const commitsAsc = [
    makeCommit({ date: "2024-01-01T00:00:00Z", files: [file("a.js")] }),
    makeCommit({ date: "2024-01-03T00:00:00Z", subject: "fix: boom", files: [file("a.js")] }),
    makeCommit({ date: "2024-02-01T00:00:00Z", files: [file("b.js")] }),
  ];

  it("computes stats strip values", () => {
    const stats = computeStats(commitsAsc, 12, [], [], 3);
    expect(stats.totalCommits).toBe(3);
    expect(stats.contributors).toBe(1);
    expect(stats.historyDays).toBe(31);
    expect(stats.hotfixesPerMonth).toBeGreaterThanOrEqual(0);
  });

  it("builds weekly timeline buckets", () => {
    const buckets = buildTimeline(commitsAsc);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    expect(buckets[0]!.commits).toBeGreaterThan(0);
  });

  it("handles the empty case", () => {
    const stats = computeStats([], 0, [], [], 0);
    expect(stats.totalCommits).toBe(0);
    expect(buildTimeline([])).toEqual([]);
  });
});
