import { renderPrometheus } from "@/server/metrics";
import { scanQueue } from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prometheus text exposition of scan/clone/request metrics. */
export async function GET() {
  let queueLine = "";
  try {
    const { waiting, active } = await scanQueue().stats();
    queueLine = `scan_queue_depth{state="waiting"} ${waiting}\nscan_queue_depth{state="active"} ${active}\n`;
  } catch {
    queueLine = "";
  }
  return new Response(`${renderPrometheus()}${queueLine}`, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
