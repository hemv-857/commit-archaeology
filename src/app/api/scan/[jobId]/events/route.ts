import { NextResponse } from "next/server";
import { scanQueue } from "@/server/queue";
import { progressBus } from "@/server/bus";
import { clearInflight } from "@/server/inflight";
import type { ScanProgress } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of scan progress.
 * Subscribes to the progress bus (in-memory or Redis) and additionally polls
 * the persisted job every 4s as a fallback across process boundaries.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const queue = scanQueue();
  const bus = progressBus();

  const job = await queue.getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Unknown job id." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const finish = (terminal: ScanProgress) => {
        send("progress", terminal);
        send("end", { ok: terminal.stage === "done" });
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const cleanup = () => {
        closed = true;
        unsubscribe?.();
        if (keepAlive) clearInterval(keepAlive);
        if (poll) clearInterval(poll);
      };

      // Replay latest known progress immediately.
      const latest = bus.latest(jobId);
      if (latest) send("progress", latest);

      // Terminal states already persisted before connect.
      if (job.status === "done" || job.status === "failed") {
        finish(
          job.status === "done"
            ? { stage: "done", pct: 100, message: "Story ready." }
            : { stage: "error", pct: 100, message: job.error ?? "Scan failed." }
        );
        return;
      }

      unsubscribe = bus.subscribe(jobId, (p) => {
        if (p.stage === "done" || p.stage === "error") {
          if (p.stage === "done") {
            clearInflight(`${job.owner}/${job.name}`.toLowerCase());
          }
          finish(p);
        } else {
          send("progress", p);
        }
      });

      // Fallback poll: catches progress published before we subscribed or
      // from another process where the Redis bus is unavailable.
      poll = setInterval(async () => {
        if (closed) return;
        try {
          const fresh = await queue.getJob(jobId);
          if (!fresh) return;
          if (fresh.status === "done" || fresh.status === "failed") {
            finish(
              fresh.status === "done"
                ? { stage: "done", pct: 100, message: "Story ready." }
                : {
                    stage: "error",
                    pct: 100,
                    message: fresh.error ?? "Scan failed.",
                  }
            );
          } else {
            send("progress", fresh.progress);
          }
        } catch {
          /* transient store errors: keep the stream alive */
        }
      }, 4000);

      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
      if (poll) clearInterval(poll);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
