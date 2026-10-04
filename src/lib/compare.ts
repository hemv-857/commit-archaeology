/**
 * Builds a side-by-side comparison of two analysed repositories.
 *
 * Pure and dependency-free so it can be unit-tested. Deliberately conservative
 * about what counts as "better": more commits or more eras is not better, and a
 * longer history is not better. Only metrics with a defensible direction are
 * marked.
 */

import type { Era, RepoStory } from "@/lib/types";

export type Side = "a" | "b" | null;

export interface ComparisonRow {
  label: string;
  a: string;
  b: string;
  /** Which side is healthier, or null when the metric is neutral. */
  better: Side;
  /** Shown under the row to explain the direction, when applicable. */
  hint?: string;
}

/** Higher is healthier. */
const HIGHER_IS_BETTER = new Set(["contributors", "bus factor", "average PR size"]);
/** Lower is healthier. */
const LOWER_IS_BETTER = new Set([
  "hotfix frequency",
  "reverts",
  "incidents",
  "top author share",
]);

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

interface Metric {
  label: string;
  raw: (s: RepoStory) => number;
  format: (s: RepoStory) => string;
  hint?: string;
}

const METRICS: Metric[] = [
  { label: "commits", raw: (s) => s.stats.totalCommits, format: (s) => num(s.stats.totalCommits) },
  { label: "contributors", raw: (s) => s.stats.contributors, format: (s) => num(s.stats.contributors) },
  { label: "pull requests", raw: (s) => s.stats.totalPRs, format: (s) => num(s.stats.totalPRs) },
  { label: "feature eras", raw: (s) => s.eras.length, format: (s) => num(s.eras.length) },
  {
    label: "incidents",
    raw: (s) => s.incidents.length,
    format: (s) => num(s.incidents.length),
  },
  {
    label: "hotfix frequency",
    raw: (s) => s.stats.hotfixesPerMonth,
    format: (s) => `${s.stats.hotfixesPerMonth}/mo`,
    hint: "lower is healthier",
  },
  {
    label: "reverts",
    raw: (s) => s.stats.revertCount,
    format: (s) => num(s.stats.revertCount),
    hint: "lower is healthier",
  },
  {
    label: "bus factor",
    raw: (s) => s.busFactor.score,
    format: (s) => `${s.busFactor.score} (${s.busFactor.label})`,
    hint: "higher is healthier",
  },
  {
    label: "top author share",
    raw: (s) => s.busFactor.topAuthorsShare,
    format: (s) => pct(s.busFactor.topAuthorsShare),
    hint: "lower means knowledge is spread",
  },
  {
    label: "history",
    raw: (s) => s.stats.historyDays,
    format: (s) => `${num(s.stats.historyDays)} days`,
  },
  { label: "hotspots tracked", raw: (s) => s.hotspots.length, format: (s) => num(s.hotspots.length) },
  {
    label: "avg PR size",
    raw: (s) => s.stats.avgPRFiles,
    format: (s) => `${s.stats.avgPRFiles} ${s.stats.avgPRFiles === 1 ? "file" : "files"}`,
  },
];

function betterFor(label: string, a: number, b: number): Side {
  if (a === b) return null;
  if (HIGHER_IS_BETTER.has(label)) return a > b ? "a" : "b";
  if (LOWER_IS_BETTER.has(label)) return a < b ? "a" : "b";
  return null; // neutral: commits, eras, history, hotspots
}

export function buildComparison(a: RepoStory, b: RepoStory): {
  rows: ComparisonRow[];
  erasA: Era[];
  erasB: Era[];
  maxEras: number;
} {
  const rows = METRICS.map((m) => {
    const av = m.raw(a);
    const bv = m.raw(b);
    return {
      label: m.label,
      a: m.format(a),
      b: m.format(b),
      better: betterFor(m.label, av, bv),
      ...(m.hint ? { hint: m.hint } : {}),
    };
  });

  return {
    rows,
    erasA: a.eras,
    erasB: b.eras,
    maxEras: Math.max(a.eras.length, b.eras.length),
  };
}

/** Compact verdict, e.g. "vercel/next.js looks healthier on 4 of 5 comparable metrics". */
export function comparisonVerdict(aSlug: string, bSlug: string, rows: ComparisonRow[]): string {
  const wins = rows.filter((r) => r.better !== null);
  if (wins.length === 0) return "No metric here has a clear healthier direction.";
  const aWins = wins.filter((r) => r.better === "a").length;
  const bWins = wins.length - aWins;
  if (aWins === bWins) {
    return `${aSlug} and ${bSlug} split the ${wins.length} comparable metrics evenly.`;
  }
  const [winner, count] = aWins > bWins ? [aSlug, aWins] : [bSlug, bWins];
  return `${winner} looks healthier on ${count} of ${wins.length} comparable metrics.`;
}