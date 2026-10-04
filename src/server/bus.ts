/**
 * Progress event fan-out for scan jobs.
 *  - memory driver: EventEmitter (single-process dev / inline worker)
 *  - redis driver: pub/sub (multi-instance production with BullMQ workers)
 */
import { EventEmitter } from "node:events";
import type { ScanProgress } from "@/lib/types";
import { config } from "./config";

export interface ProgressBus {
  readonly driver: "memory" | "redis";
  publish(jobId: string, progress: ScanProgress): Promise<void>;
  subscribe(jobId: string, listener: (p: ScanProgress) => void): () => void;
  /** Replay the latest known progress for late SSE subscribers. */
  latest(jobId: string): ScanProgress | null;
}

class MemoryBus implements ProgressBus {
  readonly driver = "memory" as const;
  private readonly emitter = new EventEmitter();
  private readonly latestMap = new Map<string, ScanProgress>();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  async publish(jobId: string, progress: ScanProgress): Promise<void> {
    this.latestMap.set(jobId, progress);
    this.emitter.emit(`job:${jobId}`, progress);
  }

  subscribe(jobId: string, listener: (p: ScanProgress) => void): () => void {
    const channel = `job:${jobId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  latest(jobId: string): ScanProgress | null {
    return this.latestMap.get(jobId) ?? null;
  }
}

class RedisBus implements ProgressBus {
  readonly driver = "redis" as const;
  private publisher: import("ioredis").Redis | null = null;
  private subscriber: import("ioredis").Redis | null = null;
  private readonly emitter = new EventEmitter();
  private readonly latestMap = new Map<string, ScanProgress>();

  async #ensure() {
    if (this.publisher && this.subscriber) return;
    const { default: RedisCtor } = await import("ioredis");
    const url = config().redisUrl!;
    this.publisher ??= new RedisCtor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.subscriber ??= new RedisCtor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    this.subscriber.on("message", (channel: string, message: string) => {
      try {
        const p = JSON.parse(message) as ScanProgress;
        const jobId = channel.slice("progress:".length);
        this.latestMap.set(jobId, p);
        this.emitter.emit(channel, p);
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  async publish(jobId: string, progress: ScanProgress): Promise<void> {
    this.latestMap.set(jobId, progress);
    this.emitter.emit(`progress:${jobId}`, progress); // same-process subscribers
    try {
      await this.#ensure();
      await this.publisher!.publish(`progress:${jobId}`, JSON.stringify(progress));
    } catch {
      /* redis down: same-process subscribers still work */
    }
  }

  subscribe(jobId: string, listener: (p: ScanProgress) => void): () => void {
    const channel = `progress:${jobId}`;
    this.emitter.on(channel, listener);
    void this.#ensure()
      .then(() => this.subscriber!.subscribe(channel))
      .catch(() => {});
    return () => this.emitter.off(channel, listener);
  }

  latest(jobId: string): ScanProgress | null {
    return this.latestMap.get(jobId) ?? null;
  }
}

let singleton: ProgressBus | null = null;

declare global {
  var __ca_bus: ProgressBus | undefined;
}

export function progressBus(): ProgressBus {
  if (globalThis.__ca_bus) return globalThis.__ca_bus;
  singleton ??= config().redisUrl ? new RedisBus() : new MemoryBus();
  globalThis.__ca_bus = singleton;
  return singleton;
}
