/**
 * Shared types for Commit Archaeology.
 *
 * These describe the serialized "story" document produced by the analysis
 * pipeline and rendered by the UI. They are used on both server and client,
 * so this module must stay dependency-free.
 */

/**
 * Version of the persisted story document.
 *
 * v2 drops `commits` from the document body: it was up to 1000 entries embedded
 * in every page load but never rendered as a list — only looked up by SHA in the
 * commit drawer. Commits are now stored alongside the story and served by
 * GET /api/repos/{owner}/{repo}/commits.
 *
 * Stores reject a document whose version does not match, so bumping this
 * invalidates cached stories instead of serving a malformed one.
 */
export const SCHEMA_VERSION = 2;

export interface RepoMeta {
  owner: string;
  name: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  primaryLanguage: string | null;
  defaultBranch: string;
  headSha: string;
  isFork: boolean;
  archived: boolean;
}

export interface StoryStats {
  totalCommits: number;
  totalPRs: number;
  matchedPRs: number;
  avgPRFiles: number;
  avgPRAdditions: number;
  hotfixesPerMonth: number;
  revertCount: number;
  contributors: number;
  firstCommitAt: string;
  lastCommitAt: string;
  historyDays: number;
}

/** One bucket of the timeline heatmap (one week). */
export interface TimelineBucket {
  /** ISO date of the bucket start (Monday). */
  start: string;
  commits: number;
  authors: number;
}

export interface Era {
  id: string;
  title: string;
  start: string;
  end: string;
  startSha: string;
  endSha: string;
  commitCount: number;
  authors: number;
  /** Path prefixes that dominated development during this era. */
  dominantPaths: string[];
  /** 2-3 sentence narrative beat; null when AI layer is off or failed. */
  beat: string | null;
  /** Short machine-generated fallback summary (always present). */
  summary: string;
  netAdditions: number;
  netDeletions: number;
}

export type IncidentKind = "revert" | "quickfix";

/**
 * "Who broke what" — a commit that introduced a change that was then
 * reverted or urgently patched shortly afterwards.
 */
export interface Incident {
  kind: IncidentKind;
  /** The commit that introduced the trouble. */
  culpritSha: string;
  culpritSubject: string;
  culpritAuthor: string;
  culpritDate: string;
  /** The revert/fix commit that paid for it. */
  aftermathSha: string;
  aftermathSubject: string;
  aftermathAuthor: string;
  aftermathDate: string;
  /** Hours between the two. */
  hoursToRepair: number;
  files: string[];
  netChurn: number;
}

export interface PRSummary {
  number: number;
  title: string;
  url: string;
  author: string | null;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** First ~280 chars of the body, used for hotspot excerpts. */
  excerpt: string | null;
}

export interface PRFileLink {
  number: number;
  title: string;
  url: string;
  excerpt: string | null;
  mergedAt: string | null;
}

export interface FileHotspot {
  path: string;
  /** added + deleted lines across history. */
  churn: number;
  commits: number;
  authors: number;
  /** PRs (merge/squash commits) that touched this file, newest first. */
  linkedPRs: PRFileLink[];
  createdAt: string | null;
  lastTouchedAt: string | null;
}

export interface FileChurn {
  path: string;
  churn: number;
  additions: number;
  deletions: number;
  commits: number;
  authors: number;
}

export interface AuthorMonthly {
  /** `YYYY-MM` */
  month: string;
  commits: number;
}

export interface AuthorStat {
  name: string;
  email: string;
  login: string | null;
  commits: number;
  additions: number;
  deletions: number;
  firstCommitAt: string;
  lastCommitAt: string;
  /** Commits per month, sparse, ascending — for the contribution graph. */
  perMonth: AuthorMonthly[];
  /** Paths this author touched most. */
  topPaths: string[];
}

export interface BusFactor {
  /** 1-6: number of authors who together account for >=50% of commits. */
  score: number;
  label: "critical" | "high-risk" | "moderate" | "healthy";
  topAuthorsShare: number;
  contributors: number;
  /** Commits authored by the single top author. */
  topAuthorCommits: number;
}

export interface CommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
  isMerge: boolean;
  prNumber: number | null;
  files: string[];
  additions: number;
  deletions: number;
}

export interface StoryAnalysisMeta {
  analyzerVersion: string;
  analysisMs: number;
  githubApiCalls: number;
  cloned: boolean;
  aiBeats: "generated" | "skipped" | "failed";
}

export interface RepoStory {
  schemaVersion: typeof SCHEMA_VERSION;
  repo: RepoMeta;
  stats: StoryStats;
  timeline: TimelineBucket[];
  eras: Era[];
  incidents: Incident[];
  hotspots: FileHotspot[];
  churn: FileChurn[];
  authors: AuthorStat[];
  busFactor: BusFactor;
  /**
   * Commit count for the analysed range. The commits themselves live outside the
   * document — fetch them from GET /api/repos/{owner}/{repo}/commits.
   */
  totalCommitsInHistory: number;
  prIndex: PRSummary[];
  meta: StoryAnalysisMeta;
  scannedAt: string;
}

export type ScanStage =
  | "queued"
  | "validate"
  | "clone"
  | "history"
  | "prs"
  | "compute"
  | "ai"
  | "persist"
  | "done"
  | "error";

export interface ScanProgress {
  stage: ScanStage;
  pct: number;
  message: string;
  detail?: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface ScanJob {
  id: string;
  owner: string;
  name: string;
  url: string;
  /** Requester IP, used to cap how many scans one client can run at once. */
  ip?: string;
  status: JobStatus;
  progress: ScanProgress;
  error: string | null;
  storyUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}
