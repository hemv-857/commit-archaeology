/**
 * Per-process registry of in-flight scans, used to de-duplicate concurrent
 * scan requests for the same repo (single instance). With the BullMQ driver
 * the persisted job record in the store provides cross-instance dedupe as
 * well; this map is a cheap first line of defense.
 */
declare global {
  var __ca_inflight: Map<string, string> | undefined;
}

export function inflight(): Map<string, string> {
  globalThis.__ca_inflight ??= new Map();
  return globalThis.__ca_inflight;
}

export function isInflight(slug: string): boolean {
  return inflight().has(slug);
}

export function markInflight(slug: string, jobId: string): void {
  inflight().set(slug, jobId);
}

export function clearInflight(slug: string): void {
  inflight().delete(slug);
}
