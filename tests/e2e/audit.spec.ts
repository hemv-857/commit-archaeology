import { test, expect } from "@playwright/test";
import path from "node:path";
import { rm } from "node:fs/promises";

/**
 * End-to-end audit of the HTTP surface: input validation, auth boundaries,
 * caching semantics, error handling and security headers.
 *
 * Runs against MOCK_GITHUB=1 fixtures (no network). Rate limits are raised in
 * playwright.config.ts so these cases cannot interfere with each other; the
 * limiter itself is covered by tests/unit/ratelimit.test.ts.
 */

const post = (baseURL: string | undefined, body: unknown) => {
  if (!baseURL) throw new Error("baseURL fixture unavailable");
  return fetch(`${baseURL}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};

/**
 * Guarantee acme/widget is analysed before the read-path assertions run.
 * Without this they depend on another spec file happening to scan first.
 */
test.beforeAll(async ({ baseURL }) => {
  const res = await post(baseURL, { url: "github.com/acme/widget" });
  const job = (await res.json()) as { jobId?: string; status?: string };
  if (job.status === "ready") return; // already cached
  await expect
    .poll(
      async () => {
        const r = await fetch(`${baseURL}/api/scan/${job.jobId}`);
        return ((await r.json()) as { status: string }).status;
      },
      { timeout: 60_000, intervals: [500] }
    )
    .toBe("done");
});

test.describe("POST /api/scan — input validation", () => {
  test("rejects a non-GitHub host (SSRF boundary)", async ({ baseURL }) => {
    const res = await post(baseURL, { url: "https://evil.example.com/a/b" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/github\.com/i);
  });

  test("rejects lookalike and userinfo hosts", async ({ baseURL }) => {
    for (const url of [
      "https://github.com.evil.com/a/b",
      "https://user:pass@github.com/a/b",
      "https://github.com:8443/a/b",
      "ftp://github.com/a/b",
    ]) {
      const res = await post(baseURL, { url });
      expect(res.status, url).toBe(400);
    }
  });

  test("rejects traversal, sub-pages and missing repo", async ({ baseURL }) => {
    for (const url of [
      "https://github.com/a/b/../../admin",
      "https://github.com/a/b/issues",
      "https://github.com/onlyowner",
    ]) {
      const res = await post(baseURL, { url });
      expect(res.status, url).toBe(400);
    }
  });

  test("rejects non-string and malformed bodies", async ({ baseURL }) => {
    expect((await post(baseURL, {})).status).toBe(400);
    expect((await post(baseURL, { url: 42 })).status).toBe(400);
    expect((await post(baseURL, { url: "" })).status).toBe(400);

    const bad = await fetch(`${baseURL}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
  });
});

test.describe("GET /api/repos — path safety", () => {
  test("blocks traversal in raw path params", async ({ baseURL }) => {
    for (const p of [
      "..%2F..%2Fetc%2Fpasswd",
      "..",
      "%2e%2e%2fx",
    ]) {
      const res = await fetch(`${baseURL}/api/repos/${p}/x`);
      expect([400, 404], p).toContain(res.status);
      if (res.status === 400) expect((await res.json()).error).toBeTruthy();
    }
  });

  test("returns not_scanned for an unknown repo", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/nobody/nothing`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_scanned");
  });

  test("serves ETag and honours If-None-Match", async ({ baseURL }) => {
    const first = await fetch(`${baseURL}/api/repos/acme/widget`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{40}-/);

    const second = await fetch(`${baseURL}/api/repos/acme/widget`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });
});

test.describe("GET /api/repos/{owner}/{repo}/commits", () => {
  test("pages the commit list", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/acme/widget/commits?limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commits.length).toBe(5);
    expect(body.total).toBeGreaterThan(5);
    expect(body.hasMore).toBe(true);
    expect(body.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("resolves a single commit by sha prefix", async ({ baseURL }) => {
    const list = await (await fetch(`${baseURL}/api/repos/acme/widget/commits?limit=1`)).json();
    const sha: string = list.commits[0].sha;

    const res = await fetch(`${baseURL}/api/repos/acme/widget/commits?sha=${sha.slice(0, 7)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commit.sha).toBe(sha);
    // The data the drawer renders must actually be present.
    expect(body.commit.subject).toBeTruthy();
    expect(body.commit.authorName).toBeTruthy();
  });

  test("search filters across the whole set, not just the first page", async ({
    baseURL,
  }) => {
    // The fixture has more commits than one page returns.
    const all = await (await fetch(`${baseURL}/api/repos/acme/widget/commits?limit=200`)).json();

    const byAuthor = await (
      await fetch(`${baseURL}/api/repos/acme/widget/commits?q=author%3Aada&limit=200`)
    ).json();
    expect(byAuthor.total).toBeGreaterThan(0);
    expect(byAuthor.total).toBeLessThan(all.total);
    for (const c of byAuthor.commits) {
      expect(`${c.authorName} ${c.authorEmail}`.toLowerCase()).toContain("ada");
    }

    const byPath = await (
      await fetch(`${baseURL}/api/repos/acme/widget/commits?q=path%3Acore&limit=200`)
    ).json();
    expect(byPath.total).toBeGreaterThan(0);
    for (const c of byPath.commits) {
      expect(c.files.some((f: string) => f.toLowerCase().includes("core"))).toBe(true);
    }

    const nothing = await (
      await fetch(`${baseURL}/api/repos/acme/widget/commits?q=zzzznope`)
    ).json();
    expect(nothing.total).toBe(0);
    expect(nothing.commits).toEqual([]);
  });

  test("search paging slices the matched set", async ({ baseURL }) => {
    const first = await (
      await fetch(`${baseURL}/api/repos/acme/widget/commits?q=author%3Aada&limit=2&offset=0`)
    ).json();
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await (
      await fetch(`${baseURL}/api/repos/acme/widget/commits?q=author%3Aada&limit=2&offset=2`)
    ).json();
    const firstShas = first.commits.map((c: { sha: string }) => c.sha);
    const secondShas = second.commits.map((c: { sha: string }) => c.sha);
    expect(firstShas.some((s: string) => secondShas.includes(s))).toBe(false);
  });

  test("404s an unknown sha and 409s an ambiguous prefix", async ({ baseURL }) => {
    const missing = await fetch(`${baseURL}/api/repos/acme/widget/commits?sha=${"a".repeat(40)}`);
    expect(missing.status).toBe(404);

    // Fixture shas all start "37"; a 1-char prefix must be ambiguous.
    const ambiguous = await fetch(`${baseURL}/api/repos/acme/widget/commits?sha=3`);
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).matches.length).toBeGreaterThan(1);
  });

  test("404s for a repo that was never scanned", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/nobody/nothing/commits`);
    expect(res.status).toBe(404);
  });

  test("blocks traversal like its parent route", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/${encodeURIComponent("../..")}/x/commits`);
    expect(res.status).toBe(400);
  });
});

test.describe("job endpoints", () => {
  test("unknown job id is 404 on both poll and SSE", async ({ baseURL }) => {
    const poll = await fetch(`${baseURL}/api/scan/does-not-exist`);
    expect(poll.status).toBe(404);

    const sse = await fetch(`${baseURL}/api/scan/does-not-exist/events`);
    expect(sse.status).toBe(404);
  });

  test("a queued job exposes poll + stream urls and reaches a terminal state", async ({
    baseURL,
  }) => {
    // This asserts the *cold* queue contract (202 + poll/stream urls). The
    // beforeAll above deliberately warms the cache, so clear it here — an
    // already-analysed repo correctly answers 200 "ready" instead.
    await rm(path.join(process.cwd(), ".data", "e2e", "stories", "acme__widget"), {
      recursive: true,
      force: true,
    });

    const res = await post(baseURL, { url: "github.com/acme/widget" });
    expect(res.status).toBe(202);
    const job = (await res.json()) as {
      jobId: string;
      streamUrl: string;
      pollUrl: string;
      status: string;
    };
    expect(job.streamUrl).toBe(`/api/scan/${job.jobId}/events`);
    expect(job.pollUrl).toBe(`/api/scan/${job.jobId}`);

    await expect
      .poll(
        async () => {
          const r = await fetch(`${baseURL}${job.pollUrl}`);
          return ((await r.json()) as { status: string }).status;
        },
        { timeout: 60_000, intervals: [500] }
      )
      .toBe("done");
  });
});

test.describe("operational endpoints", () => {
  test("/api/health reports git and store availability", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.git).toBe(true);
    expect(body.checks.store).toBe(true);
    expect(body).toHaveProperty("uptimeSec");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/api/metrics emits Prometheus text", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^# TYPE /m);
    expect(body).toMatch(/scans_total|scan_queue_depth/);
  });

  test("security headers are present on app routes", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

test.describe("GET /api/repos/{owner}/{repo}/export", () => {
  test("serves the story document as JSON by default", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/acme/widget/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(2);
    expect(body.repo.owner).toBe("acme");
    // Commits are opt-in, not embedded by default.
    expect(body).not.toHaveProperty("commits");
  });

  test("includes commits when asked", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/acme/widget/export?format=json&commits=1`);
    const body = await res.json();
    expect(Array.isArray(body.commits)).toBe(true);
    expect(body.commits.length).toBeGreaterThan(0);
  });

  test("renders Markdown as a download", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/api/repos/acme/widget/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("acme-widget-story.md");

    const md = await res.text();
    expect(md.startsWith("# acme/widget")).toBe(true);
    expect(md).toContain("## Who broke what");
    expect(md).toContain("analyzer v");
  });

  test("rejects an unsupported format and 404s an unscanned repo", async ({ baseURL }) => {
    expect((await fetch(`${baseURL}/api/repos/acme/widget/export?format=pdf`)).status).toBe(400);
    expect((await fetch(`${baseURL}/api/repos/nobody/nothing/export`)).status).toBe(404);
  });

  test("blocks traversal and is reachable from the story page", async ({ baseURL }) => {
    expect(
      (await fetch(`${baseURL}/api/repos/${encodeURIComponent("../..")}/x/export`)).status
    ).toBe(400);

    const html = await (await fetch(`${baseURL}/github.com/acme/widget`)).text();
    expect(html).toContain("/api/repos/acme/widget/export?format=md");
  });
});

test.describe("/compare", () => {
  test("renders a side-by-side table when both repos are analysed", async ({ page }) => {
    // The same repo twice is a valid, fully-exercised case (an even split) and
    // avoids needing a second git fixture; the directional logic is covered by
    // tests/unit/compare.test.ts.
    await page.goto("/compare?a=github.com/acme/widget&b=github.com/acme/widget");
    await expect(page.getByRole("heading", { name: "Compare repositories" })).toBeVisible();

    const table = page.locator('section[aria-label="Comparison table"]');
    await expect(table).toBeVisible();
    await expect(table.getByRole("rowheader", { name: /bus factor/i })).toBeVisible();
    await expect(table.getByRole("rowheader", { name: /^commits/i })).toBeVisible();

    // Identical repos must not crown a winner.
    await expect(table.getByText("▲")).toHaveCount(0);
    await expect(page.getByText(/No metric here has a clear/)).toBeVisible();

    await expect(page.locator('section[aria-label="Era comparison"]')).toBeVisible();
  });

  test("prompts for a repo that has not been excavated", async ({ page }) => {
    await page.goto("/compare?a=github.com/acme/widget&b=github.com/acme/not-scanned");
    await expect(page.getByText(/Not excavated yet: acme\/not-scanned/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Start the scan for acme/not-scanned" })
    ).toBeVisible();
    // The side that is ready still renders nothing misleading.
    await expect(page.locator('section[aria-label="Comparison table"]')).toHaveCount(0);
  });

  test("rejects an invalid repo in the query string", async ({ page }) => {
    await page.goto("/compare?a=https://evil.example.com/x/y&b=github.com/acme/widget");
    // Assert the message itself rather than role="alert", which the RSC flight
    // payload duplicates in the document.
    await expect(page.getByText(/Only github\.com repositories can be analyzed/)).toBeVisible();
    // The good side must still be usable.
    await expect(page.getByLabel("First repository")).toHaveValue("https://evil.example.com/x/y");
  });

  test("shows an empty state with no query", async ({ page }) => {
    await page.goto("/compare");
    await expect(page.getByRole("heading", { name: "Compare repositories" })).toBeVisible();
    await expect(page.getByLabel("First repository")).toBeVisible();
    await expect(page.getByLabel("Second repository")).toBeVisible();
  });

  test("the story page links to compare, pre-filled", async ({ page }) => {
    await page.goto("/github.com/acme/widget", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Compare" }).click();
    await expect(page).toHaveURL(/\/compare\?a=acme\/widget/);
    // The link carries `owner/name`, which parseRepoUrl accepts as shorthand.
    await expect(page.getByLabel("First repository")).toHaveValue("acme/widget");
  });
});

test.describe("share surface", () => {
  test("story pages expose a shareable OG image", async ({ baseURL }) => {
    const html = await (await fetch(`${baseURL}/github.com/acme/widget`)).text();

    expect(html).toContain('property="og:image"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    // summary_large_image is what makes X/Slack render it large instead of tiny.
    expect(html).toContain('name="twitter:card" content="summary_large_image"');

    const ogImage = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
    expect(ogImage, "og:image must be absolute").toBeTruthy();
    expect(ogImage).toMatch(/^https?:\/\//);
  });

  // The first render of an OG image is slow (satori + font setup); on a cold
  // container that can exceed the default expect timeout and flake the suite.
  test("the OG image endpoint returns a real PNG", async ({ baseURL }) => {
    test.setTimeout(60_000);
    const res = await fetch(`${baseURL}/github.com/acme/widget/opengraph-image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(2000);
    // PNG magic number.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("an unscanned repo still gets a card rather than an error", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/github.com/nobody/never-scanned/opengraph-image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("robots.txt allows pages, blocks the API, points at the sitemap", async ({ baseURL }) => {
    const body = await (await fetch(`${baseURL}/robots.txt`)).text();
    expect(body).toMatch(/Allow:\s*\//);
    expect(body).toMatch(/Disallow:\s*\/api\//);
    expect(body).toMatch(/Sitemap:\s*https?:\/\/.*\/sitemap\.xml/);
  });

  test("sitemap.xml lists the homepage and every scanned repo", async ({ baseURL }) => {
    const body = await (await fetch(`${baseURL}/sitemap.xml`)).text();
    expect(body).toContain("<urlset");
    expect(body).toMatch(/<loc>https?:\/\/[^<]*\/<\/loc>/);
    // The fixture is scanned by the suite's beforeAll.
    expect(body).toContain("/github.com/acme/widget");
    expect(body).toMatch(/<lastmod>[^<]+<\/lastmod>/);
  });
});

test.describe("unknown routes", () => {
  test("404 rather than leaking a stack trace", async ({ baseURL }) => {
    // An *invalid* slug 404s. A valid-but-uncached repo legitimately renders
    // the scan panel with a 200, so it is not a 404 case.
    const res = await fetch(`${baseURL}/github.com/acme/${encodeURIComponent("../..")}`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toMatch(/at \w+ \(.*:\d+:\d+\)/); // no stack frames
  });
});