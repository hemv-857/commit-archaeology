/**
 * Git operations: server-side clone of public repos into a temp dir.
 *
 * - Clones are BARE (no worktree) and default to partial clone
 *   (--filter=blob:none) so cold scans stay small; set CLONE_FILTER=none for
 *   a full clone if your network prefers one big transfer.
 * - Auth (if any) is passed via an ephemeral `http.extraHeader` in the child
 *   env — never in the URL, never logged.
 * - GIT_TERMINAL_PROMPT=0 guarantees we never hang waiting for credentials.
 * - MOCK_GITHUB=1 maps owner/name to a local fixture repo (tests/demos).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpRoot, config } from "@/server/config";
import { logger } from "@/server/logger";
import { incCounter, observeHistogram } from "@/server/metrics";
import { runGit, GitError } from "./exec";

/** Kept as the clone-specific name for callers that catch clone failures. */
export class CloneError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

export function resolveCloneSource(owner: string, name: string): string {
  const cfg = config();
  if (cfg.mockGithub) {
    // Plain filesystem path so `git clone --local` hardlinks (fast, offline).
    return path.join(cfg.fixtureRepoDir, `${owner}__${name}`.toLowerCase());
  }
  return `https://github.com/${owner}/${name}.git`;
}

/**
 * Env that authenticates git-over-HTTPS, or {} for an anonymous clone.
 *
 * GitHub's git endpoint only accepts HTTP Basic — a `Bearer` header is rejected
 * with 401, and git cannot then fall back to an anonymous clone because
 * GIT_TERMINAL_PROMPT=0 turns the credential prompt into a hard failure. That
 * would break cloning *public* repos, not just private ones.
 *
 * The token is passed via config env so it never appears in the URL, in argv
 * (visible in `ps`), or in logs.
 */
export function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface CloneResult {
  repoDir: string;
  /** Parent scratch dir to remove when done. */
  rootDir: string;
  ms: number;
}

/**
 * Clone owner/name into a fresh temp dir. Returns the bare repo path.
 * Caller must eventually call cleanupClone.
 */
export async function cloneRepo(
  owner: string,
  name: string,
  jobId: string,
  onProgress?: (pct: number, message: string) => Promise<void> | void
): Promise<CloneResult> {
  const cfg = config();
  const started = Date.now();
  const dest = path.join(tmpRoot, `scan-${jobId}`);
  await fs.mkdir(dest, { recursive: true });
  const repoDir = path.join(dest, "repo.git");
  const source = resolveCloneSource(owner, name);

  const filter = process.env.CLONE_FILTER ?? "blob:none";
  const args = [
    "clone",
    "--bare",
    "--no-checkout",
    "--single-branch",
    "--progress",
    ...(cfg.mockGithub ? ["--local"] : filter !== "none" ? [`--filter=${filter}`] : []),
    source,
    repoDir,
  ];

  const token = cfg.githubTokens[0];
  const env: Record<string, string> = cfg.mockGithub ? {} : gitAuthEnv(token);

  const log = logger();
  let lastPct = 0;
  try {
    await runGit(args, {
      timeoutMs: cfg.cloneTimeoutMs,
      env,
      onStderr: (chunk) => {
        const m = chunk.match(/Receiving objects:\s+(\d+)%/);
        if (m) {
          const pct = 5 + Math.floor((Number(m[1]) / 100) * 30); // 5% → 35%
          if (pct > lastPct) {
            lastPct = pct;
            log.debug({ owner, name, pct }, "clone progress");
            void onProgress?.(pct, `Receiving objects… ${m[1]}%`);
          }
        }
        const dm = chunk.match(/Resolving deltas:\s+(\d+)%/);
        if (dm) {
          const pct = 35 + Math.floor((Number(dm[1]) / 100) * 5); // 35% → 40%
          if (pct > lastPct) {
            lastPct = pct;
            void onProgress?.(pct, `Resolving deltas… ${dm[1]}%`);
          }
        }
      },
    });
  } catch (err) {
    await cleanupClone(dest);
    incCounter("clones_total", { outcome: "failed" });
    throw err;
  }

  const ms = Date.now() - started;
  incCounter("clones_total", { outcome: "ok" });
  observeHistogram("clone_duration_ms", ms);
  log.info({ owner, name, ms, filter }, "clone complete");
  return { repoDir, rootDir: dest, ms };
}

export async function cleanupClone(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export async function gitAvailable(): Promise<boolean> {
  try {
    const { stdout } = await runGit(["--version"], { timeoutMs: 5000 });
    return stdout.includes("git version");
  } catch {
    return false;
  }
}
