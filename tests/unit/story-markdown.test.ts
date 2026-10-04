import { describe, expect, it } from "vitest";
import { renderStoryMarkdown } from "@/lib/story-markdown";
import type { RepoStory } from "@/lib/types";
import { SCHEMA_VERSION } from "@/lib/types";

const story: RepoStory = {
  schemaVersion: SCHEMA_VERSION,
  repo: {
    owner: "acme",
    name: "widget",
    url: "https://github.com/acme/widget",
    description: "A fixture widget repository with a dramatic past.",
    stars: 4242,
    forks: 42,
    primaryLanguage: "JavaScript",
    defaultBranch: "main",
    headSha: "3734f75440f34971836ce4ae85f02d7358be8f71",
    isFork: false,
    archived: false,
  },
  stats: {
    totalCommits: 24,
    totalPRs: 60,
    matchedPRs: 5,
    avgPRFiles: 1.2,
    avgPRAdditions: 20,
    hotfixesPerMonth: 3.5,
    revertCount: 1,
    contributors: 3,
    firstCommitAt: "2024-01-02T09:00:00Z",
    lastCommitAt: "2024-05-18T13:00:00Z",
    historyDays: 137,
  },
  timeline: [],
  eras: [
    {
      id: "era-1",
      title: "Jan 2024 · src/components",
      start: "2024-01-02T09:00:00Z",
      end: "2024-01-19T15:00:00Z",
      startSha: "a".repeat(40),
      endSha: "b".repeat(40),
      commitCount: 9,
      authors: 2,
      dominantPaths: ["src/components", "src/core.js"],
      beat: "The original core engine landed here.",
      summary: "short summary",
      netAdditions: 500,
      netDeletions: 20,
    },
  ],
  incidents: [
    {
      kind: "revert",
      culpritSha: "c".repeat(40),
      culpritSubject: "Add experimental feature flag | with a pipe",
      culpritAuthor: "Grace",
      culpritDate: "2024-01-18T14:00:00Z",
      aftermathSha: "d".repeat(40),
      aftermathSubject: "Revert \"Add experimental feature flag\"",
      aftermathAuthor: "Ada",
      aftermathDate: "2024-01-19T15:00:00Z",
      hoursToRepair: 25,
      files: ["src/experimental.js"],
      netChurn: 2,
    },
  ],
  hotspots: [
    {
      path: "src/core.js",
      churn: 2370,
      commits: 3,
      authors: 2,
      linkedPRs: [
        {
          number: 1,
          title: "Add initial core engine",
          url: "https://github.com/acme/widget/pull/1",
          excerpt: "The original core engine.",
          mergedAt: "2024-01-03T10:00:00Z",
        },
      ],
      createdAt: "2024-01-03T10:00:00Z",
      lastTouchedAt: "2024-05-16T12:00:00Z",
    },
  ],
  churn: [
    { path: "src/core.js", churn: 2370, additions: 2000, deletions: 370, commits: 3, authors: 2 },
  ],
  authors: [
    {
      name: "Hemang | Varshney",
      email: "h@example.com",
      login: "hemv-857",
      commits: 35,
      additions: 5000,
      deletions: 900,
      firstCommitAt: "2024-01-02T09:00:00Z",
      lastCommitAt: "2024-05-18T13:00:00Z",
      perMonth: [{ month: "2024-01", commits: 5 }],
      topPaths: ["src/core.js"],
    },
  ],
  busFactor: {
    score: 1,
    label: "critical",
    topAuthorsShare: 0.94,
    contributors: 3,
    topAuthorCommits: 35,
  },
  totalCommitsInHistory: 24,
  prIndex: [],
  meta: {
    analyzerVersion: "1.0.0",
    analysisMs: 250,
    githubApiCalls: 23,
    cloned: true,
    aiBeats: "generated",
  },
  scannedAt: "2024-05-18T14:00:00Z",
};

describe("renderStoryMarkdown", () => {
  const md = renderStoryMarkdown(story);

  it("leads with the repo identity", () => {
    expect(md.startsWith("# acme/widget")).toBe(true);
    expect(md).toContain("A fixture widget repository with a dramatic past.");
    expect(md).toContain("https://github.com/acme/widget");
    expect(md).toContain("**Stars** 4,242");
  });

  it("includes every section", () => {
    for (const heading of [
      "## At a glance",
      "## Feature eras",
      "## Who broke what",
      "## Why this ugly code exists",
      "## The dig team",
      "## Churn leaderboard",
    ]) {
      expect(md, heading).toContain(heading);
    }
  });

  it("prefers the AI beat over the machine summary", () => {
    expect(md).toContain("The original core engine landed here.");
    expect(md).not.toContain("short summary");
  });

  it("escapes pipes so subjects cannot break a table row", () => {
    // The culprit subject contains a literal pipe.
    expect(md).toContain("Add experimental feature flag \\| with a pipe");
    expect(md).toContain("Hemang \\| Varshney");
  });

  it("keeps every table row's column count aligned with its header", () => {
    // Group contiguous table lines and check each block agrees on pipe count.
    const lines = md.split("\n");
    let block: string[] = [];
    const check = (rows: string[]) => {
      if (rows.length < 2) return;
      // Only unescaped pipes delimit columns; `\|` renders as a literal pipe.
      const counts = new Set(
        rows.map((r) => (r.match(/(?<!\\)\|/g) ?? []).length)
      );
      expect(counts.size, `ragged table:\n${rows.join("\n")}`).toBe(1);
    };
    for (const line of lines) {
      if (line.startsWith("|")) block.push(line);
      else {
        check(block);
        block = [];
      }
    }
    check(block);
  });

  it("does not let a subject containing a pipe shift the column count", () => {
    const incidentRows = md
      .split("\n")
      .filter((l) => l.startsWith("| revert |"));
    expect(incidentRows).toHaveLength(1);
    // 6 columns => 7 pipes, regardless of the pipe inside the subject.
    expect((incidentRows[0]!.match(/\\?\|/g) ?? []).length).toBe(7);
  });

  it("UTC-anchors dates so output is stable across machines", () => {
    expect(md).toContain("2024-01-02");
    expect(md).toContain("2024-05-18");
  });

  it("links hotspot PRs", () => {
    expect(md).toContain("[#1](https://github.com/acme/widget/pull/1)");
  });

  it("records provenance in the footer", () => {
    expect(md).toContain("analyzer v1.0.0");
    expect(md).toContain("23 GitHub API calls");
    expect(md).toContain("AI beats: generated");
  });

  it("degrades gracefully when optional sections are empty", () => {
    const sparse = renderStoryMarkdown({
      ...story,
      eras: [],
      incidents: [],
      hotspots: [],
      churn: [],
      authors: [],
      repo: { ...story.repo, description: null, primaryLanguage: null },
    });
    expect(sparse).toContain("_No eras detected._");
    expect(sparse).toContain("_No reverts or urgent fixes detected._");
    expect(sparse).toContain("**Language** —");
    expect(sparse).not.toContain("Why this ugly code exists");
    expect(sparse).not.toContain("Churn leaderboard");
  });

  it("pluralises era authors correctly", () => {
    expect(md).toContain("2 authors");
    expect(
      renderStoryMarkdown({
        ...story,
        eras: [{ ...story.eras[0]!, authors: 1 }],
      })
    ).toContain("1 author\n");
  });
});