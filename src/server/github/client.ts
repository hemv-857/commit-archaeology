/**
 * GitHub API client: REST + GraphQL with a rotating token pool, retry with
 * backoff on rate limits / transient errors, and call accounting.
 *
 * Auth: tokens come from GITHUB_TOKENS (comma separated). Anonymous requests
 * are allowed but heavily rate limited by GitHub — production deployments
 * should always provide a pool.
 *
 * Tests: point GITHUB_API_BASE / GITHUB_GRAPHQL_URL at a local mock server.
 * Mock mode: with MOCK_GITHUB=1 the client serves deterministic fixtures and
 * never touches the network.
 */
import { incCounter } from "@/server/metrics";
import { config, type AppConfig } from "@/server/config";
import { logger } from "@/server/logger";
import path from "node:path";
import { promises as fs } from "node:fs";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly rateLimited = false
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GithubClient {
  rest<T>(path: string): Promise<T>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  readonly callCount: number;
}

/** Round-robin token pool with per-token cooldown after rate limiting. */
class TokenPool {
  private index = 0;
  private readonly cooldownUntil = new Map<string, number>();

  constructor(private readonly tokens: string[]) {}

  next(): string | null {
    if (this.tokens.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[(this.index + i) % this.tokens.length]!;
      if ((this.cooldownUntil.get(token) ?? 0) <= now) {
        this.index = (this.index + i + 1) % this.tokens.length;
        return token;
      }
    }
    // All cooling down; use the one that cools earliest.
    return this.tokens[this.index % this.tokens.length]!;
  }

  penalize(token: string, untilMs: number): void {
    if (!token) return;
    this.cooldownUntil.set(token, Math.max(this.cooldownUntil.get(token) ?? 0, untilMs));
  }
}

const USER_AGENT = "commit-archaeology/1.0";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class RealGithubClient implements GithubClient {
  private readonly pool: TokenPool;
  private calls = 0;

  constructor(private readonly cfg: AppConfig) {
    this.pool = new TokenPool(cfg.githubTokens);
  }

  get callCount(): number {
    return this.calls;
  }

  async rest<T>(apiPath: string): Promise<T> {
    return this.request<T>(`${this.cfg.githubApiBase}${apiPath}`, {}, 0);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      this.cfg.githubGraphqlUrl,
      { method: "POST", body: JSON.stringify({ query, variables }) },
      0,
      true
    );
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    attempt: number,
    isGraphql = false
  ): Promise<T> {
    const token = this.pool.next();
    const headers: Record<string, string> = {
      Accept: isGraphql ? "application/vnd.github+json" : "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    this.calls += 1;
    incCounter("github_api_calls_total", { authenticated: token ? "true" : "false" });
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt);
        return this.request<T>(url, init, attempt + 1, isGraphql);
      }
      throw new GitHubError(
        `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
        0
      );
    }

    if (res.status === 304) {
      throw new GitHubError("Not modified", 304);
    }

    if (res.ok) {
      if (isGraphql) {
        const body = (await res.json()) as {
          data?: T;
          errors?: Array<{ message: string; type?: string }>;
        };
        if (body.errors?.length) {
          const first = body.errors[0]!;
          throw new GitHubError(`GitHub GraphQL error: ${first.message}`, 200);
        }
        return body.data as T;
      }
      return (await res.json()) as T;
    }

    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" ||
        (res.headers.get("retry-after") ?? null) !== null));

    if (rateLimited && attempt < 4) {
      const retryAfterHeader = res.headers.get("retry-after");
      const resetHeader = res.headers.get("x-ratelimit-reset");
      let waitMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : resetHeader
          ? Math.max(0, Number(resetHeader) * 1000 - Date.now()) + 1000
          : 1500 * 2 ** attempt;
      waitMs = Math.min(waitMs, 60_000);
      if (token) this.pool.penalize(token, Date.now() + waitMs);
      incCounter("github_rate_limit_waits_total");
      logger().warn({ url: redactUrl(url), waitMs, attempt }, "github rate limited, backing off");
      await sleep(waitMs);
      return this.request<T>(url, init, attempt + 1, isGraphql);
    }

    if (res.status >= 500 && attempt < 2) {
      await sleep(500 * 2 ** attempt);
      return this.request<T>(url, init, attempt + 1, isGraphql);
    }

    // Out of retries. GitHub's rate-limit body embeds the server's egress IP
    // and points at auth docs the visitor cannot act on, so surface a message
    // that is accurate for them instead of echoing it verbatim.
    if (rateLimited) {
      throw new GitHubError(
        "This server has exhausted GitHub's anonymous API rate limit. Scans resume " +
          "once the limit resets — please try again shortly.",
        res.status,
        null,
        true
      );
    }

    let message = `GitHub API ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON body */
    }
    if (res.status === 404) {
      throw new GitHubError(
        "Repository not found — it must be a public GitHub repository.",
        404
      );
    }
    throw new GitHubError(message, res.status);
  }
}

function redactUrl(url: string): string {
  return url.replace(/([?&]access_token=)[^&]+/gi, "$1[redacted]");
}

/* ------------------------------------------------------------------ */
/* Mock client (MOCK_GITHUB=1)                                         */
/* ------------------------------------------------------------------ */

export interface GithubFixture {
  headSha: string;
  repo: {
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
    /** Repository size in KB, as GitHub reports it. */
    size: number;
  };
  pullRequests: Array<{
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
    body: string | null;
  }>;
  prTotalCount?: number;
  commitCount?: number;
}

class MockGithubClient implements GithubClient {
  private calls = 0;
  private cache = new Map<string, GithubFixture | null>();

  constructor(private readonly fixtureDir: string) {}

  get callCount(): number {
    return this.calls;
  }

  async #fixtureFor(owner: string, name: string): Promise<GithubFixture> {
    const key = `${owner}/${name}`.toLowerCase();
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    } else {
      const file = path.join(this.fixtureDir, `${owner}__${name}.json`.toLowerCase());
      try {
        const fixture = JSON.parse(await fs.readFile(file, "utf8")) as GithubFixture;
        this.cache.set(key, fixture);
        return fixture;
      } catch {
        this.cache.set(key, null);
      }
    }
    throw new GitHubError(
      `Repository not found — it must be a public GitHub repository.`,
      404
    );
  }

  async rest<T>(apiPath: string): Promise<T> {
    this.calls += 1;
    const m = apiPath.match(/^\/repos\/([^/]+)\/([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/);
    if (!m) throw new GitHubError(`mock: unsupported path ${apiPath}`, 404);
    const fixture = await this.#fixtureFor(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
    const sub = m[3] ?? "";
    if (/^commits\/?$/.test(sub)) {
      return [
        {
          sha: fixture.headSha,
          commit: { committer: { date: new Date().toISOString() } },
        },
      ] as T;
    }
    return fixture.repo as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.calls += 1;
    const owner = String(variables.owner ?? "");
    const name = String(variables.name ?? "");
    const fixture = await this.#fixtureFor(owner, name);
    if (/pullRequests/.test(query)) {
      // PR list query (also carries totalCount — check before the history probe)
      const data = {
        repository: {
          pullRequests: {
            totalCount: fixture.prTotalCount ?? fixture.pullRequests.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: fixture.pullRequests.map((pr) => ({
              number: pr.number,
              title: pr.title,
              url: pr.url,
              state: pr.state,
              createdAt: pr.createdAt,
              mergedAt: pr.mergedAt,
              additions: pr.additions,
              deletions: pr.deletions,
              changedFiles: pr.changedFiles,
              body: pr.body,
              author: pr.author ? { login: pr.author } : null,
            })),
          },
        },
      };
      return data as T;
    }
    // commit-history totalCount probe
    const data = {
      repository: {
        object: {
          history: { totalCount: fixture.commitCount ?? fixture.pullRequests.length * 5 },
        },
      },
    };
    return data as T;
  }
}

export function createGithubClient(cfg: AppConfig): GithubClient {
  if (cfg.mockGithub) {
    return new MockGithubClient(path.join(cfg.fixtureRepoDir, "..", "github"));
  }
  return new RealGithubClient(cfg);
}

let clientSingleton: GithubClient | null = null;

declare global {
  var __ca_gh: GithubClient | undefined;
}

export function github(): GithubClient {
  if (globalThis.__ca_gh) return globalThis.__ca_gh;
  clientSingleton ??= createGithubClient(config());
  globalThis.__ca_gh = clientSingleton;
  return clientSingleton;
}
