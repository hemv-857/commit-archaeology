import { NextResponse } from "next/server";
import { scanQueue } from "@/server/queue";
import { clearInflight } from "@/server/inflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = await scanQueue().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Unknown job id." }, { status: 404 });
  }
  if (job.status === "done" || job.status === "failed") {
    clearInflight(`${job.owner}/${job.name}`.toLowerCase());
  }
  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      storyUrl: job.storyUrl,
      pollUrl: `/api/scan/${job.id}`,
      streamUrl: `/api/scan/${job.id}/events`,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
