/**
 * Scan pipeline: URL validation → repo metadata → clone → history → PRs →
 * compute → (optional) AI beats → persist. Emits granular progress events at
 * every stage so the UI can render a live progress bar over SSE.
 */
import type { CommitEntry, PRSummary, RepoStory, ScanJob, ScanProgress } from "@/lib/types";
import { SCHEMA_VERSION } from "@/lib/types";
import { config } from "@/server/config";
import { logger } from "@/server/logger";
import { incCounter, observeHistogram } from "@/server/metrics";
import { github } from "@/server/github/client";
import { cloneRepo, cleanupClone } from "@/server/git/clone";
import {
  readHistory,
  prNumberFromSubject,
  toCommitEntry,
} from "@/server/git/log";
import { fetchPullRequests } from "@/server/analysis/prs";
import { buildEras } from "@/server/analysis/eras";
import { findIncidents } from "@/server/analysis/incidents";
import { computeChurn, buildHotspots } from "@/server/analysis/hotspots";
import { computeAuthors, computeBusFactor } from "@/server/analysis/authors";
import { computeStats, buildTimeline } from "@/server/analysis/stats";
import { generateEraBeats } from "@/server/analysis/ai";
import { getStore } from "@/server/store";

export const ANALYZER_VERSION = "1.0.0";

const MAX_RENDERED_COMMITS = 1000;
const MAX_PR_INDEX = 2000;

interface RepoMetaResponse {
  name: string;
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  default_branch: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  html_url: string;
  /** GitHub's repository size in KB (of the full git dir). */
  size: number;
}

/** Human-readable KB → "2.4 GB". Used only in the too-large error message. */
function formatSize(kb: number): string {
  if (kb >= 1_000_000) return `${(kb / 1_000_000).toFixed(1)} GB`;
  return `${Math.round(kb / 1000)} MB`;
}

/**
 * The subset of `prIndex` the UI can actually reach.
 *
 * The sole consumer is the commit drawer's
 * `story.prIndex.find(p => p.number === commit.prNumber)` (DetailDrawer.tsx);
 * hotspots carry their own denormalized PR copies. Persisting the fetched list
 * verbatim shipped ~350 KB for octocat/Hello-World — a 3-commit repo — where
 * exactly one entry was ever read.
 *
 * Note a referenced PR is not guaranteed to be present: commit subjects can
 * cite PRs that were never fetched. The drawer already falls back to `null`.
 */
export function reachablePrIndex(
  commits: CommitEntry[],
  prIndex: PRSummary[]
): PRSummary[] {
  const referenced = new Set<number>();
  for (const c of commits) {
    if (c.prNumber !== null) referenced.add(c.prNumber);
  }
  return prIndex.filter((p) => referenced.has(p.number));
}

export async function runScan(
  job: ScanJob,
  onProgress: (p: ScanProgress) => Promise<void>
): Promise<RepoStory> {
  const cfg = config();
  const log = logger();
  const startedAt = Date.now();
  const client = github();
  const apiCallsBefore = client.callCount;

  const progress = (stage: ScanProgress["stage"], pct: number, message: string, detail?: string) =>
    onProgress({ stage, pct, message, detail });

  try {
    /* 1. validate + metadata --------------------------------------- */
    await progress("validate", 2, `Looking up ${job.owner}/${job.name}…`);
    const meta = await client.rest<RepoMetaResponse>(
      `/repos/${job.owner}/${job.name}`
    );
    if (meta.private) {
      throw new Error(
        "This repository is private. Commit Archaeology only analyzes public repositories."
      );
    }

    // Reject oversized repos *before* cloning. A blobless clone of a multi-GB
    // repo holds a worker slot until CLONE_TIMEOUT_MS and then usually fails in
    // `git log` anyway, so there is nothing to gain by starting.
    // Guard on a finite number: a mock/self-hosted API may omit `size`.
    if (typeof meta.size === "number" && Number.isFinite(meta.size) && meta.size > 0) {
      if (meta.size > cfg.maxRepoSizeKb) {
        log.warn(
          { repo: job.url, sizeKb: meta.size, limitKb: cfg.maxRepoSizeKb },
          "repo too large, refusing to clone"
        );
        throw new Error(
          `This repository is too large to excavate (${formatSize(meta.size)}). ` +
            `The limit is ${formatSize(cfg.maxRepoSizeKb)}.`
        );
      }
    }

    // HEAD of the default branch — used as the story cache key.
    const headResp = await client.rest<Array<{ sha: string }>>(
      `/repos/${job.owner}/${job.name}/commits?per_page=1`
    );
    const headSha = headResp[0]?.sha;
    if (!headSha) throw new Error("Could not determine the repository HEAD.");

    // Exact commit count (one GraphQL probe).
    let totalCommitsInHistory = 0;
    try {
      const hist = await client.graphql<{
        repository: { object: { history: { totalCount: number } } | null } | null;
      }>(
        `query($owner:String!,$name:String!){
           repository(owner:$owner,name:$name){
             object(expression:"HEAD"){ ... on Commit { history { totalCount } } }
           }
         }`,
        { owner: job.owner, name: job.name }
      );
      totalCommitsInHistory = hist.repository?.object?.history?.totalCount ?? 0;
    } catch (err) {
      log.warn({ err, repo: job.url }, "commit count probe failed; continuing");
    }

    /* 2. clone ------------------------------------------------------ */
    await progress("clone", 5, "Cloning repository history…");
    const { repoDir, rootDir: cloneRoot } = await cloneRepo(
      job.owner,
      job.name,
      job.id,
      (pct, message) => onProgress({ stage: "clone", pct, message })
    );

    try {
      /* 3. history -------------------------------------------------- */
      await progress("history", 40, "Reading commit history…");
      const history = await readHistory(repoDir, cfg.maxCommitCount);
      if (history.commits.length === 0) {
        throw new Error("This repository has no commits yet.");
      }
      if (history.truncated) {
        log.warn(
          { repo: job.url, cap: cfg.maxCommitCount },
          "history truncated to newest N commits"
        );
      }
      const commitsAsc = [...history.commits].reverse();
      await progress("history", 54, `Parsed ${commitsAsc.length} commits.`);

      /* 4. PRs ------------------------------------------------------ */
      await progress("prs", 56, "Fetching pull requests…");
      let prIndex: Awaited<ReturnType<typeof fetchPullRequests>>["prs"] = [];
      let prTotalCount = 0;
      try {
        const prResult = await fetchPullRequests(client, job.owner, job.name, cfg.maxPrPages);
        prIndex = prResult.prs;
        prTotalCount = prResult.totalCount;
      } catch (err) {
        // PR enrichment is best-effort; commit-level analysis still stands.
        log.warn({ err, repo: job.url }, "PR fetch failed; continuing without PRs");
      }
      await progress("prs", 74, `Matched ${prIndex.length} pull requests.`);

      /* 5. compute -------------------------------------------------- */
      await progress("compute", 76, "Clustering feature eras…");
      const eras = buildEras(commitsAsc);
      const incidents = findIncidents(history.commits);
      const authors = computeAuthors(history.commits);
      const busFactor = computeBusFactor(authors, commitsAsc.length);
      const churn = computeChurn(history.commits);
      const hotspots = buildHotspots(history.commits, prIndex.slice(0, MAX_PR_INDEX));
      const stats = computeStats(
        commitsAsc,
        prTotalCount,
        prIndex,
        incidents,
        totalCommitsInHistory || commitsAsc.length
      );
      const timeline = buildTimeline(commitsAsc);
      await progress("compute", 88, "Analysis complete.");

      /* 6. AI beats (optional, fail-soft) --------------------------- */
      let aiStatus: "generated" | "skipped" | "failed" = "skipped";
      let finalEras = eras;
      if (eras.length > 0) {
        await progress("ai", 90, "Writing era story beats…");
        const subjectsByEra = new Map<string, string[]>();
        for (const era of eras) {
          const subjects = commitsAsc
            .filter((c) => c.date >= era.start && c.date <= era.end)
            .slice(0, 8)
            .map((c) => c.subject);
          subjectsByEra.set(era.id, subjects);
        }
        const store = await getStore();
        const ai = await generateEraBeats(`${job.owner}/${job.name}`, eras, subjectsByEra, store);
        finalEras = ai.eras;
        aiStatus = ai.status;
      }

      /* 7. assemble + persist --------------------------------------- */
      await progress("persist", 96, "Saving the story…");

      const renderedCommits = [...history.commits]
        .slice(0, MAX_RENDERED_COMMITS)
        .map(toCommitEntry);

      const story: RepoStory = {
        schemaVersion: SCHEMA_VERSION,
        repo: {
          owner: job.owner,
          name: job.name,
          url: meta.html_url || `https://github.com/${job.owner}/${job.name}`,
          description: meta.description,
          stars: meta.stargazers_count,
          forks: meta.forks_count,
          primaryLanguage: meta.language,
          defaultBranch: meta.default_branch,
          headSha,
          isFork: meta.fork,
          archived: meta.archived,
        },
        stats,
        timeline,
        eras: finalEras,
        incidents,
        hotspots,
        churn,
        authors,
        busFactor,
        totalCommitsInHistory: totalCommitsInHistory || commitsAsc.length,
        prIndex: reachablePrIndex(renderedCommits, prIndex.slice(0, MAX_PR_INDEX)),
        meta: {
          analyzerVersion: ANALYZER_VERSION,
          analysisMs: Date.now() - startedAt,
          githubApiCalls: client.callCount - apiCallsBefore,
          cloned: true,
          aiBeats: aiStatus,
        },
        scannedAt: new Date().toISOString(),
      };

      const store = await getStore();
      // Commits go beside the document, not inside it (SCHEMA_VERSION).
      await store.saveStory(story, renderedCommits);
      await progress("done", 100, "Story ready.");
      incCounter("scans_total", { outcome: "ok" });
      observeHistogram("scan_duration_ms", Date.now() - startedAt);
      log.info(
        {
          repo: job.url,
          headSha,
          commits: commitsAsc.length,
          eras: finalEras.length,
          incidents: incidents.length,
          ms: Date.now() - startedAt,
        },
        "scan complete"
      );
      return story;
    } finally {
      if (!process.env.KEEP_CLONE) await cleanupClone(cloneRoot);
    }
  } catch (err) {
    incCounter("scans_total", { outcome: "failed" });
    observeHistogram("scan_duration_ms", Date.now() - startedAt);
    throw err;
  }
}

/** PR number lookup helper reused by tests. */
export { prNumberFromSubject };
