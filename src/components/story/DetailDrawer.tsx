"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CommitEntry, RepoStory } from "@/lib/types";
import { formatDate } from "@/lib/format";

export type DrawerItem =
  | { type: "commit"; commit: CommitEntry }
  | { type: "author"; authorIndex: number }
  | { type: "file"; path: string };

/** Right-hand deep-dive drawer with raw metadata + GitHub links. */
export function DetailDrawer({
  item,
  story,
  onClose,
}: {
  item: DrawerItem;
  story: RepoStory;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <aside className="scroll-thin absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-l border-stone-800 bg-stone-950/95 shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-stone-800 bg-stone-950/90 px-5 py-3 backdrop-blur">
          <span className="font-mono text-xs uppercase tracking-widest text-amber-500/80">
            {item.type}
          </span>
          <button
            onClick={onClose}
            className="rounded-md border border-stone-800 px-2 py-1 text-xs text-stone-400 transition hover:border-stone-600 hover:text-stone-200"
          >
            Close ✕
          </button>
        </div>
        <div className="px-5 py-4">
          {item.type === "commit" && <CommitDetails commit={item.commit} story={story} />}
          {item.type === "author" && <AuthorDetails index={item.authorIndex} story={story} />}
          {item.type === "file" && <FileDetails path={item.path} story={story} />}
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-24 shrink-0 text-stone-500">{label}</span>
      <span className="min-w-0 break-words text-stone-300">{children}</span>
    </div>
  );
}

function LinkList({ links }: { links: Array<[string, string]> }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {links.map(([label, href]) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-stone-800 px-3 py-1.5 text-xs text-amber-400/90 transition hover:border-amber-500/50 hover:text-amber-300"
        >
          {label} ↗
        </a>
      ))}
    </div>
  );
}

function CommitDetails({ commit, story }: { commit: CommitEntry; story: RepoStory }) {
  const pr = commit.prNumber
    ? story.prIndex.find((p) => p.number === commit.prNumber) ?? null
    : null;
  if (!commit) {
    return <p className="text-sm text-stone-400">Commit metadata unavailable.</p>;
  }
  return (
    <div>
      <h3 className="text-base font-semibold leading-snug text-stone-100">
        {commit.subject}
      </h3>
      <div className="mt-3 divide-y divide-stone-900">
        <Row label="sha">
          <code className="font-mono text-xs text-amber-300/90">{commit.shortSha}</code>
        </Row>
        <Row label="author">{commit.authorName}</Row>
        <Row label="date">{new Date(commit.date).toUTCString()}</Row>
        <Row label="merge">{commit.isMerge ? "yes (merge commit)" : "no"}</Row>
        <Row label="diff">
          <span className="text-emerald-400">+{commit.additions}</span>{" "}
          <span className="text-red-400">−{commit.deletions}</span>
        </Row>
        {commit.files.length > 0 && (
          <Row label="files">
            <span className="flex flex-wrap gap-1">
              {commit.files.map((f) => (
                <span key={f} className="chip" title={f}>
                  {f}
                </span>
              ))}
            </span>
          </Row>
        )}
        {pr && (
          <Row label="pull req">
            <a href={pr.url} target="_blank" rel="noreferrer" className="text-amber-400/90 hover:underline">
              #{pr.number} — {pr.title}
            </a>
            {pr.excerpt && (
              <p className="mt-1 border-l-2 border-stone-800 pl-3 text-xs italic text-stone-500">
                “{pr.excerpt}”
              </p>
            )}
          </Row>
        )}
      </div>
      <LinkList
        links={[
          ["View commit", `${story.repo.url}/commit/${commit.sha}`],
          ...(pr ? ([["View PR", pr.url]] as Array<[string, string]>) : []),
        ]}
      />
    </div>
  );
}

function AuthorDetails({ index, story }: { index: number; story: RepoStory }) {
  const author = story.authors[index];
  if (!author) return <p className="text-sm text-stone-400">Author not found.</p>;
  return (
    <div>
      <h3 className="text-base font-semibold text-stone-100">{author.name}</h3>
      <div className="mt-3 divide-y divide-stone-900">
        <Row label="commits">{author.commits}</Row>
        <Row label="diff">
          <span className="text-emerald-400">+{author.additions}</span>{" "}
          <span className="text-red-400">−{author.deletions}</span>
        </Row>
<Row label="first commit">{formatDate(author.firstCommitAt)}</Row>
          <Row label="last commit">{formatDate(author.lastCommitAt)}</Row>
        <Row label="top files">
          <span className="flex flex-wrap gap-1">
            {author.topPaths.map((p) => (
              <span key={p} className="chip" title={p}>
                {p}
              </span>
            ))}
          </span>
        </Row>
        <Row label="bus impact">
          {author.commits} commits ≈{" "}
          {Math.round((author.commits / Math.max(1, story.stats.totalCommits)) * 100)}% of history
        </Row>
      </div>
      <LinkList
        links={[
          [
            "Commits by author",
            `${story.repo.url}/commits?author=${encodeURIComponent(author.email || author.name)}`,
          ],
        ]}
      />
    </div>
  );
}

function FileDetails({ path, story }: { path: string; story: RepoStory }) {
  const churn = story.churn.find((c) => c.path === path);
  const hotspot = story.hotspots.find((h) => h.path === path);
  return (
    <div>
      <h3 className="break-all font-mono text-sm font-semibold text-amber-300/90">{path}</h3>
      {churn && (
        <div className="mt-3 divide-y divide-stone-900">
          <Row label="churn">
            {churn.churn.toLocaleString("en-US")} lines ({churn.additions.toLocaleString("en-US")} + /{" "}
            {churn.deletions.toLocaleString("en-US")} −)
          </Row>
          <Row label="edits">{churn.commits} commits</Row>
          <Row label="authors">{churn.authors} different authors</Row>
        </div>
      )}
      {hotspot && hotspot.linkedPRs.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs uppercase tracking-widest text-stone-500">
            PRs that kept touching this file
          </div>
          <ul className="space-y-2">
            {hotspot.linkedPRs.map((pr) => (
              <li key={pr.number} className="panel p-3">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-amber-400/90 hover:underline"
                >
                  #{pr.number} — {pr.title}
                </a>
                {pr.excerpt && (
                  <p className="mt-1 text-xs italic leading-relaxed text-stone-500">
                    “{pr.excerpt}”
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <LinkList
        links={[
          ["Browse", `${story.repo.url}/blob/HEAD/${path}`],
          ["History", `${story.repo.url}/commits/HEAD/${path}`],
          ["Blame", `${story.repo.url}/blame/HEAD/${path}`],
        ]}
      />
    </div>
  );
}

/** Small helper button used in the story header. */
export function RescanButton({ owner, name }: { owner: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: `https://github.com/${owner}/${name}` }),
          });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-lg border border-stone-800 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
    >
      {busy ? "Re-digging…" : "Re-scan"}
    </button>
  );
}
