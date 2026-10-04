import { describe, expect, it } from "vitest";
import { parseGitLog, prNumberFromSubject, revertReference } from "@/server/git/log";

/** Builds a raw `git log` stdout stream exactly like our LOG_FORMAT emits. */
function buildLog(commits: Array<{ fields: string[]; numstat?: string[] }>): string {
  return commits
    .map(({ fields, numstat }) => {
      // \x1e at start of each record, then NUL-separated fields; body is last
      // NUL field; numstat block trails after the final NUL.
      return `\x1e${fields.join("\x00")}\x00${numstat ? numstat.join("\n") : ""}`;
    })
    .join("\n");
}

describe("parseGitLog", () => {
  it("parses header fields and numstat lines", () => {
    const stdout = buildLog([
      {
        fields: ["a".repeat(40), "Ada", "ada@example.com", "2024-01-02T09:00:00+00:00", "parent0", "chore: scaffold", "long body\nwith lines"],
        numstat: ["10\t2\tsrc/core.js", "-\t-\tlogo.png", "0\t0\tsrc/{old.js => new.js}"],
      },
      {
        fields: ["b".repeat(40), "Grace", "grace@example.com", "2024-01-03T09:00:00+00:00", "parent1", "Fix bug", ""],
      },
    ]);

    const commits = parseGitLog(stdout, 100);
    expect(commits).toHaveLength(2);

    const first = commits[0]!;
    expect(first.sha).toBe("a".repeat(40));
    expect(first.authorName).toBe("Ada");
    expect(first.subject).toBe("chore: scaffold");
    expect(first.body).toContain("with lines");
    expect(first.files).toHaveLength(3);
    expect(first.files[0]).toEqual({ path: "src/core.js", additions: 10, deletions: 2 });
    expect(first.files[1]!.additions).toBe(0); // binary
    expect(first.files[2]!.path).toBe("src/new.js"); // rename

    const second = commits[1]!;
    expect(second.files).toHaveLength(0);
    expect(second.subject).toBe("Fix bug");
  });

  it("respects maxCommits (newest first)", () => {
    const stdout = buildLog([
      { fields: ["1".repeat(40), "A", "a@x", "2024-01-01T00:00:00Z", "", "one", ""] },
      { fields: ["2".repeat(40), "B", "b@x", "2024-01-02T00:00:00Z", "", "two", ""] },
    ]);
    const commits = parseGitLog(stdout, 1);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe("one");
  });

  it("skips garbage records", () => {
    expect(parseGitLog("garbage without separators", 10)).toHaveLength(0);
    expect(parseGitLog("", 10)).toHaveLength(0);
  });
});

describe("prNumberFromSubject", () => {
  it("finds squash-style PR numbers", () => {
    expect(prNumberFromSubject("Fix bug (#123)")).toBe(123);
    expect(prNumberFromSubject("Fix bug (#123) ")).toBe(123);
  });
  it("finds merge-style PR numbers", () => {
    expect(prNumberFromSubject("Merge pull request #42 from acme/feature")).toBe(42);
  });
  it("returns null otherwise", () => {
    expect(prNumberFromSubject("fix: no pr here")).toBeNull();
    expect(prNumberFromSubject("issue #7 not a pr")).toBeNull();
  });
});

describe("revertReference", () => {
  it("detects Revert subjects", () => {
    const ref = revertReference({ subject: 'Revert "Add feature"', body: "" });
    expect(ref.targetSubject).toBe("Add feature");
  });
  it("detects body sha references", () => {
    const ref = revertReference({
      subject: "some subject",
      body: "This reverts commit abc123def4567890.",
    });
    expect(ref.targetSha).toBe("abc123def4567890");
  });
  it("returns nulls for normal commits", () => {
    const ref = revertReference({ subject: "feat: normal", body: "" });
    expect(ref.targetSha).toBeNull();
    expect(ref.targetSubject).toBeNull();
  });
});
