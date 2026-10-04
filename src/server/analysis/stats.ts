/**
 * Top-level stats strip + weekly timeline buckets.
 */
import type { StoryStats, TimelineBucket, Incident, PRSummary } from "@/lib/types";
import type { RawCommit } from "@/server/git/log";
import { isFixLike } from "./incidents";

const WEEK_MS = 7 * 86_400_000;
const MAX_TIMELINE_BUCKETS = 400;

export function computeStats(
  commitsAsc: RawCommit[],
  prTotalCount: number,
  matchedPRs: PRSummary[],
  incidents: Incident[],
  totalCommitsInHistory: number
): StoryStats {
  const first = commitsAsc[0];
  const last = commitsAsc[commitsAsc.length - 1];
  const contributors = new Set(commitsAsc.map((c) => c.authorEmail || c.authorName)).size;

  // Hotfix frequency: fix-like commits per month over the trailing 90 days
  // (or the whole history, whichever is shorter).
  let hotfixesPerMonth = 0;
  if (last) {
    const lastMs = new Date(last.date).getTime();
    const firstMs = new Date(first?.date ?? last.date).getTime();
    const windowDays = Math.min(90, Math.max(30, (lastMs - firstMs) / 86_400_000));
    const windowStart = lastMs - windowDays * 86_400_000;
    const hotfixes = commitsAsc.filter(
      (c) => new Date(c.date).getTime() >= windowStart && isFixLike(c.subject)
    ).length;
    hotfixesPerMonth = Math.round((hotfixes / (windowDays / 30)) * 10) / 10;
  }

  const prCount = matchedPRs.length;
  const avgPRFiles =
    prCount > 0
      ? Math.round((matchedPRs.reduce((a, p) => a + p.changedFiles, 0) / prCount) * 10) / 10
      : 0;
  const avgPRAdditions =
    prCount > 0
      ? Math.round(matchedPRs.reduce((a, p) => a + p.additions, 0) / prCount)
      : 0;

  const historyDays =
    first && last
      ? Math.max(
          1,
          Math.round(
            (new Date(last.date).getTime() - new Date(first.date).getTime()) / 86_400_000
          )
        )
      : 0;

  return {
    totalCommits: totalCommitsInHistory || commitsAsc.length,
    totalPRs: prTotalCount,
    matchedPRs: prCount,
    avgPRFiles,
    avgPRAdditions,
    hotfixesPerMonth,
    revertCount: incidents.filter((i) => i.kind === "revert").length,
    contributors,
    firstCommitAt: first?.date ?? new Date().toISOString(),
    lastCommitAt: last?.date ?? new Date().toISOString(),
    historyDays,
  };
}

export function buildTimeline(commitsAsc: RawCommit[]): TimelineBucket[] {
  if (commitsAsc.length === 0) return [];
  const firstMs = new Date(commitsAsc[0]!.date).getTime();
  const lastMs = new Date(commitsAsc[commitsAsc.length - 1]!.date).getTime();

  const spanWeeks = Math.ceil((lastMs - firstMs) / WEEK_MS) + 1;
  const bucketMs =
    spanWeeks <= MAX_TIMELINE_BUCKETS ? WEEK_MS : WEEK_MS * Math.ceil(spanWeeks / MAX_TIMELINE_BUCKETS);

  const buckets: TimelineBucket[] = [];
  let current: { start: number; commits: number; authors: Set<string> } | null = null;

  for (const c of commitsAsc) {
    const t = new Date(c.date).getTime();
    // Align bucket starts to UTC Monday for weeks.
    const rawStart = Math.floor(t / bucketMs) * bucketMs;
    const start = bucketMs === WEEK_MS ? alignMonday(rawStart) : rawStart;
    if (!current || current.start !== start) {
      if (current) {
        buckets.push({
          start: new Date(current.start).toISOString().slice(0, 10),
          commits: current.commits,
          authors: current.authors.size,
        });
      }
      current = { start, commits: 0, authors: new Set() };
    }
    current.commits += 1;
    current.authors.add(c.authorEmail || c.authorName);
  }
  if (current) {
    buckets.push({
      start: new Date(current.start).toISOString().slice(0, 10),
      commits: current.commits,
      authors: current.authors.size,
    });
  }
  return buckets;
}

function alignMonday(t: number): number {
  const d = new Date(t);
  const day = d.getUTCDay(); // 0 = Sunday
  const shift = day === 0 ? 6 : day - 1;
  return t - shift * 86_400_000;
}
