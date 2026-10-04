"use client";

import { useState } from "react";
import Link from "next/link";
import type { CommitEntry, RepoStory } from "@/lib/types";
import { formatNumber, relativeDays } from "@/lib/format";
import { StatsStrip } from "./StatsStrip";
import { TimelineScrubber } from "./TimelineScrubber";
import { ErasSection } from "./ErasSection";
import { IncidentsSection } from "./IncidentsSection";
import { HotspotsSection } from "./HotspotsSection";
import { AuthorsSection } from "./AuthorsSection";
import { ChurnSection, StoryFooterMeta } from "./ChurnSection";
import { CommitExplorer } from "./CommitExplorer";
import { DetailDrawer, RescanButton, type DrawerItem } from "./DetailDrawer";

/** Full story page body: stats, scrubber, eras, incidents, hotspots, team, churn. */
export function StoryView({ story }: { story: RepoStory }) {
  const [drawer, setDrawer] = useState<DrawerItem | null>(null);
  const [selectedEraId, setSelectedEraId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Commits are no longer embedded in the story document (SCHEMA_VERSION), so
  // resolve one on demand. Surface failures rather than silently doing nothing.
  const openCommit = async (sha: string) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/repos/${story.repo.owner}/${story.repo.name}/commits?sha=${encodeURIComponent(sha)}`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { commit: CommitEntry };
      setDrawer({ type: "commit", commit: data.commit });
    } catch {
      setError("Could not load that commit. It may predate the analysed range.");
    }
  };
  // The explorer already holds the commit, so it skips the round trip.
  const openCommitDirect = (commit: CommitEntry) => setDrawer({ type: "commit", commit });
  const openFile = (path: string) => setDrawer({ type: "file", path });
  const openAuthor = (index: number) => setDrawer({ type: "author", authorIndex: index });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 py-6">
        <div className="min-w-0">
          <Link href="/" className="text-xs text-stone-500 transition hover:text-amber-300">
            ⛏️ Commit Archaeology
          </Link>
          <h1 className="mt-1 truncate text-2xl font-bold tracking-tight sm:text-3xl">
            <a
              href={story.repo.url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-amber-300"
            >
              {story.repo.owner}/{story.repo.name}
            </a>
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            {story.repo.description ?? "No description"}
            <span className="ml-2 font-mono text-xs">
              ★ {formatNumber(story.repo.stars)}
              {story.repo.primaryLanguage ? ` · ${story.repo.primaryLanguage}` : ""}
              {` · HEAD ${story.repo.headSha.slice(0, 7)}`}
              {` · scanned ${relativeDays(story.scannedAt)}`}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/compare?a=${story.repo.owner}/${story.repo.name}`}
            // Secondary action: without this, every story view prefetches and
            // server-renders the compare page.
            prefetch={false}
            className="rounded-lg border border-stone-800 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/50 hover:text-amber-300"
          >
            Compare
          </Link>
          <a
            href={`/api/repos/${story.repo.owner}/${story.repo.name}/export?format=md`}
            className="rounded-lg border border-stone-800 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/50 hover:text-amber-300"
          >
            Export .md
          </a>
          <button
            onClick={() => void copyLink()}
            className="rounded-lg border border-stone-800 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/50 hover:text-amber-300"
          >
            {copied ? "Link copied ✓" : "Share link"}
          </button>
          <RescanButton owner={story.repo.owner} name={story.repo.name} />
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      )}

      <StatsStrip story={story} />

      <div className="panel mt-4 p-5">
        <TimelineScrubber story={story} selectedEraId={selectedEraId} onSelectEra={setSelectedEraId} />
      </div>

      <div className="mt-8 space-y-10">
        <ErasSection eras={story.eras} selectedEraId={selectedEraId} onSelectEra={setSelectedEraId} />
        <IncidentsSection
            incidents={story.incidents}
            historyDays={story.stats.historyDays}
            onOpenCommit={(sha) => void openCommit(sha)}
          />
        <HotspotsSection story={story} onOpenFile={openFile} />
        <AuthorsSection
          authors={story.authors}
          busFactor={story.busFactor}
          onOpenAuthor={openAuthor}
        />
        <ChurnSection churn={story.churn} onOpenFile={openFile} />

        <CommitExplorer
          owner={story.repo.owner}
          name={story.repo.name}
          totalInHistory={story.totalCommitsInHistory}
          onOpenCommit={openCommitDirect}
        />
      </div>

      <StoryFooterMeta story={story} />
      {drawer && <DetailDrawer item={drawer} story={story} onClose={() => setDrawer(null)} />}
    </main>
  );
}
