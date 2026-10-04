"use client";

import type { FileChurn, RepoStory } from "@/lib/types";
import { SectionHeading } from "./ErasSection";
import { formatNumber } from "@/lib/format";

/** File churn leaderboard: most-edited files are the pain points. */
export function ChurnSection({
  churn,
  onOpenFile,
}: {
  churn: FileChurn[];
  onOpenFile: (path: string) => void;
}) {
  if (churn.length === 0) return null;
  const maxChurn = Math.max(...churn.map((c) => c.churn), 1);
  return (
    <section aria-label="File churn leaderboard">
      <SectionHeading
        title="Churn Leaderboard"
        hint="most-edited files — churn predicts pain; the top entries are where the design fights back"
      />
      <div className="panel overflow-hidden">
        <ul className="divide-y divide-stone-900">
          {churn.map((c, i) => (
            <li
              key={c.path}
              onClick={() => onOpenFile(c.path)}
              className="cursor-pointer px-4 py-3 transition hover:bg-stone-900/60"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-stone-600">
                    {i + 1}
                  </span>
                  <span className="truncate font-mono text-sm text-stone-200">{c.path}</span>
                </div>
                <div className="shrink-0 font-mono text-xs text-stone-500">
                  <span className="text-emerald-500/80">+{formatNumber(c.additions)}</span>{" "}
                  <span className="text-red-400/70">−{formatNumber(c.deletions)}</span>
                  <span className="ml-2 text-stone-400">{formatNumber(c.churn)}</span>
                </div>
              </div>
              <div className="ml-9 mt-1.5 h-1 w-[calc(100%-2.25rem)] overflow-hidden rounded-full bg-stone-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-400"
                  style={{ width: `${(c.churn / maxChurn) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function StoryFooterMeta({ story }: { story: RepoStory }) {
  return (
    <div className="pt-2 text-center font-mono text-[11px] text-stone-600">
      scanned {new Date(story.scannedAt).toUTCString()} · analyzer v
      {story.meta.analyzerVersion} · {story.meta.githubApiCalls} GitHub API calls ·{" "}
      {(story.meta.analysisMs / 1000).toFixed(1)}s analysis · AI beats: {story.meta.aiBeats}
    </div>
  );
}
