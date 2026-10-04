import { describe, expect, it } from "vitest";
import { parseCommitQuery, commitMatches, filterCommits } from "@/lib/commit-search";
import type { CommitEntry } from "@/lib/types";

const c = (over: Partial<CommitEntry> = {}): CommitEntry => ({
  sha: "3734f75440f34971836ce4ae85f02d7358be8f71",
  shortSha: "3734f75",
  subject: "Fix startup crash in core init",
  authorName: "Grace Hopper",
  authorEmail: "grace@example.com",
  date: "2024-01-05T11:00:00Z",
  isMerge: false,
  prNumber: 2,
  files: ["src/core.js", "src/util.js"],
  additions: 3,
  deletions: 1,
  ...over,
});

describe("parseCommitQuery", () => {
  it("treats a bare term as a search across everything", () => {
    expect(parseCommitQuery("core")).toEqual({ term: "core", field: "all" });
  });

  it("lowercases and trims", () => {
    expect(parseCommitQuery("  CORE  ")).toEqual({ term: "core", field: "all" });
  });

  it("recognises field prefixes", () => {
    expect(parseCommitQuery("author:ada")).toEqual({ term: "ada", field: "author" });
    expect(parseCommitQuery("subject:crash")).toEqual({ term: "crash", field: "subject" });
    expect(parseCommitQuery("path:core.js")).toEqual({ term: "core.js", field: "path" });
    expect(parseCommitQuery("sha:3734")).toEqual({ term: "3734", field: "sha" });
  });

  it("allows a space after the field name", () => {
    expect(parseCommitQuery("author: grace")).toEqual({ term: "grace", field: "author" });
  });

  it("returns null for empty or field-only input", () => {
    expect(parseCommitQuery("")).toBeNull();
    expect(parseCommitQuery("   ")).toBeNull();
    // A bare "author" is a search term, not an empty field filter.
    expect(parseCommitQuery("author")).toEqual({ term: "author", field: "all" });
    expect(parseCommitQuery("author:")).toBeNull();
    expect(parseCommitQuery("author:   ")).toBeNull();
  });
});

describe("commitMatches", () => {
  it("matches everything when the query is empty", () => {
    expect(commitMatches(c(), null)).toBe(true);
  });

  it("bare term searches subject, author, email, path and sha", () => {
    expect(commitMatches(c(), parseCommitQuery("startup"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("hopper"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("grace@"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("util.js"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("3734f75"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("nonexistent"))).toBe(false);
  });

  it("sha: is a prefix match, not a substring match", () => {
    expect(commitMatches(c(), parseCommitQuery("sha:3734"))).toBe(true);
    // "f75440" appears in the middle but is not a prefix.
    expect(commitMatches(c(), parseCommitQuery("sha:f75440"))).toBe(false);
  });

  it("author: matches name or email", () => {
    expect(commitMatches(c(), parseCommitQuery("author:grace"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("author:grace@"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("author:ada"))).toBe(false);
  });

  it("path: matches any touched file", () => {
    expect(commitMatches(c(), parseCommitQuery("path:core"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("path:util"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("path:missing"))).toBe(false);
  });

  it("subject: does not leak into author or path", () => {
    expect(commitMatches(c(), parseCommitQuery("subject:grace"))).toBe(false);
    expect(commitMatches(c(), parseCommitQuery("subject:core.js"))).toBe(false);
  });

  it("is case-insensitive for text fields", () => {
    expect(commitMatches(c(), parseCommitQuery("subject:STARTUP"))).toBe(true);
    expect(commitMatches(c(), parseCommitQuery("author:HOPPER"))).toBe(true);
  });
});

describe("filterCommits", () => {
  const list = [
    c({ sha: "a".repeat(40), subject: "Add parser", authorName: "Ada", files: ["src/parse.ts"] }),
    c({ sha: "b".repeat(40), subject: "Fix parser crash", authorName: "Grace", files: ["src/core.js"] }),
    c({ sha: "c".repeat(40), subject: "Docs", authorName: "Ada", files: ["README.md"] }),
  ];

  it("returns the input untouched for an empty query", () => {
    expect(filterCommits(list, "  ")).toBe(list);
  });

  it("narrows across the set", () => {
    expect(filterCommits(list, "parser").map((x) => x.subject)).toEqual([
      "Add parser",
      "Fix parser crash",
    ]);
    expect(filterCommits(list, "author:ada").map((x) => x.subject)).toEqual([
      "Add parser",
      "Docs",
    ]);
    expect(filterCommits(list, "path:core").map((x) => x.subject)).toEqual([
      "Fix parser crash",
    ]);
    expect(filterCommits(list, "sha:bbb")).toHaveLength(1);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterCommits(list, "zzz")).toEqual([]);
  });
});