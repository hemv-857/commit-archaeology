"use client";

import type { AuthorStat, BusFactor } from "@/lib/types";
import { SectionHeading } from "./ErasSection";
import { formatNumber, formatMonth } from "@/lib/format";

const LABEL_STYLES: Record<BusFactor["label"], string> = {
  critical: "bg-red-500/15 text-red-400 border-red-500/30",
  "high-risk": "bg-orange-500/15 text-orange-400 border-orange-500/30",
  moderate: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

export function AuthorsSection({
  authors,
  busFactor,
  onOpenAuthor,
}: {
  authors: AuthorStat[];
  busFactor: BusFactor;
  onOpenAuthor: (index: number) => void;
}) {
  // Union of months across top authors → x axis.
  const top = authors.slice(0, 8);
  const months = [...new Set(top.flatMap((a) => a.perMonth.map((m) => m.month)))].sort();
  const monthMax = Math.max(
    1,
    ...months.map((m) => top.reduce((acc, a) => acc + (a.perMonth.find((x) => x.month === m)?.commits ?? 0), 0))
  );
  const maxAuthorCommits = Math.max(1, ...authors.map((a) => a.commits));

  return (
    <section aria-label="Authors and bus factor">
      <SectionHeading
        title="The Dig Team"
        hint="who actually writes this code — and how much rests on each of them"
      />
      {/* min-w-0 on both panels is load-bearing: the contribution graph below is
          min-w-[520px], and without it the grid track sizes to max-content and
          drags the whole page into horizontal overflow on narrow screens. */}
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* Bus factor card */}
        <div className="panel min-w-0 p-5">
          <div className="text-xs uppercase tracking-widest text-stone-500">Bus factor</div>
          <div className="mt-3 flex items-center gap-4">
            <div className="relative flex h-20 w-20 items-center justify-center">
              <svg viewBox="0 0 36 36" className="absolute inset-0 h-full w-full -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#292524" strokeWidth="3.5" />
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  fill="none"
                  stroke={
                    busFactor.label === "healthy"
                      ? "#34d399"
                      : busFactor.label === "moderate"
                        ? "#fbbf24"
                        : "#f87171"
                  }
                  strokeWidth="3.5"
                  strokeDasharray={`${Math.min(100, (busFactor.score / 6) * 100)} 100`}
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-2xl font-bold">{busFactor.score}</span>
            </div>
            <div className="min-w-0">
              <span
                className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${LABEL_STYLES[busFactor.label]}`}
              >
                {busFactor.label}
              </span>
              <p className="mt-2 text-xs leading-relaxed text-stone-500">
                {busFactor.score} author{busFactor.score === 1 ? "" : "s"} account for ≥50% of all
                commits ({busFactor.topAuthorsShare * 100}%).{" "}
                {busFactor.score <= 2
                  ? "If they get hit by a bus, this repo is in trouble."
                  : "Knowledge is reasonably spread."}
              </p>
            </div>
          </div>
          <div className="mt-4 text-xs text-stone-500">
            {busFactor.contributors} contributors · top author has{" "}
            {formatNumber(busFactor.topAuthorCommits)} commits
          </div>
        </div>

        {/* Contribution graph */}
        <div className="panel min-w-0 p-5">
          <div className="text-xs uppercase tracking-widest text-stone-500">
            Commits per month, stacked
          </div>
          <div className="scroll-thin mt-4 overflow-x-auto">
            <div className="min-w-[520px]">
              <div className="flex h-32 items-end gap-[2px]">
                {months.map((m) => {
                  const stacks = top
                    .map((a, i) => ({
                      commits: a.perMonth.find((x) => x.month === m)?.commits ?? 0,
                      color: AUTHOR_COLORS[i % AUTHOR_COLORS.length],
                    }))
                    .filter((s) => s.commits > 0);
                  const total = stacks.reduce((a, s) => a + s.commits, 0);
                  return (
                    <div
                      key={m}
                      className="group relative flex min-w-[10px] flex-1 flex-col justify-end"
                      title={`${m}: ${total} commits`}
                      style={{ height: "100%" }}
                    >
                      <div
                        className="flex w-full flex-col justify-end rounded-sm"
                        style={{ height: `${(total / monthMax) * 100}%` }}
                      >
                        {stacks.map((s, i) => (
                          <div
                            key={i}
                            style={{
                              height: `${(s.commits / Math.max(1, total)) * 100}%`,
                              backgroundColor: s.color,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex gap-[2px] text-[9px] text-stone-600">
                {months.map((m, i) => (
                  <div key={m} className="min-w-[10px] flex-1 text-center">
                    {i % Math.ceil(months.length / 12) === 0 ? formatMonth(m) : ""}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            {top.map((a, i) => (
              <button
                key={a.email || a.name}
                onClick={() => onOpenAuthor(authors.indexOf(a))}
                className="group flex items-center gap-1.5 text-xs text-stone-400 transition hover:text-amber-300"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: AUTHOR_COLORS[i % AUTHOR_COLORS.length] }}
                />
                {a.name}
                <span className="font-mono text-[10px] text-stone-600">
                  {Math.round((a.commits / maxAuthorCommits) * 100)}%
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Author table */}
      <div className="panel mt-4 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-stone-800 text-xs uppercase tracking-wider text-stone-500">
              <th className="px-4 py-2.5 font-medium">Author</th>
              <th className="px-4 py-2.5 font-medium">Commits</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Lines</th>
              <th className="hidden px-4 py-2.5 font-medium md:table-cell">Active</th>
            </tr>
          </thead>
          <tbody>
            {authors.slice(0, 12).map((a) => (
              <tr
                key={a.email || a.name}
                onClick={() => onOpenAuthor(authors.indexOf(a))}
                className="cursor-pointer border-b border-stone-900 transition last:border-0 hover:bg-stone-900/60"
              >
                <td className="px-4 py-2.5 text-stone-200">{a.name}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-stone-300">{a.commits}</span>
                    <div className="h-1 w-24 overflow-hidden rounded-full bg-stone-800">
                      <div
                        className="h-full rounded-full bg-amber-500/70"
                        style={{ width: `${(a.commits / maxAuthorCommits) * 100}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="hidden px-4 py-2.5 font-mono text-xs text-stone-500 sm:table-cell">
                  <span className="text-emerald-500/80">+{formatNumber(a.additions)}</span>{" "}
                  <span className="text-red-400/70">−{formatNumber(a.deletions)}</span>
                </td>
                <td className="hidden px-4 py-2.5 text-xs text-stone-500 md:table-cell">
                  {a.firstCommitAt.slice(0, 7)} → {a.lastCommitAt.slice(0, 7)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const AUTHOR_COLORS = [
  "#fbbf24",
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#a78bfa",
  "#fb923c",
  "#4ade80",
  "#38bdf8",
];
