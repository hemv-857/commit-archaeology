"use client";

import type { RepoStory } from "@/lib/types";
import { SectionHeading } from "./ErasSection";
import { formatNumber, formatDate, truncate } from "@/lib/format";

/**
 * "Why This Ugly Code Exists" — the most-edited files, with the PR
 * discussions that kept rewriting them.
 */
export function HotspotsSection({
  story,
  onOpenFile,
}: {
  story: RepoStory;
  onOpenFile: (path: string) => void;
}) {
  if (story.hotspots.length === 0) return null;
  const maxChurn = Math.max(...story.hotspots.map((h) => h.churn), 1);
  return (
    <section aria-label="Why this ugly code exists">
      <SectionHeading
        title="Why This Ugly Code Exists"
        hint="blame hotspots — the files that get rewritten over and over, and the PR discussions behind them"
      />
      <div className="space-y-3">
        {story.hotspots.map((h) => (
          <article key={h.path} className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <button
                onClick={() => onOpenFile(h.path)}
                className="group min-w-0 text-left"
              >
                <div className="truncate font-mono text-sm text-amber-300/90 group-hover:text-amber-200">
                  {h.path}
                </div>
              </button>
              <div className="font-mono text-xs text-stone-500">
                {formatNumber(h.churn)} lines churned · {h.commits} edits · {h.authors} authors
                {h.createdAt ? ` · since ${formatDate(h.createdAt)}` : ""}
              </div>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400"
                style={{ width: `${(h.churn / maxChurn) * 100}%` }}
              />
            </div>
            {h.linkedPRs.length > 0 && (
              <ul className="mt-3 space-y-2">
                {h.linkedPRs.map((pr) => (
                  <li key={pr.number} className="rounded-lg border border-stone-800/70 p-3">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-stone-200 transition hover:text-amber-300"
                    >
                      #{pr.number} — {truncate(pr.title, 90)}
                    </a>
                    {pr.excerpt && (
                      <p className="mt-1 line-clamp-3 text-xs italic leading-relaxed text-stone-500">
                        “{pr.excerpt}”
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2 text-xs">
              <a
                href={`${story.repo.url}/blame/HEAD/${h.path}`}
                target="_blank"
                rel="noreferrer"
                className="text-stone-500 transition hover:text-amber-300"
              >
                git blame ↗
              </a>
              <a
                href={`${story.repo.url}/commits/HEAD/${h.path}`}
                target="_blank"
                rel="noreferrer"
                className="text-stone-500 transition hover:text-amber-300"
              >
                full history ↗
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
