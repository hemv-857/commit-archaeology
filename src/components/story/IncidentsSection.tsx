"use client";

import type { Incident } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { SectionHeading } from "./ErasSection";

function repairLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min later`;
  if (hours < 24) return `${hours.toFixed(1)} h later`;
  return `${Math.round(hours / 24)} days later`;
}

/**
 * `historyDays` drives the empty state: on a repo younger than the detection
 * window every pair of commits trivially qualifies, so quickfix inference is
 * suppressed (see analysis/incidents). Saying "remarkably clean history" there
 * would be wrong, and mildly embarrassing for the repo owner.
 */
const QUICKFIX_WINDOW_DAYS = 14;

export function IncidentsSection({
  incidents,
  onOpenCommit,
  historyDays,
}: {
  incidents: Incident[];
  onOpenCommit: (sha: string) => void;
  historyDays?: number;
}) {
  if (incidents.length === 0) {
    const tooYoung = historyDays !== undefined && historyDays <= QUICKFIX_WINDOW_DAYS;
    return (
      <section aria-label="Who broke what">
        <SectionHeading title="Who Broke What" />
        <div className="panel p-6 text-sm text-stone-500">
          {tooYoung ? (
            <>
              This repo is only {historyDays} day{historyDays === 1 ? "" : "s"} old — too
              young to tell a real hotfix chain from ordinary iteration, so no incidents are
              reported. Reverts would still show up here.
            </>
          ) : (
            <>No reverts or quick hotfix chains detected — remarkably clean history. 🧼</>
          )}
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Who broke what">
      <SectionHeading
        title="Who Broke What"
        hint="commits that were reverted or urgently patched, ranked by how fast the damage control arrived"
      />
      <div className="space-y-3">
        {incidents.map((inc) => (
          <article key={`${inc.culpritSha}-${inc.aftermathSha}`} className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  inc.kind === "revert"
                    ? "bg-red-500/15 text-red-400"
                    : "bg-amber-500/15 text-amber-400"
                }`}
              >
                {inc.kind === "revert" ? "reverted" : "hotfixed"}
              </span>
              <span className="font-mono text-xs text-stone-500">
                repaired {repairLabel(inc.hoursToRepair)}
              </span>
              {inc.files.slice(0, 3).map((f) => (
                <span key={f} className="chip" title={f}>
                  {f}
                </span>
              ))}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
              {/* min-w-0 is required: a 1fr track is minmax(auto, 1fr), so
                  without it these grid items refuse to shrink below their
                  content width and `truncate` never takes effect. */}
              <button
                onClick={() => onOpenCommit(inc.culpritSha)}
                className="group min-w-0 text-left"
                title={inc.culpritSubject}
              >
                <div className="truncate text-sm text-stone-200 group-hover:text-amber-300">
                  {inc.culpritSubject}
                </div>
                <div className="truncate font-mono text-xs text-stone-500">
                  {inc.culpritSha.slice(0, 7)} · {inc.culpritAuthor} ·{" "}
                  {formatDate(inc.culpritDate)}
                </div>
              </button>
              <div className="hidden text-stone-600 sm:block">→</div>
              <button
                onClick={() => onOpenCommit(inc.aftermathSha)}
                className="group min-w-0 text-left"
                title={inc.aftermathSubject}
              >
                <div className="truncate text-sm text-stone-400 group-hover:text-amber-300">
                  {inc.aftermathSubject}
                </div>
                <div className="truncate font-mono text-xs text-stone-500">
                  {inc.aftermathSha.slice(0, 7)} · {inc.aftermathAuthor} ·{" "}
                  {formatDate(inc.aftermathDate)}
                </div>
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
