/**
 * "Feature Eras" — deterministic clustering of commit history into periods
 * of related activity:
 *   1. split on calendar gaps > ERA_GAP_DAYS (quiet periods end an era)
 *   2. merge eras with fewer than MIN_ERA_COMMITS commits into a neighbour
 *   3. cap the number of eras by merging the sparsest neighbours
 *   4. title each era from its dominant path prefixes + date range
 */
import type { Era } from "@/lib/types";
import type { RawCommit } from "@/server/git/log";

const ERA_GAP_DAYS = 21;
const MIN_ERA_COMMITS = 6;
const MAX_ERAS = 24;
const DAY_MS = 86_400_000;

export function buildEras(commitsAsc: RawCommit[]): Era[] {
  if (commitsAsc.length === 0) return [];

  // 1. gap split
  const rough: RawCommit[][] = [[commitsAsc[0]!]];
  for (let i = 1; i < commitsAsc.length; i++) {
    const prev = commitsAsc[i - 1]!;
    const cur = commitsAsc[i]!;
    const gapDays = (new Date(cur.date).getTime() - new Date(prev.date).getTime()) / DAY_MS;
    if (gapDays > ERA_GAP_DAYS) rough.push([]);
    rough[rough.length - 1]!.push(cur);
  }

  // 2. merge tiny eras
  const merged: RawCommit[][] = [];
  for (const group of rough) {
    if (merged.length > 0 && group.length < MIN_ERA_COMMITS) {
      merged[merged.length - 1]!.push(...group);
    } else if (
      merged.length > 0 &&
      merged[merged.length - 1]!.length < MIN_ERA_COMMITS
    ) {
      merged[merged.length - 1]!.push(...group);
    } else {
      merged.push([...group]);
    }
  }

  // 3. cap era count: repeatedly merge the era with the fewest commits into
  // its temporally closest neighbour.
  while (merged.length > MAX_ERAS) {
    let smallest = 0;
    for (let i = 1; i < merged.length; i++) {
      if (merged[i]!.length < merged[smallest]!.length) smallest = i;
    }
    const into =
      smallest === 0
        ? 1
        : smallest === merged.length - 1
          ? smallest - 1
          : merged[smallest - 1]!.length <= merged[smallest + 1]!.length
            ? smallest - 1
            : smallest + 1;
    const lo = Math.min(smallest, into);
    const hi = Math.max(smallest, into);
    const combined = [...merged[lo]!, ...merged[hi]!].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    merged.splice(lo, hi - lo + 1, combined);
  }

  return merged.map((group, i) => finishEra(group, i));
}

function finishEra(group: RawCommit[], index: number): Era {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const authors = new Set(group.map((c) => `${c.authorEmail}`));
  const pathCounts = new Map<string, number>();
  let additions = 0;
  let deletions = 0;
  for (const c of group) {
    for (const f of c.files) {
      additions += f.additions;
      deletions += f.deletions;
      const prefix = pathPrefix(f.path);
      if (prefix) pathCounts.set(prefix, (pathCounts.get(prefix) ?? 0) + 1);
    }
  }
  const dominantPaths = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p]) => p);

  return {
    id: `era-${index + 1}`,
    title: eraTitle(dominantPaths, first.date, last.date),
    start: first.date,
    end: last.date,
    startSha: first.sha,
    endSha: last.sha,
    commitCount: group.length,
    authors: authors.size,
    dominantPaths,
    beat: null,
    summary: templateSummary(group.length, authors.size, dominantPaths, first.date, last.date),
    netAdditions: additions,
    netDeletions: deletions,
  };
}

function pathPrefix(p: string): string | null {
  if (!p) return null;
  const parts = p.split("/");
  if (parts.length === 1) return p;
  return parts.slice(0, 2).join("/");
}

export function eraTitle(
  paths: string[],
  startIso: string,
  endIso: string
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" });
  const span =
    startIso.slice(0, 7) === endIso.slice(0, 7)
      ? fmt(startIso)
      : `${fmt(startIso)} – ${fmt(endIso)}`;
  const focus = paths.slice(0, 2).join(", ");
  return focus ? `${span} · ${focus}` : span;
}

function templateSummary(
  commits: number,
  authors: number,
  paths: string[],
  startIso: string,
  endIso: string
): string {
  const days = Math.max(
    1,
    Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / DAY_MS)
  );
  const focus = paths.length ? `, mostly around ${paths.slice(0, 2).join(" and ")}` : "";
  return `${commits} commits by ${authors} author${authors === 1 ? "" : "s"} over ${days} days${focus}.`;
}
