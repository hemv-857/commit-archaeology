/**
 * Bounded `git` process execution shared by clone and log.
 *
 * Every git invocation goes through here so that no scan can hang a worker
 * slot forever or exhaust memory: wall-clock timeout, capped stdout/stderr,
 * `GIT_TERMINAL_PROMPT=0` so we never block on credentials, and a scrubbed
 * error message built from git's meaningful output.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Hard ceiling on captured stdout (512 MB). */
const MAX_STDOUT = 512 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  onStderr?: (chunk: string) => void;
}

export function runGit(
  args: string[],
  opts: GitRunOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C.UTF-8",
      ...(opts.env as NodeJS.ProcessEnv | undefined),
    };
    const child: ChildProcessWithoutNullStreams = spawn("git", args, {
      cwd: opts.cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GitError(`git ${args[0]} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > MAX_STDOUT) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      if (stderr.length < MAX_STDERR) opts.onStderr?.(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitError(`git not available: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new GitError(trimGitError(stderr) || `git ${args[0]} exited with ${code}`));
    });
  });
}

/** Strip clone progress noise so the real failure reason survives. */
export function trimGitError(stderr: string): string {
  const lines = stderr.trim().split("\n");
  const progressPrefixes = [
    "Receiving objects:",
    "Resolving deltas:",
    "remote: Enumerating",
    "remote: Counting",
    "remote: Compressing",
  ];
  const meaningful = lines.filter((l) => !progressPrefixes.some((p) => l.startsWith(p)));
  const last = (meaningful.length ? meaningful : lines).slice(-3).join(" ").trim();
  return last.replace(/remote:\s*/g, "").slice(0, 300);
}