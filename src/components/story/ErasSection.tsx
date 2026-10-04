"use client";

import type { Era } from "@/lib/types";
import { ERA_COLORS } from "./TimelineScrubber";

export function ErasSection({
  eras,
  selectedEraId,
  onSelectEra,
}: {
  eras: Era[];
  selectedEraId: string | null;
  onSelectEra: (id: string | null) => void;
}) {
  return (
    <section aria-label="Feature eras">
      <SectionHeading
        title="Feature Eras"
        hint={`${eras.length} distinct periods of activity, auto-clustered from commit gaps`}
      />
      <div className="grid gap-4 md:grid-cols-2">
        {eras.map((era, i) => {
          const selected = selectedEraId === era.id;
          const color = ERA_COLORS[i % ERA_COLORS.length];
          return (
            <article
              key={era.id}
              id={era.id}
              onClick={() => onSelectEra(selected ? null : era.id)}
              className={`panel cursor-pointer p-5 transition ${
                selected ? "border-amber-500/60 ring-1 ring-amber-500/30" : "hover:border-stone-600"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                  <h3 className="font-semibold leading-snug text-stone-100">{era.title}</h3>
                </div>
                <span className="shrink-0 font-mono text-xs text-stone-500">
                  {era.commitCount} commits
                </span>
              </div>
              <div className="mt-2 text-xs text-stone-500">
                {new Date(era.start).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })}{" "}
                →{" "}
                {new Date(era.end).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })}{" "}
                · {era.authors} author{era.authors === 1 ? "" : "s"} ·{" "}
                <span className="text-emerald-500/90">+{era.netAdditions.toLocaleString("en-US")}</span>{" "}
                <span className="text-red-400/90">−{era.netDeletions.toLocaleString("en-US")}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-stone-400">
                {era.beat ?? era.summary}
              </p>
              {era.beat && (
                <div className="mt-2 text-[10px] uppercase tracking-widest text-amber-500/50">
                  ✍️ AI-narrated
                </div>
              )}
              {era.dominantPaths.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {era.dominantPaths.map((p) => (
                    <span key={p} className="chip">
                      {p}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-bold tracking-tight text-stone-100">{title}</h2>
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}
