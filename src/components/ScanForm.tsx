"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isRepoUrlValid, parseRepoUrl } from "@/lib/repo-url";

const PRESETS = [
  { owner: "vercel", name: "next.js", blurb: "10 years of React framework wars" },
  { owner: "expressjs", name: "express", blurb: "the Node classic, still pumping" },
  { owner: "sindresorhus", name: "is", blurb: "one maintainer's decade of types" },
];

export function ScanForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(target?: string) {
    const value = (target ?? url).trim();
    if (!value) {
      setError("Paste a GitHub repository URL first.");
      return;
    }
    if (!isRepoUrlValid(value)) {
      setError("Only https://github.com/{owner}/{repo} URLs can be excavated.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong starting the scan.");
        setBusy(false);
        return;
      }
      // Always land on the story URL. A fresh scan has no `storyUrl` yet, so
      // gating on it left the button dead — the page renders either the cached
      // story or ScanStart, which streams progress over SSE.
      const repo = parseRepoUrl(value);
      router.push(`/github.com/${repo.owner}/${repo.name}`);
    } catch {
      setError("Network error — try again.");
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "w-full" : "w-full max-w-2xl"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <div className="relative flex-1">
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            placeholder="https://github.com/vercel/next.js"
            spellCheck={false}
            autoComplete="off"
            aria-label="GitHub repository URL"
            className={`w-full rounded-xl border bg-stone-900/70 px-4 py-3 font-mono text-sm text-stone-100 placeholder:text-stone-600 outline-none transition focus:border-amber-500/70 focus:ring-2 focus:ring-amber-500/20 ${
              error ? "border-red-500/60" : "border-stone-800"
            }`}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-amber-500 px-6 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-400 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Digging…" : "Excavate"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {!error && !compact && (
        <p className="mt-3 text-xs text-stone-500">
          Public repositories only. No signup. Scans are rate-limited per IP.
        </p>
      )}

      {!compact && (
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              key={`${p.owner}/${p.name}`}
              onClick={() => {
                setUrl(`https://github.com/${p.owner}/${p.name}`);
                void submit(`https://github.com/${p.owner}/${p.name}`);
              }}
              disabled={busy}
              className="panel group px-4 py-3 text-left transition hover:border-amber-500/50 disabled:opacity-60"
            >
              <div className="font-mono text-sm text-amber-400/90 group-hover:text-amber-300">
                {p.owner}/{p.name}
              </div>
              <div className="mt-1 text-xs text-stone-500">{p.blurb}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
