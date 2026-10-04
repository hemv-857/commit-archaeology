import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getStore } from "@/server/store";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { isSafeRepoSlug } from "@/lib/repo-url";
import { filterCommits } from "@/lib/commit-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Commits for an analysed repo, served outside the story document so page loads
 * do not embed them.
 *
 *   ?sha=<prefix>   single commit lookup (what the commit drawer uses)
 *   ?q=<term>       search — supports `subject:`, `author:`, `path:`, `sha:`
 *   ?limit=&offset= paged list
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo: name } = await params;
  const cfg = config();

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

  const commits = await store.getCommits(owner, name, stored.headSha);
  const url = new URL(req.url);

  // Single-commit lookup. Accepts a unique prefix; an ambiguous or unknown
  // prefix is a miss rather than an arbitrary pick.
  const sha = url.searchParams.get("sha");
  if (sha) {
    const needle = sha.toLowerCase();
    const matches = commits.filter((c) => c.sha.startsWith(needle));
    if (matches.length === 0) {
      return NextResponse.json({ error: "Unknown commit." }, { status: 404 });
    }
    if (matches.length > 1) {
      return NextResponse.json(
        { error: "Ambiguous commit prefix.", matches: matches.slice(0, 5).map((c) => c.sha) },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { commit: matches[0]! },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  }

  const q = url.searchParams.get("q");
  // Search happens over the whole analysed set, then the page is sliced, so a
  // match on commit 900 is still reachable from page 1.
  const matched = q ? filterCommits(commits, q) : commits;

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT)
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const page = matched.slice(offset, offset + limit);

  return NextResponse.json(
    {
      commits: page,
      total: matched.length,
      offset,
      limit,
      hasMore: offset + page.length < matched.length,
    },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}