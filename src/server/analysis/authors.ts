/**
 * Author contribution stats + bus-factor score.
 *
 * Bus factor = the smallest number of authors whose commits together account
 * for >= 50% of history. 1 → critical (one person writes half of everything),
 * 5+ → healthy.
 */
import type { AuthorStat, AuthorMonthly, BusFactor } from "@/lib/types";
import type { RawCommit } from "@/server/git/log";

const MAX_AUTHORS = 50;

export function computeAuthors(commits: RawCommit[]): AuthorStat[] {
  interface Agg {
    name: string;
    email: string;
    commits: number;
    additions: number;
    deletions: number;
    first: string;
    last: string;
    months: Map<string, number>;
    paths: Map<string, number>;
  }
  const agg = new Map<string, Agg>();
  for (const c of commits) {
    const key = c.authorEmail || c.authorName.toLowerCase();
    let entry = agg.get(key);
    if (!entry) {
      entry = {
        name: c.authorName,
        email: c.authorEmail,
        commits: 0,
        additions: 0,
        deletions: 0,
        first: c.date,
        last: c.date,
        months: new Map(),
        paths: new Map(),
      };
      agg.set(key, entry);
    }
    entry.commits += 1;
    entry.name = c.authorName || entry.name; // prefer latest non-empty
    for (const f of c.files) {
      entry.additions += f.additions;
      entry.deletions += f.deletions;
      if (entry.paths.size < 500) {
        entry.paths.set(f.path, (entry.paths.get(f.path) ?? 0) + 1);
      }
    }
    if (new Date(c.date) > new Date(entry.last)) entry.last = c.date;
    if (new Date(c.date) < new Date(entry.first)) entry.first = c.date;
    const month = c.date.slice(0, 7);
    entry.months.set(month, (entry.months.get(month) ?? 0) + 1);
  }

  return [...agg.values()]
    .sort((a, b) => b.commits - a.commits)
    .slice(0, MAX_AUTHORS)
    .map((e): AuthorStat => {
      const perMonth: AuthorMonthly[] = [...e.months.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, commits]) => ({ month, commits }));
      const topPaths = [...e.paths.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p]) => p);
      return {
        name: e.name,
        email: e.email,
        login: null,
        commits: e.commits,
        additions: e.additions,
        deletions: e.deletions,
        firstCommitAt: e.first,
        lastCommitAt: e.last,
        perMonth,
        topPaths,
      };
    });
}

export function computeBusFactor(
  authors: AuthorStat[],
  totalCommits: number
): BusFactor {
  if (totalCommits === 0 || authors.length === 0) {
    return {
      score: 1,
      label: "critical",
      topAuthorsShare: 1,
      contributors: 0,
      topAuthorCommits: 0,
    };
  }
  const topAuthorCommits = authors[0]!.commits;
  let cumulative = 0;
  let k = 0;
  for (const a of authors) {
    cumulative += a.commits;
    k += 1;
    if (cumulative / totalCommits >= 0.5) break;
  }
  const score = Math.min(k, 6);
  const label: BusFactor["label"] =
    score <= 1 ? "critical" : score === 2 ? "high-risk" : score <= 4 ? "moderate" : "healthy";
  return {
    score,
    label,
    topAuthorsShare: Math.round((cumulative / totalCommits) * 100) / 100,
    contributors: authors.length,
    topAuthorCommits,
  };
}
