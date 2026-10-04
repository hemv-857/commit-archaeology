import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { getStore } from "@/server/store";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { isSafeRepoSlug } from "@/lib/repo-url";
import { renderStoryMarkdown } from "@/lib/story-markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exports an analysed story.
 *
 *   ?format=json            the story document verbatim
 *   ?format=json&commits=1  ...plus the analysed commits
 *   ?format=md              a Markdown report
 *
 * Markdown is served as a download so it can be pasted into a PR, an issue or
 * a doc without further formatting.
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

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  const slug = `${owner}/${name}`;

  if (format === "md" || format === "markdown") {
    return new NextResponse(renderStoryMarkdown(stored.story), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug.replace("/", "-")}-story.md"`,
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  if (format !== "json") {
    return NextResponse.json(
      { error: "Unsupported format. Use `json` or `md`." },
      { status: 400 }
    );
  }

  // Commits live outside the document; opt in rather than inflating the default.
  if (url.searchParams.get("commits") === "1") {
    const commits = await store.getCommits(owner, name, stored.headSha);
    return NextResponse.json(
      { ...stored.story, commits },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  }

  return NextResponse.json(stored.story, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}