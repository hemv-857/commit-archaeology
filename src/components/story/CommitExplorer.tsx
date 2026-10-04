"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitEntry } from "@/lib/types";
import { formatDate, formatNumber, truncate } from "@/lib/format";
import { SectionHeading } from "./ErasSection";

const PAGE = 25;

interface Props {
  owner: string;
  name: string;
  totalInHistory: number;
  onOpenCommit: (commit: CommitEntry) => void;
}

/**
 * "Commit Explorer" — browse and search the analysed commits.
 *
 * Paged from the server rather than rendering the whole set: 1000 rows of DOM
 * is both slow and pointless, and the commits were deliberately kept out of the
 * page payload (SCHEMA_VERSION 2), so paging is also what keeps this cheap.
 */
export function CommitExplorer({ owner, name, totalInHistory, onOpenCommit }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow response for an old query overwriting a newer one.
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (q: string, offset: number, append: boolean) => {
      const id = ++requestId.current;
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (q) params.set("q", q);
        const res = await fetch(
          `/api/repos/${owner}/${name}/commits?${params.toString()}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          commits: CommitEntry[];
          total: number;
          hasMore: boolean;
        };
        if (id !== requestId.current) return; // stale
        setCommits((prev) => (append ? [...prev, ...body.commits] : body.commits));
        setTotal(body.total);
        setHasMore(body.hasMore);
      } catch {
        if (id !== requestId.current) return;
        setError("Could not load commits.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [owner, name]
  );

  // Reset paging whenever the query changes.
  useEffect(() => {
    void load(debounced, 0, false);
  }, [debounced, load]);

  return (
    <section aria-label="Commit explorer">
      <SectionHeading
        title="Commit Explorer"
        hint="every commit in the analysed range — search by message, author, path or sha"
      />

      <div className="panel p-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search commits…  try author:ada  path:core  sha:3734f75"
          aria-label="Search commits"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-lg border border-stone-800 bg-stone-900/70 px-3 py-2 font-mono text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-500/70"
        />

        <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
          <span aria-live="polite">
            {loading
              ? "Loading…"
              : `${formatNumber(total)} ${total === 1 ? "commit" : "commits"}${
                  debounced ? ` matching “${debounced}”` : ""
                }`}
            {!loading && totalInHistory > total && !debounced
              ? ` · showing the most recent ${formatNumber(total)} of ${formatNumber(
                  totalInHistory
                )}`
              : ""}
          </span>
          {debounced && (
            <button
              onClick={() => setQuery("")}
              className="text-stone-500 transition hover:text-amber-300"
            >
              clear
            </button>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {!loading && !error && commits.length === 0 && (
          <p className="mt-4 text-sm text-stone-500">No commits match.</p>
        )}

        <ul className="mt-3 divide-y divide-stone-900">
          {commits.map((c) => (
            <li key={c.sha}>
              <button
                onClick={() => onOpenCommit(c)}
                className="group flex w-full flex-col gap-1 px-1 py-2.5 text-left transition hover:bg-stone-900/60"
              >
                <div className="truncate text-sm text-stone-200 group-hover:text-amber-300">
                  {c.subject}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-stone-500">
                  <span>{c.shortSha}</span>
                  <span>{c.authorName}</span>
                  <span>{formatDate(c.date)}</span>
                  <span className="text-emerald-500/70">+{c.additions}</span>
                  <span className="text-red-400/70">−{c.deletions}</span>
                  {c.files.length > 0 && (
                    <span className="text-stone-600">
                      {truncate(c.files.join(", "), 60)}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>

        {hasMore && (
          <button
            onClick={() => void load(debounced, commits.length, true)}
            disabled={loading}
            className="mt-3 w-full rounded-lg border border-stone-800 py-2 text-xs text-stone-400 transition hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
          >
            {loading ? "Loading…" : `Load more (${formatNumber(total - commits.length)} remaining)`}
          </button>
        )}
      </div>
    </section>
  );
}