import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One client must not be able to occupy every worker slot.
 *
 * The per-IP rate limit caps how *often* a client may ask for a scan; without a
 * concurrency cap a single IP keeps every slot busy indefinitely by holding
 * several scans in flight. This drives the real MemoryQueue lifecycle (enqueue
 * → handler runs → handler returns) rather than asserting on the counter alone.
 */
process.env.REDIS_URL = "";
process.env.DATABASE_URL = "";
process.env.MOCK_GITHUB = "1";
process.env.OPENAI_API_KEY = "";
process.env.SCAN_CONCURRENCY = "4";
// enqueue() lazily boots the real worker, which would install its own runScan
// handler over the stub this test needs. DISABLE_INLINE_WORKER is the
// documented switch for externally-managed workers.
process.env.DISABLE_INLINE_WORKER = "1";

let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-perip-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("per-IP active scan cap", () => {
  it("counts a running scan against its IP and releases it on completion", async () => {
    const { scanQueue } = await import("@/server/queue");
    const q = scanQueue();

    let release!: () => void;
    const started = new Promise<void>((r) => {
      release = () => r();
    });
    let handlerEntered!: () => void;
    const entered = new Promise<void>((r) => {
      handlerEntered = () => r();
    });

    await q.startWorker(async (job, onProgress) => {
      handlerEntered();
      await onProgress({ stage: "clone", pct: 5, message: "cloning" });
      await started;
      await onProgress({ stage: "done", pct: 100, message: "done" });
    });

    const job = await q.enqueue({
      owner: "acme",
      name: "widget",
      url: "https://github.com/acme/widget",
      ip: "203.0.113.10",
    });

    await entered;
    // While the handler is in flight the IP is charged for it.
    expect(q.activeScansForIp("203.0.113.10")).toBe(1);
    // ...and nobody else is.
    expect(q.activeScansForIp("203.0.113.11")).toBe(0);

    release();

    // The queue releases the slot in its own `finally`.
    await expect
      .poll(() => q.activeScansForIp("203.0.113.10"), { timeout: 5_000 })
      .toBe(0);

    await expect.poll(async () => (await q.getJob(job.id))?.status).toBe("done");
  });

  it("charges concurrent scans to different IPs independently", async () => {
    const { scanQueue } = await import("@/server/queue");
    const q = scanQueue();

    const releases: Array<() => void> = [];
    let entered = 0;
    const bothEntered = new Promise<void>((resolve) => {
      const maybe = () => {
        entered += 1;
        if (entered >= 2) resolve();
      };
      (q as unknown as { __onEnter?: () => void }).__onEnter = maybe;
    });

    await q.startWorker(async (job, onProgress) => {
      (q as unknown as { __onEnter?: () => void }).__onEnter?.();
      await new Promise<void>((r) => releases.push(r));
      await onProgress({ stage: "done", pct: 100, message: "done" });
    });

    await q.enqueue({ owner: "a", name: "one", url: "u", ip: "198.51.100.1" });
    await q.enqueue({ owner: "b", name: "two", url: "u", ip: "198.51.100.2" });

    await bothEntered;
    expect(q.activeScansForIp("198.51.100.1")).toBe(1);
    expect(q.activeScansForIp("198.51.100.2")).toBe(1);

    for (const r of releases) r();
    await expect
      .poll(() => q.activeScansForIp("198.51.100.1") + q.activeScansForIp("198.51.100.2"), {
        timeout: 5_000,
      })
      .toBe(0);
  });

  it("releases the slot even when the scan throws", async () => {
    const { scanQueue } = await import("@/server/queue");
    const q = scanQueue();

    let handlerEntered!: () => void;
    const entered = new Promise<void>((r) => {
      handlerEntered = () => r();
    });

    await q.startWorker(async () => {
      handlerEntered();
      throw new Error("clone exploded");
    });

    const job = await q.enqueue({
      owner: "acme",
      name: "boom",
      url: "u",
      ip: "192.0.2.5",
    });

    await entered;
    expect(q.activeScansForIp("192.0.2.5")).toBe(1);

    await expect.poll(() => q.activeScansForIp("192.0.2.5"), { timeout: 5_000 }).toBe(0);
    await expect.poll(async () => (await q.getJob(job.id))?.status).toBe("failed");
  });

  it("jobs without an ip are not charged to anyone", async () => {
    const { scanQueue } = await import("@/server/queue");
    const q = scanQueue();

    let handlerEntered!: () => void;
    const entered = new Promise<void>((r) => {
      handlerEntered = () => r();
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = () => r();
    });

    await q.startWorker(async (job, onProgress) => {
      handlerEntered();
      await held;
      await onProgress({ stage: "done", pct: 100, message: "done" });
    });

    await q.enqueue({ owner: "acme", name: "noip", url: "u" });
    await entered;
    expect(q.activeScansForIp("")).toBe(0);
    release();
  });
});

describe("maxConcurrentScansPerIp config", () => {
  it("defaults to 1", async () => {
    const { loadConfig } = await import("@/server/config");
    expect(loadConfig({}).maxConcurrentScansPerIp).toBe(1);
  });

  it("is configurable", async () => {
    const { loadConfig } = await import("@/server/config");
    expect(loadConfig({ MAX_CONCURRENT_SCANS_PER_IP: "3" }).maxConcurrentScansPerIp).toBe(3);
  });

  it("ignores a 0 or negative cap, which would wedge all scanning", async () => {
    const { loadConfig } = await import("@/server/config");
    expect(loadConfig({ MAX_CONCURRENT_SCANS_PER_IP: "0" }).maxConcurrentScansPerIp).toBe(1);
    expect(loadConfig({ MAX_CONCURRENT_SCANS_PER_IP: "-5" }).maxConcurrentScansPerIp).toBe(1);
    expect(loadConfig({ MAX_CONCURRENT_SCANS_PER_IP: "abc" }).maxConcurrentScansPerIp).toBe(1);
  });
});