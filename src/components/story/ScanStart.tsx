"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ScanProgress } from "@/lib/types";

/**
 * Shown on /github.com/{owner}/{repo} when no cached story exists.
 * Starts (or joins) the scan and streams progress over SSE until done.
 */
export function ScanStart({ owner, name }: { owner: string; name: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let es: EventSource | null = null;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://github.com/${owner}/${name}` }),
        });
        const data = (await res.json()) as {
          jobId?: string;
          streamUrl?: string;
          status?: string;
          storyUrl?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Scan failed to start.");
          return;
        }
        if (data.status === "ready" && data.storyUrl) {
          router.refresh();
          return;
        }
        if (!data.jobId || !data.streamUrl) {
          setError("Scan failed to start.");
          return;
        }
        setJobId(data.jobId);

        es = new EventSource(data.streamUrl);
        es.addEventListener("progress", (ev) => {
          try {
            setProgress(JSON.parse((ev as MessageEvent).data) as ScanProgress);
          } catch {
            /* ignore malformed frame */
          }
        });
        es.addEventListener("end", () => {
          es?.close();
          if (!cancelled) router.refresh();
        });
        es.onerror = () => {
          // Fall back to polling the job endpoint; SSE may be buffering.
          es?.close();
          const poll = async () => {
            try {
              const res2 = await fetch(`/api/scan/${data.jobId}`, { cache: "no-store" });
              if (!res2.ok) return;
              const job = (await res2.json()) as {
                status: string;
                progress: ScanProgress;
                error: string | null;
              };
              if (cancelled) return;
              setProgress(job.progress);
              if (job.status === "done") router.refresh();
              if (job.status === "failed") setError(job.error ?? "Scan failed.");
              if (job.status === "queued" || job.status === "running") {
                setTimeout(poll, 2000);
              }
            } catch {
              if (!cancelled) setTimeout(poll, 3000);
            }
          };
          setTimeout(poll, 2000);
        };
      } catch {
        if (!cancelled) setError("Network error while starting the scan.");
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [owner, name, router]);

  const stageIcons: Record<string, string> = {
    queued: "⏳",
    validate: "🔍",
    clone: "🪣",
    history: "📜",
    prs: "🔀",
    compute: "🧮",
    ai: "✍️",
    persist: "💾",
    done: "✅",
    error: "💥",
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6">
      <div className="panel w-full p-8 rise">
        <div className="font-mono text-sm text-stone-500">
          github.com/{owner}/{name}
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          Excavating {owner}/{name}…
        </h1>
        {error ? (
          <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
            {error}
          </div>
        ) : (
          <div className="mt-6">
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
                style={{ width: `${progress?.pct ?? 2}%` }}
              />
            </div>
            <div className="mt-4 flex items-center gap-3 text-sm text-stone-300">
              <span className="text-lg">{stageIcons[progress?.stage ?? "queued"] ?? "⛏️"}</span>
              <span className={progress?.stage === "done" ? "" : "pulse-bar"}>
                {progress?.message ?? "Queued…"}
              </span>
              <span className="ml-auto font-mono text-xs text-stone-500">
                {jobId ? `${jobId.slice(0, 8)}` : ""} {progress?.pct ?? 0}%
              </span>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-2 text-xs text-stone-500 sm:grid-cols-4">
              {(
                [
                  ["clone", "Clone"],
                  ["history", "History"],
                  ["prs", "PRs"],
                  ["compute", "Analysis"],
                ] as Array<[string, string]>
              ).map(([stage, label]) => {
                const order = ["queued", "validate", "clone", "history", "prs", "compute", "ai", "persist", "done", "error"];
                const currentIdx = order.indexOf(progress?.stage ?? "queued");
                const stageIdx = order.indexOf(stage);
                const done = currentIdx > stageIdx || progress?.stage === "done";
                const active = currentIdx === stageIdx;
                return (
                  <div
                    key={stage}
                    className={`rounded-lg border px-3 py-2 ${
                      done
                        ? "border-emerald-500/30 text-emerald-400/90"
                        : active
                          ? "border-amber-500/40 text-amber-300"
                          : "border-stone-800 text-stone-600"
                    }`}
                  >
                    {done ? "✓ " : active ? "▸ " : "· "}
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
