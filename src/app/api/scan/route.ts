import { NextResponse } from "next/server";
import { parseRepoUrl, RepoUrlError } from "@/lib/repo-url";
import { config } from "@/server/config";
import { reqLogger } from "@/server/logger";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { getStore } from "@/server/store";
import { scanQueue } from "@/server/queue";
import { captureException } from "@/server/telemetry";
import { inflight, markInflight, clearInflight } from "@/server/inflight";
import type { ScanJob } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobResponse(job: ScanJob) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    storyUrl: job.storyUrl,
    pollUrl: `/api/scan/${job.id}`,
    streamUrl: `/api/scan/${job.id}/events`,
  };
}

export async function POST(req: Request) {
  const requestId = req.headers.get("x-request-id") ?? "unknown";
  const log = reqLogger(requestId, { route: "POST /api/scan" });
  try {
    const cfg = config();
    const ip = clientIp(req);
    const rl = await rateLimit(
      `scan:${ip}`,
      cfg.rateLimitScanPoints,
      cfg.rateLimitScanWindowSec
    );
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many scans from this IP. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(rl.resetSec) } }
      );
    }

    let body: { url?: unknown };
    try {
      body = (await req.json()) as { url?: unknown };
    } catch {
      return NextResponse.json({ error: "Expected a JSON body with a `url` field." }, { status: 400 });
    }
    if (typeof body.url !== "string") {
      return NextResponse.json(
        { error: "Missing `url` — e.g. https://github.com/vercel/next.js" },
        { status: 400 }
      );
    }

    let repo;
    try {
      repo = parseRepoUrl(body.url);
    } catch (err) {
      if (err instanceof RepoUrlError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const store = await getStore();
    const stored = await store.getStory(repo.owner, repo.name);
    const fresh =
      stored && Date.now() - new Date(stored.scannedAt).getTime() < cfg.revalidateAfterSec * 1000;

    if (stored) {
      // Serve the cached story; refresh in the background when stale (SWR).
      if (!fresh && !inflight().has(repo.slug)) {
        const queue = scanQueue();
        const job = await queue.enqueue({ owner: repo.owner, name: repo.name, url: repo.url });
        markInflight(repo.slug, job.id);
        log.info({ repo: repo.slug, jobId: job.id }, "background revalidation enqueued");
      }
      return NextResponse.json(
        {
          status: "ready",
          storyUrl: `/github.com/${repo.owner}/${repo.name}`,
          headSha: stored.headSha,
          scannedAt: stored.scannedAt,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const existingJobId = inflight().get(repo.slug);
    if (existingJobId) {
      const job = await scanQueue().getJob(existingJobId);
      if (job && (job.status === "queued" || job.status === "running")) {
        return NextResponse.json(jobResponse(job), { status: 202 });
      }
      clearInflight(repo.slug);
    }

    // The rate limit above caps how *often* one IP may ask; this stops a single
    // client from holding every worker slot by keeping several scans running.
    if (scanQueue().activeScansForIp(ip) >= cfg.maxConcurrentScansPerIp) {
      return NextResponse.json(
        {
          error:
            "You already have a scan running. Wait for it to finish before starting another.",
        },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }

    const job = await scanQueue().enqueue({
      owner: repo.owner,
      name: repo.name,
      url: repo.url,
      ip,
    });
    markInflight(repo.slug, job.id);
    log.info({ repo: repo.slug, jobId: job.id }, "scan enqueued");
    return NextResponse.json(jobResponse(job), { status: 202 });
  } catch (err) {
    log.error({ err }, "POST /api/scan failed");
    void captureException(err, { route: "POST /api/scan" });
    return NextResponse.json({ error: "Internal error starting the scan." }, { status: 500 });
  }
}
