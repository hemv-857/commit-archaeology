import { NextResponse } from "next/server";
import { gitAvailable } from "@/server/git/clone";
import { getStore } from "@/server/store";
import { scanQueue } from "@/server/queue";
import { config } from "@/server/config";
import { histogramP95 } from "@/server/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Health endpoint for load balancers / Docker HEALTHCHECK.
 * Returns 503 when a core dependency (git binary, store) is unavailable.
 */
export async function GET() {
  const cfg = config();
  const started = Date.now();

  const [git, store, queueStats] = await Promise.all([
    gitAvailable(),
    getStore().then((s) => s.ping()).catch(() => false),
    scanQueue()
      .stats()
      .catch(() => ({ waiting: -1, active: -1 })),
  ]);

  let redis = null;
  if (cfg.redisUrl) {
    try {
      const { default: RedisCtor } = await import("ioredis");
      const r = new RedisCtor(cfg.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      redis = (await r.ping()) === "PONG";
      r.disconnect();
    } catch {
      redis = false;
    }
  }

  const checks: Record<string, boolean | null> = {
    git,
    store,
    redis,
  };
  const degraded = git !== true || store !== true;

  const body = {
    status: degraded ? "degraded" : "ok",
    version: process.env.npm_package_version ?? "1.0.0",
    env: cfg.env,
    uptimeSec: Math.round(process.uptime()),
    checks,
    queue: queueStats,
    metrics: {
      scanP95Ms: histogramP95("scan_duration_ms"),
      cloneP95Ms: histogramP95("clone_duration_ms"),
    },
    tookMs: Date.now() - started,
  };

  return NextResponse.json(body, {
    status: degraded ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
