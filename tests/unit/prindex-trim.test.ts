import { describe, expect, it } from "vitest";
import { reachablePrIndex } from "@/server/pipeline";
import type { CommitEntry, PRSummary } from "@/lib/types";

/**
 * `prIndex` is persisted trimmed to the PRs the UI can reach.
 *
 * The only consumer is the commit drawer:
 *   story.prIndex.find(p => p.number === commit.prNumber)
 * Hotspots carry their own denormalized PR copies, so they need nothing here.
 *
 * Persisting the fetched list verbatim shipped ~350 KB for octocat/Hello-World
 * (1000 PRs fetched, 1 reachable) — a 3-commit repo.
 */

const pr = (number: number): PRSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: "ada",
  state: "MERGED",
  createdAt: "2024-01-01T00:00:00Z",
  mergedAt: "2024-01-02T00:00:00Z",
  additions: 10,
  deletions: 1,
  changedFiles: 1,
  excerpt: "body",
});

const commit = (sha: string, prNumber: number | null): CommitEntry => ({
  sha,
  shortSha: sha.slice(0, 7),
  subject: prNumber ? `fix thing (#${prNumber})` : "no pr here",
  authorName: "Ada",
  authorEmail: "ada@example.com",
  date: "2024-01-01T00:00:00Z",
  isMerge: false,
  prNumber,
  files: [],
  additions: 1,
  deletions: 0,
});

describe("reachablePrIndex", () => {
  it("keeps only PRs a stored commit points at", () => {
    const result = reachablePrIndex(
      [commit("a".repeat(40), 7), commit("b".repeat(40), null)],
      [pr(1), pr(7), pr(99)]
    );
    expect(result.map((p) => p.number)).toEqual([7]);
  });

  it("drops the overwhelming majority on a realistic repo", () => {
    // Hello-World shape: 1000 PRs fetched, 1 reachable.
    const fetched = Array.from({ length: 1000 }, (_, i) => pr(i + 1));
    const result = reachablePrIndex([commit("c".repeat(40), 412)], fetched);

    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(412);

    const before = JSON.stringify(fetched).length;
    const after = JSON.stringify(result).length;
    // The point of the change.
    expect(after).toBeLessThan(before / 100);
  });

  it("is empty when no commit references a PR", () => {
    expect(reachablePrIndex([commit("a".repeat(40), null)], [pr(1), pr(2)])).toEqual([]);
  });

  it("is empty when there are no commits at all", () => {
    expect(reachablePrIndex([], [pr(1), pr(2)])).toEqual([]);
  });

  it("preserves input order and never mutates its inputs", () => {
    const commits = [commit("a".repeat(40), 5), commit("b".repeat(40), 3)];
    const prIndex = [pr(3), pr(5), pr(1)];
    const snapshot = JSON.stringify(prIndex);

    const result = reachablePrIndex(commits, prIndex);
    expect(result.map((p) => p.number)).toEqual([3, 5]);
    expect(JSON.stringify(prIndex)).toBe(snapshot);
  });

  it("de-duplicates repeated references", () => {
    const result = reachablePrIndex(
      [commit("a".repeat(40), 5), commit("b".repeat(40), 5)],
      [pr(5)]
    );
    expect(result).toHaveLength(1);
  });

  it("tolerates a referenced PR that was never fetched", () => {
    // Commit subjects can cite PRs absent from the fetched set; the drawer
    // already falls back to null, so this must not throw or invent an entry.
    const result = reachablePrIndex([commit("a".repeat(40), 12345)], [pr(1)]);
    expect(result).toEqual([]);
  });
});