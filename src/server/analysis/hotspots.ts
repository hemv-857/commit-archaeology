/**
 * File churn leaderboard + blame hotspots ("Why this ugly code exists").
 * Hotspots link the most-edited files to the PRs (merge/squash commits) that
 * repeatedly rewrote them, with excerpts from the PR discussion.
 */
import type { FileChurn, FileHotspot, PRSummary } from "@/lib/types";
import type { RawCommit } from "@/server/git/log";
import { prNumberFromSubject } from "@/server/git/log";

/**
 * Directories that are generated, vendored or build output at *any* depth.
 * These names are never used for hand-written source.
 */
const GENERATED_DIRS = [
  "node_modules/",
  "dist/",
  "coverage/",
  "__pycache__/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  "vendor/",
];

/**
 * Directories filtered only at the repo root. These names are ambiguous — a
 * project may legitimately keep source in `src/build/` or `src/target/` — so
 * matching them at any depth would hide real code, which is a worse failure
 * than leaving some generated files in the list.
 */
const ROOT_ONLY_DIRS = [
  "build/",
  "out/",
  "target/",
  "venv/",
  ".venv/",
  "uploads/",
  "upload/",
  "tool-results/",
];

/** Lockfiles: rewritten wholesale by package managers, never hand-edited. */
const LOCKFILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
]);

/**
 * True for files that should not count as "code that hurts to maintain".
 *
 * Applied to the churn leaderboard and blame hotspots only — deliberately NOT to
 * incidents, where a `.env` or `.gitignore` appearing in a diff is exactly the
 * signal you want to see.
 */
export function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (GENERATED_DIRS.some((d) => lower.includes(`/${d}`) || lower.startsWith(d))) {
    return true;
  }
  if (ROOT_ONLY_DIRS.some((d) => lower.startsWith(d))) return true;
  if (LOCKFILES.has(lower)) return true;
  if (lower.endsWith(".lock")) return true;
  // Minified/bundled output checked in by mistake.
  return /\.min\.(js|css)$/.test(lower);
}

export function computeChurn(commits: RawCommit[], cap = 25): FileChurn[] {
  const agg = new Map<
    string,
    { additions: number; deletions: number; commits: number; authors: Set<string> }
  >();
  for (const c of commits) {
    for (const f of c.files) {
      if (isGeneratedPath(f.path)) continue;
      let entry = agg.get(f.path);
      if (!entry) {
        entry = { additions: 0, deletions: 0, commits: 0, authors: new Set() };
        agg.set(f.path, entry);
      }
      entry.additions += f.additions;
      entry.deletions += f.deletions;
      entry.commits += 1;
      entry.authors.add(c.authorEmail);
    }
  }
  return [...agg.entries()]
    .map(([path, e]) => ({
      path,
      churn: e.additions + e.deletions,
      additions: e.additions,
      deletions: e.deletions,
      commits: e.commits,
      authors: e.authors.size,
    }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, cap);
}

export function buildHotspots(
  commits: RawCommit[],
  prIndex: PRSummary[],
  cap = 8
): FileHotspot[] {
  const prByNumber = new Map(prIndex.map((p) => [p.number, p]));

  interface Agg {
    churn: number;
    commits: number;
    authors: Set<string>;
    prNumbers: number[];
    firstTouch: string | null;
    lastTouch: string | null;
  }
  const agg = new Map<string, Agg>();

  // commits arrive newest-first
  for (const c of commits) {
    const prNumber = prNumberFromSubject(c.subject);
    for (const f of c.files) {
      if (isGeneratedPath(f.path)) continue;
      let entry = agg.get(f.path);
      if (!entry) {
        entry = {
          churn: 0,
          commits: 0,
          authors: new Set(),
          prNumbers: [],
          firstTouch: c.date,
          lastTouch: c.date,
        };
        agg.set(f.path, entry);
      }
      entry.churn += f.additions + f.deletions;
      entry.commits += 1;
      entry.authors.add(c.authorEmail);
      if (prNumber !== null) entry.prNumbers.push(prNumber);
      if (new Date(c.date) > new Date(entry.lastTouch!)) entry.lastTouch = c.date;
      if (new Date(c.date) < new Date(entry.firstTouch!)) entry.firstTouch = c.date;
    }
  }

  return [...agg.entries()]
    .sort((a, b) => b[1].churn - a[1].churn)
    .slice(0, cap)
    .map(([path, e]) => {
      const linkedPRs: FileHotspot["linkedPRs"] = [];
      for (const number of e.prNumbers) {
        const pr = prByNumber.get(number);
        if (!pr) continue;
        if (linkedPRs.some((x) => x.number === number)) continue;
        linkedPRs.push({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          excerpt: pr.excerpt,
          mergedAt: pr.mergedAt,
        });
        if (linkedPRs.length >= 3) break;
      }
      return {
        path,
        churn: e.churn,
        commits: e.commits,
        authors: e.authors.size,
        linkedPRs,
        createdAt: e.firstTouch,
        lastTouchedAt: e.lastTouch,
      };
    });
}
