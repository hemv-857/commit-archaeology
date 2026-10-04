import { describe, expect, it } from "vitest";
import { findIncidents, isFixLike } from "@/server/analysis/incidents";
import { makeCommit, file } from "../helpers";

/**
 * Two root causes of false-positive "who broke what" reports, both found on a
 * real 5-day-old repository that reported 5 incidents out of 37 commits.
 */

describe("isFixLike requires the vocabulary in conventional position", () => {
  it("accepts conventional commit prefixes", () => {
    for (const s of [
      "fix: null deref",
      "fix(parser): handle empty input",
      "hotfix: patch it",
      "bugfix: off-by-one",
      "patch: apply generated diff",
      "revert: undo the thing",
    ]) {
      expect(isFixLike(s), s).toBe(true);
    }
  });

  it("accepts sentence-initial imperatives", () => {
    for (const s of [
      "Fix the parser",
      "Fixes #123",
      "Fixed the crash",
      "Hotfix release",
      "Patch the build",
    ]) {
      expect(isFixLike(s), s).toBe(true);
    }
  });

  it("rejects fix vocabulary buried in prose", () => {
    // The real false positive: "fixed income" is not a hotfix.
    for (const s of [
      "feat: add more glossary terms across options, vol, and fixed income",
      "feat: production hardening — fix double JSON parse, add SSRF protection",
      "feat: support fixed-point math",
      "docs: explain the patch format",
      "feat: shiny new thing",
    ]) {
      expect(isFixLike(s), s).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isFixLike("FIX: shout")).toBe(true);
    expect(isFixLike("Fix the thing")).toBe(true);
  });
});

describe("quickfix inference needs a discriminating window", () => {
  const culprit = (date: string, subject = "feat: add scheduler") =>
    makeCommit({ date, subject, files: [file("src/sched.js", 100, 10)] });
  const fixer = (date: string, subject = "fix: scheduler deadlocks") =>
    makeCommit({ date, subject, files: [file("src/sched.js", 5, 5)] });

  it("suppresses quickfixes when the whole history fits inside the window", () => {
    // A 5-day-old repo: every pair is "within 14 days" by construction.
    const incidents = findIncidents([
      fixer("2024-03-02T00:00:00Z"),
      culprit("2024-03-01T00:00:00Z"),
    ]);
    expect(incidents).toHaveLength(0);
  });

  it("still reports them once history spans more than the window", () => {
    const incidents = findIncidents([
      fixer("2024-03-02T00:00:00Z"),
      culprit("2024-03-01T00:00:00Z"),
      makeCommit({ date: "2023-09-01T00:00:00Z", subject: "Initial import", files: [] }),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe("quickfix");
  });

  it("keeps reverts for young repos — they are explicit, not inferred", () => {
    const bad = makeCommit({
      date: "2024-03-01T00:00:00Z",
      subject: "Add feature X",
      files: [file("src/x.js", 50, 0)],
    });
    const revert = makeCommit({
      date: "2024-03-02T00:00:00Z",
      subject: 'Revert "Add feature X"',
      body: `This reverts commit ${bad.sha}.`,
      files: [file("src/x.js", 0, 50)],
    });
    const incidents = findIncidents([revert, bad]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe("revert");
  });

  it("handles an empty history", () => {
    expect(findIncidents([])).toEqual([]);
    expect(findIncidents([makeCommit({ date: "2024-01-01T00:00:00Z" })])).toEqual([]);
  });
});

describe("the reported false positives are gone", () => {
  it("does not treat fixed-income prose as a hotfix", () => {
    // Shape copied from the real 5-day repo that produced 5 bogus incidents.
    const glossary = makeCommit({
      date: "2024-03-01T10:00:00Z",
      subject: "feat: expand glossary and add glossary view with search",
      files: [file("src/data/glossary.ts", 120, 4)],
    });
    const followUp = makeCommit({
      date: "2024-03-01T10:06:00Z",
      subject: "feat: add more glossary terms across options, vol, and fixed income",
      files: [file("src/data/glossary.ts", 30, 2)],
    });
    const old = makeCommit({
      date: "2023-09-01T00:00:00Z",
      subject: "Initial import",
      files: [file("README.md", 1, 0)],
    });
    // Same window, same file, same shape — but the follow-up is not a repair.
    expect(findIncidents([followUp, glossary, old])).toHaveLength(0);
  });
});