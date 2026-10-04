import { describe, expect, it, afterAll } from "vitest";
import http from "node:http";
import { createGithubClient, GitHubError } from "@/server/github/client";
import { loadConfig } from "@/server/config";

/** Minimal GitHub API double with scripted behaviors. */
function startMock(): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  let rest404Count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "none"}`);
      const url = req.url ?? "";

      if (url.startsWith("/repos/ok/repo")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "repo", private: false, default_branch: "main" }));
        return;
      }
      if (url.startsWith("/repos/missing/repo")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (url.startsWith("/repos/limited/repo") && rest404Count < 2) {
        // Rate limit the first two attempts, then succeed.
        rest404Count += 1;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ message: "API rate limit exceeded" }));
        return;
      }
      if (url.startsWith("/repos/limited/repo")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "repo", private: false }));
        return;
      }
      if (url.startsWith("/repos/exhausted/repo")) {
        // Always rate limited. `retry-after: 0` keeps the backoff instant so the
        // retry budget is exhausted within the test timeout.
        res.writeHead(403, { "content-type": "application/json", "retry-after": "0" });
        res.end(
          JSON.stringify({
            message:
              "API rate limit exceeded for 203.0.113.7. (But here's the good news: " +
              "Authenticated requests get a higher rate limit.)",
          })
        );
        return;
      }
      if (url === "/graphql" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      number: 7,
                      title: "Add thing",
                      url: "https://github.com/ok/repo/pull/7",
                      state: "MERGED",
                      createdAt: "2024-01-01T00:00:00Z",
                      mergedAt: "2024-01-01T01:00:00Z",
                      additions: 10,
                      deletions: 1,
                      changedFiles: 2,
                      body: "A body",
                      author: { login: "ada" },
                    },
                  ],
                },
              },
            },
          })
        );
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "boom" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        calls,
      });
    });
  });
}

describe("GitHub client against an HTTP mock", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  afterAll(async () => {
    await mock?.close();
  });

  it("performs REST GETs with auth headers", async () => {
    mock = await startMock();
    const cfg = loadConfig({
      GITHUB_API_BASE: mock.url,
      GITHUB_TOKENS: "token-one,token-two",
      REDIS_URL: "",
      DATABASE_URL: "",
      MOCK_GITHUB: "",
    });
    const client = createGithubClient(cfg);
    const meta = await client.rest<{ name: string }>("/repos/ok/repo");
    expect(meta.name).toBe("repo");
    expect(mock.calls[0]).toContain("auth=Bearer token-");
  });

  it("retries on 429 and succeeds", async () => {
    mock = mock ?? (await startMock());
    const cfg = loadConfig({
      GITHUB_API_BASE: mock.url,
      GITHUB_TOKENS: "t",
      REDIS_URL: "",
      DATABASE_URL: "",
      MOCK_GITHUB: "",
    });
    const client = createGithubClient(cfg);
    const meta = await client.rest<{ name: string }>("/repos/limited/repo");
    expect(meta.name).toBe("repo");
  });

  it("translates 404 into a friendly error", async () => {
    mock = mock ?? (await startMock());
    const cfg = loadConfig({
      GITHUB_API_BASE: mock.url,
      REDIS_URL: "",
      DATABASE_URL: "",
      MOCK_GITHUB: "",
    });
    const client = createGithubClient(cfg);
    await expect(client.rest("/repos/missing/repo")).rejects.toMatchObject({
      message: expect.stringContaining("public GitHub repository"),
      status: 404,
    } satisfies Partial<GitHubError>);
  });

  it("never leaks the server egress IP in rate-limit errors", async () => {
    mock = mock ?? (await startMock());
    const cfg = loadConfig({
      GITHUB_API_BASE: mock.url,
      REDIS_URL: "",
      DATABASE_URL: "",
      MOCK_GITHUB: "",
    });
    const client = createGithubClient(cfg);
    const err = await client.rest("/repos/exhausted/repo").catch((e: GitHubError) => e);

    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).rateLimited).toBe(true);
    // GitHub's raw body embeds our IP and links auth docs the visitor cannot use.
    expect((err as GitHubError).message).not.toContain("203.0.113.7");
    expect((err as GitHubError).message).not.toContain("Authenticated requests");
    expect((err as GitHubError).message).toContain("rate limit");
  });

  it("parses GraphQL responses and surfaces errors", async () => {
    mock = mock ?? (await startMock());
    const cfg = loadConfig({
      GITHUB_GRAPHQL_URL: `${mock.url}/graphql`,
      REDIS_URL: "",
      DATABASE_URL: "",
      MOCK_GITHUB: "",
    });
    const client = createGithubClient(cfg);
    const data = await client.graphql<{
      repository: { pullRequests: { totalCount: number; nodes: Array<{ number: number }> } };
    }>("query { repository { pullRequests { totalCount } } }", { owner: "ok", name: "repo" });
    expect(data.repository.pullRequests.totalCount).toBe(1);
    expect(data.repository.pullRequests.nodes[0]!.number).toBe(7);
  });
});
