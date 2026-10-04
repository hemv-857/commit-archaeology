/**
 * Central configuration. Everything is env-driven so the same image runs in
 * dev (zero external services) and production (Postgres + Redis + tokens).
 */
import path from "node:path";
import os from "node:os";

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export interface AppConfig {
  env: string;
  isProd: boolean;
  isDev: boolean;
  /** External base URL used for share links / metadata. */
  publicBaseUrl: string;

  // --- GitHub ---
  githubTokens: string[];
  githubApiBase: string;
  githubGraphqlUrl: string;
  maxPrPages: number;

  // --- Mock mode (tests / demos): no network, deterministic fixtures ---
  mockGithub: boolean;
  /** When MOCK_GITHUB=1, git clones come from this directory's fixture repos. */
  fixtureRepoDir: string;

  // --- Storage ---
  databaseUrl: string | null;
  redisUrl: string | null;
  dataDir: string;

  // --- Queue / pipeline ---
  queueDriver: "memory" | "bullmq";
  storeDriver: "file" | "postgres";
  scanConcurrency: number;
  cloneTimeoutMs: number;
  maxCommitCount: number;
  /**
   * Reject repos larger than this (GitHub's `size`, in KB). A blobless clone of
   * a multi-GB repo can occupy a worker slot until the clone/log timeout, so it
   * is rejected before any git process starts.
   */
  maxRepoSizeKb: number;

  // --- AI ---
  aiProvider: "openai" | "none";
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  openaiModel: string;

  // --- Rate limiting (per IP) ---
  rateLimitScanPoints: number;
  rateLimitScanWindowSec: number;
  rateLimitApiPoints: number;
  rateLimitApiWindowSec: number;
  /**
   * How many scans one IP may have running at once. The per-IP rate limit caps
   * how *often* a client can ask; this stops a single client from holding every
   * worker slot indefinitely. Enforced in-process — with multiple web instances
   * behind BullMQ the rate limit is the only cross-instance guard.
   */
  maxConcurrentScansPerIp: number;

  // --- Cache freshness ---
  /** Re-check cached repos older than this (seconds) in the background. */
  revalidateAfterSec: number;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const env = (k: string): string | undefined =>
    overrides[k] ?? process.env[k];

  const nodeEnv = env("NODE_ENV") ?? "development";
  const redisUrl = env("REDIS_URL") ?? null;
  const databaseUrl = env("DATABASE_URL") ?? null;

  const tokens = (env("GITHUB_TOKENS") ?? env("GITHUB_TOKEN") ?? "")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const dataDir =
    env("DATA_DIR") ?? path.join(process.cwd(), ".data");

  return {
    env: nodeEnv,
    isProd: nodeEnv === "production",
    isDev: nodeEnv !== "production",
    publicBaseUrl: env("PUBLIC_BASE_URL") ?? "http://localhost:3000",

    githubTokens: tokens,
    githubApiBase: env("GITHUB_API_BASE") ?? "https://api.github.com",
    githubGraphqlUrl: env("GITHUB_GRAPHQL_URL") ?? "https://api.github.com/graphql",
    maxPrPages: int(env("MAX_PR_PAGES"), 20),

    mockGithub: bool(env("MOCK_GITHUB"), false),
    fixtureRepoDir:
      env("FIXTURE_REPO_DIR") ?? path.join(process.cwd(), "public", "fixtures", "repos"),

    databaseUrl,
    redisUrl,
    dataDir,

    queueDriver: redisUrl ? "bullmq" : "memory",
    storeDriver: databaseUrl ? "postgres" : "file",
    scanConcurrency: int(env("SCAN_CONCURRENCY"), 2),
    cloneTimeoutMs: int(env("CLONE_TIMEOUT_MS"), 300_000),
    maxCommitCount: int(env("MAX_COMMIT_COUNT"), 200_000),
    maxRepoSizeKb: int(env("MAX_REPO_SIZE_KB"), 512_000),

    aiProvider: env("OPENAI_API_KEY") ? "openai" : "none",
    openaiApiKey: env("OPENAI_API_KEY") ?? null,
    openaiBaseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    openaiModel: env("OPENAI_MODEL") ?? "gpt-4o-mini",

    rateLimitScanPoints: int(env("RATE_LIMIT_SCAN_POINTS"), 5),
    rateLimitScanWindowSec: int(env("RATE_LIMIT_SCAN_WINDOW_SEC"), 60),
    rateLimitApiPoints: int(env("RATE_LIMIT_API_POINTS"), 60),
    rateLimitApiWindowSec: int(env("RATE_LIMIT_API_WINDOW_SEC"), 60),
    maxConcurrentScansPerIp: int(env("MAX_CONCURRENT_SCANS_PER_IP"), 1),

    revalidateAfterSec: int(env("REVALIDATE_AFTER_SEC"), 3600),
  };
}

let cached: AppConfig | null = null;

/** Process-wide singleton config. */
export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export const tmpRoot = path.join(os.tmpdir(), "commit-archaeology");
