import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getStore } from "@/server/store";
import { scanQueue } from "@/server/queue";
import { inflight, markInflight } from "@/server/inflight";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { isSafeRepoSlug } from "@/lib/repo-url";
import type { RepoStory } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cached story lookup — the hot path (p95 target < 300ms).
 * Serves with an ETag on the analyzed HEAD sha; when the story is older than
 * REVALIDATE_AFTER_SEC a background re-scan is enqueued (stale-while-revalidate).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo: name } = await params;
  const cfg = config();

  // Raw path params (not a parsed URL): reject traversal before the store
  // turns them into a filesystem path or cache key.
  if (!isSafeRepoSlug(owner, name)) {
    return NextResponse.json({ error: "Invalid repository path." }, { status: 400 });
  }

  const rl = await rateLimit(
    `api:${clientIp(req)}`,
    cfg.rateLimitApiPoints,
    cfg.rateLimitApiWindowSec
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      { status: 429, headers: { "Retry-After": String(rl.resetSec) } }
    );
  }

  const store = await getStore();
  const stored = await store.getStory(owner, name);
  if (!stored) {
    return NextResponse.json(
      { error: "not_scanned", message: "This repository has not been analyzed yet." },
      { status: 404 }
    );
  }

  const etag = `"${stored.headSha}-${stored.story.meta.analyzerVersion}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const ageSec = (Date.now() - new Date(stored.scannedAt).getTime()) / 1000;
  if (ageSec > cfg.revalidateAfterSec && !inflight().has(`${owner}/${name}`.toLowerCase())) {
    const queue = scanQueue();
    const job = await queue.enqueue({
      owner: stored.story.repo.owner,
      name: stored.story.repo.name,
      url: stored.story.repo.url,
      // Counted against the requester so background revalidation cannot be used
      // to sidestep the per-IP concurrency cap.
      ip: clientIp(req),
    });
    markInflight(`${owner}/${name}`.toLowerCase(), job.id);
  }

  const story: RepoStory = stored.story;
  return NextResponse.json(story, {
    headers: {
      ETag: etag,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
