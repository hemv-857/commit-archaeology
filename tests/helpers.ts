import type { RawCommit } from "@/server/git/log";

let counter = 0;

/** Deterministic synthetic commit factory (shas are unique, dates explicit). */
export function makeCommit(overrides: Partial<RawCommit> & { date: string }): RawCommit {
  counter += 1;
  const sha = overrides.sha ?? `sha${String(counter).padStart(6, "0")}`.padEnd(40, "0");
  const { date, ...rest } = overrides;
  return {
    sha,
    subject: "commit",
    body: "",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    date,
    parents: ["0000000000000000000000000000000000000000"],
    files: [],
    isMerge: false,
    ...rest,
  };
}

export function file(path: string, additions = 10, deletions = 2) {
  return { path, additions, deletions };
}
