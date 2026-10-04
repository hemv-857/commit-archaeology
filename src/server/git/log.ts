/**
 * Commit history extraction from a (bare) git repository.
 *
 * One `git log --numstat` pass yields per-commit metadata plus per-file
 * additions/deletions. `--diff-merges=first-parent` makes merge commits show
 * their mainline diff, which is what maps merge commits (i.e. PRs) to files.
 *
 * Output format (robust to newlines in bodies):
 *   header fields are NUL-separated, each record ends with \x1e,
 *   followed by numstat lines "added\tdeleted\tpath".
 */
import type { CommitEntry } from "@/lib/types";
import { logger } from "@/server/logger";
import { config } from "@/server/config";
import { runGit } from "./exec";

export interface RawCommit {
  sha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO
  parents: string[];
  files: Array<{ path: string; additions: number; deletions: number }>;
  isMerge: boolean;
}

/**
 * Record-leading \x1e + NUL-separated fields. Each post-split chunk is fully
 * self-contained: fields[0..6] = sha, author name, author email, date,
 * parents, subject, body (bodies may contain newlines safely), and
 * fields[7] (optional) = the numstat block for that commit.
 */
const LOG_FORMAT =
  "%x1e%H%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b%x00";

export interface HistoryResult {
  commits: RawCommit[];
  /** true when the repo has more commits than we analyzed (MAX_COMMIT_COUNT). */
  truncated: boolean;
  ms: number;
}

export async function readHistory(
  repoDir: string,
  maxCommits: number
): Promise<HistoryResult> {
  const started = Date.now();
  const args = [
    "-c",
    "core.quotepath=false",
    "log",
    "-M",
    "--diff-merges=first-parent",
    "--numstat",
    "--no-color",
    `--max-count=${maxCommits + 1}`,
    `--pretty=format:${LOG_FORMAT}`,
    "HEAD",
  ];

  // Bounded: runGit enforces a wall-clock timeout and an output cap so a
  // pathological repository can never hang a scan worker indefinitely.
  const { stdout } = await runGit(args, {
    cwd: repoDir,
    timeoutMs: config().cloneTimeoutMs,
  });

  const commits = parseGitLog(stdout, maxCommits);
  const ms = Date.now() - started;
  logger().debug({ commits: commits.length, ms }, "git log parsed");
  return { commits, truncated: commits.length >= maxCommits, ms };
}

export function parseGitLog(stdout: string, maxCommits: number): RawCommit[] {
  const commits: RawCommit[] = [];
  if (!stdout) return commits;

  const chunks = stdout.split("\x1e");
  for (const chunk of chunks) {
    if (!chunk) continue;
    const fields = chunk.split("\x00");
    if (fields.length < 7) continue;
    const [sha, authorName, authorEmail, date, parentsRaw, subject, body] = fields as [
      string, string, string, string, string, string, string
    ];
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;

    const files: RawCommit["files"] = [];
    const numstatBlock = fields[7] ?? "";
    for (const line of numstatBlock.split("\n")) {
      if (!line.trim()) continue;
      const tabs = line.split("\t");
      if (tabs.length < 3) continue;
      const addedRaw = tabs[0];
      const deletedRaw = tabs[1];
      let p = tabs.slice(2).join("\t");
      // Rename paths arrive as "old => new" or "dir/{old => new}".
      const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
      if (brace) p = `${brace[1]}${brace[3]}${brace[4]}`;
      else {
        const arrow = p.match(/^(.*) => (.*)$/);
        if (arrow) p = arrow[2] ?? p;
      }
      files.push({
        path: p,
        additions: addedRaw === "-" ? 0 : Number(addedRaw) || 0,
        deletions: deletedRaw === "-" ? 0 : Number(deletedRaw) || 0,
      });
    }

    commits.push({
      sha,
      subject: subject.trim(),
      body: body.trim(),
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim().toLowerCase(),
      date: new Date(date).toISOString(),
      parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
      files,
      isMerge: (parentsRaw?.split(" ").filter(Boolean).length ?? 0) > 1,
    });
    if (commits.length >= maxCommits) break;
  }
  return commits;
}

/** Extract a PR number from a squash/merge commit subject. */
export function prNumberFromSubject(subject: string): number | null {
  // Squash-merge style: "Fix bug (#123)"
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  if (squash) return Number(squash[1]);
  // Merge-commit style: "Merge pull request #123 from acme/feature"
  const merge = subject.match(/merge pull request #(\d+) from/i);
  if (merge) return Number(merge[1]);
  return null;
}

/** A revert commit: `Revert "..."` subject or a `This reverts commit <sha>` body. */
export function revertReference(commit: {
  subject: string;
  body: string;
}): { kind: "subject" | "body"; targetSubject: string | null; targetSha: string | null } {
  const subj = commit.subject.match(/^Revert\s+"(.+?)"(\s*\(#\d+\))?$/i);
  if (subj) return { kind: "subject", targetSubject: subj[1] ?? null, targetSha: null };
  const body = commit.body.match(/This reverts commit ([0-9a-f]{7,40})/i);
  if (body) {
    return { kind: "body", targetSubject: null, targetSha: body[1] ?? null };
  }
  return { kind: "subject", targetSubject: null, targetSha: null };
}

export function toCommitEntry(c: RawCommit): CommitEntry {
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    subject: c.subject,
    authorName: c.authorName,
    authorEmail: c.authorEmail,
    date: c.date,
    isMerge: c.isMerge,
    prNumber: prNumberFromSubject(c.subject),
    files: c.files.slice(0, 20).map((f) => f.path),
    additions: c.files.reduce((a, f) => a + f.additions, 0),
    deletions: c.files.reduce((a, f) => a + f.deletions, 0),
  };
}
