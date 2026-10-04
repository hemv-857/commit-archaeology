"use client";

import type { RepoStory } from "@/lib/types";
import { formatNumber } from "@/lib/format";

export function StatsStrip({ story }: { story: RepoStory }) {
  const s = story.stats;
  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: "commits", value: formatNumber(s.totalCommits), sub: `+${formatNumber(s.totalPRs)} PRs` },
    {
      label: "avg PR size",
      value: s.avgPRFiles ? `${s.avgPRFiles} files` : "—",
      sub: s.avgPRAdditions ? `≈ +${formatNumber(s.avgPRAdditions)} lines` : undefined,
    },
    {
      label: "hotfix frequency",
      value: `${s.hotfixesPerMonth}/mo`,
      sub: `${s.revertCount} reverts total`,
    },
    { label: "contributors", value: formatNumber(s.contributors), sub: `bus factor ${story.busFactor.score}` },
    {
      label: "history",
      value: `${formatNumber(s.historyDays)}d`,
      sub: `since ${s.firstCommitAt.slice(0, 4)}`,
    },
    {
      label: "eras",
      value: String(story.eras.length),
      sub: `${story.incidents.length} incidents`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="panel px-4 py-3">
          <div className="text-xl font-bold text-stone-100">{c.value}</div>
          <div className="mt-0.5 text-[11px] uppercase tracking-wider text-stone-500">
            {c.label}
          </div>
          {c.sub && <div className="mt-0.5 text-[11px] text-stone-600">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}
