/**
 * Per-IP rate limiting. Two drivers:
 *  - memory: token bucket, per process (default, dev)
 *  - redis: fixed-window INCR/EXPIRE, shared across instances (when REDIS_URL)
 */
import type { Redis } from "ioredis";
import { config } from "./config";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSec: number;
  limit: number;
}

interface TokenBucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, TokenBucket>();
let lastSweep = 0;

function memAllow(key: string, points: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  // periodic sweep to bound memory
  if (now - lastSweep > 120_000) {
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (now - b.updated > windowSec * 2000) buckets.delete(k);
    }
  }
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: points, updated: now };
    buckets.set(key, bucket);
  }
  const refillRate = points / (windowSec * 1000);
  const elapsed = now - bucket.updated;
  bucket.tokens = Math.min(points, bucket.tokens + elapsed * refillRate);
  bucket.updated = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens), resetSec: windowSec, limit: points };
  }
  const waitMs = (1 - bucket.tokens) / refillRate;
  return { ok: false, remaining: 0, resetSec: Math.ceil(waitMs / 1000), limit: points };
}

let redisClient: Redis | null = null;
let redisTried = false;

async function getRedis(): Promise<Redis | null> {
  if (redisTried) return redisClient;
  redisTried = true;
  const url = config().redisUrl;
  if (!url) return null;
  try {
    const { default: RedisCtor } = await import("ioredis");
    redisClient = new RedisCtor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redisClient.connect();
    return redisClient;
  } catch (err) {
    console.warn("redis unavailable, falling back to in-memory rate limit", err);
    redisClient = null;
    return null;
  }
}

async function redisAllow(
  key: string,
  points: number,
  windowSec: number
): Promise<RateLimitResult | null> {
  const redis = await getRedis();
  if (!redis) return null;
  const window = Math.floor(Date.now() / (windowSec * 1000));
  const rkey = `rl:${key}:${window}`;
  try {
    const count = await redis.incr(rkey);
    if (count === 1) await redis.expire(rkey, windowSec + 1);
    const remaining = Math.max(0, points - count);
    const resetSec = (window + 1) * windowSec - Math.floor(Date.now() / 1000);
    return { ok: count <= points, remaining, resetSec: Math.max(1, resetSec), limit: points };
  } catch {
    return null; // redis hiccup → fail open via memory
  }
}

export async function rateLimit(
  key: string,
  points: number,
  windowSec: number
): Promise<RateLimitResult> {
  const viaRedis = await redisAllow(key, points, windowSec);
  return viaRedis ?? memAllow(key, points, windowSec);
}

/** Best-effort client IP extraction behind proxies. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
