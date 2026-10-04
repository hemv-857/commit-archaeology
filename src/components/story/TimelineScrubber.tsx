"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Era, RepoStory, TimelineBucket } from "@/lib/types";

export const ERA_COLORS = ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"];

interface Props {
  story: RepoStory;
  selectedEraId: string | null;
  onSelectEra: (eraId: string | null) => void;
}

function toTime(iso: string): number {
  return new Date(iso).getTime();
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Timeline scrubber: weekly commit histogram, era bands beneath, and a
 * draggable playhead that reveals date/commit stats and highlights the
 * matching era. Auto-sweeps once on load (unless reduced motion).
 */
export function TimelineScrubber({ story, selectedEraId, onSelectEra }: Props) {
  const { timeline, eras } = story;
  const [pos, setPos] = useState(0);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const t0 = timeline.length > 0 ? toTime(timeline[0]!.start) : 0;
  const t1 =
    timeline.length > 1
      ? toTime(timeline[timeline.length - 1]!.start) + 7 * 86_400_000
      : t0 + 1;
  const span = Math.max(1, t1 - t0);

  const maxCommits = useMemo(
    () => Math.max(1, ...timeline.map((b) => b.commits)),
    [timeline]
  );

  const eraRanges = useMemo(
    () =>
      eras.map((era) => {
        const startPct = clamp01((toTime(era.start) - t0) / span);
        const endPct = clamp01((toTime(era.end) + 86_400_000 - t0) / span);
        return { era, startPct, endPct };
      }),
    [eras, t0, span]
  );

  // One gentle auto-sweep on load.
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setPos(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const duration = 1800;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setPos(p < 1 ? p : 1);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const posTime = t0 + pos * span;
  const posBucket: TimelineBucket | null = useMemo(() => {
    if (timeline.length === 0) return null;
    let best: TimelineBucket = timeline[0]!;
    let bestDist = Infinity;
    for (const b of timeline) {
      const d = Math.abs(toTime(b.start) - posTime);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, timeline, span, t0]);

  const posEra: Era | null = useMemo(() => {
    for (const era of eras) {
      if (posTime >= toTime(era.start) && posTime <= toTime(era.end) + 86_400_000) {
        return era;
      }
    }
    return null;
  }, [eras, posTime]);

  function updateFromClientX(clientX: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = clamp01((clientX - rect.left) / rect.width);
    setPos(p);
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragging.current) updateFromClientX(e.clientX);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
     
  }, []);

  if (timeline.length === 0) return null;

  const eraColor = (id: string) =>
    ERA_COLORS[eras.findIndex((e) => e.id === id) % ERA_COLORS.length] ?? "#fbbf24";

  return (
    <div>
      <div
        ref={containerRef}
        className="relative h-40 w-full cursor-ew-resize select-none touch-none"
        onPointerDown={(e) => {
          dragging.current = true;
          updateFromClientX(e.clientX);
        }}
        role="slider"
        aria-label="Timeline scrubber"
        aria-valuenow={Math.round(pos * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPos((p) => clamp01(p - 0.02));
          if (e.key === "ArrowRight") setPos((p) => clamp01(p + 0.02));
        }}
      >
        <svg
          viewBox="0 0 1000 150"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {/* commit histogram */}
          {timeline.map((b) => {
            const x = ((toTime(b.start) - t0) / span) * 1000;
            const w = Math.max(1.5, 1000 / timeline.length);
            const h = (b.commits / maxCommits) * 95;
            return (
              <rect
                key={b.start}
                x={x}
                y={100 - h}
                width={w * 0.8}
                height={h}
                rx={1}
                fill={posBucket === b ? "#fbbf24" : "#78716c"}
                opacity={posBucket === b ? 1 : 0.9}
              />
            );
          })}

          {/* era bands */}
          {eraRanges.map(({ era, startPct, endPct }) => (
            <g key={era.id} className="era-band">
              <rect
                x={startPct * 1000}
                y={108}
                width={Math.max(2, (endPct - startPct) * 1000)}
                height={14}
                rx={3}
                fill={eraColor(era.id)}
                opacity={selectedEraId && selectedEraId !== era.id ? 0.35 : 0.9}
                onClick={() => onSelectEra(selectedEraId === era.id ? null : era.id)}
              />
            </g>
          ))}

          {/* playhead */}
          <line
            x1={pos * 1000}
            x2={pos * 1000}
            y1={4}
            y2={128}
            stroke="#fde68a"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
          <circle cx={pos * 1000} cy={100} r={4} fill="#fde68a" pointerEvents="none" />
        </svg>

        {/* hover info card */}
        {posBucket && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 -translate-x-1/2 rounded-lg border border-stone-800 bg-stone-950/95 px-3 py-2 text-xs shadow-xl"
            style={{ left: `${clamp01(pos) * 100}%` }}
          >
            <div className="font-mono text-amber-300/90">
              {new Date(posBucket.start).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}
            </div>
            <div className="text-stone-300">
              {posBucket.commits} commit{posBucket.commits === 1 ? "" : "s"} ·{" "}
              {posBucket.authors} author{posBucket.authors === 1 ? "" : "s"}
            </div>
            {posEra && (
              <div className="mt-1 truncate text-stone-500" title={posEra.title}>
                Era: {posEra.title}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-1 flex justify-between font-mono text-[10px] text-stone-600">
        <span>{new Date(t0).toISOString().slice(0, 7)}</span>
        <span>drag to scrub · click an era band to highlight it</span>
        <span>{new Date(t1).toISOString().slice(0, 7)}</span>
      </div>
    </div>
  );
}
