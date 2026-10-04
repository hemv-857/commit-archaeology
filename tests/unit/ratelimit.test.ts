import { describe, expect, it } from "vitest";
import { rateLimit } from "@/server/ratelimit";

describe("rate limiter (memory driver)", () => {
  it("allows up to the burst size then blocks", async () => {
    const key = `test:${Math.random()}`;
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await rateLimit(key, 3, 60));
    }
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3]!.ok).toBe(false);
    expect(results[3]!.resetSec).toBeGreaterThan(0);
  });

  it("keys are isolated", async () => {
    const a = `a:${Math.random()}`;
    const b = `b:${Math.random()}`;
    await rateLimit(a, 1, 60);
    expect((await rateLimit(a, 1, 60)).ok).toBe(false);
    expect((await rateLimit(b, 1, 60)).ok).toBe(true);
  });
});
