/**
 * Lightweight in-process metrics. Exposed in Prometheus text format at
 * /api/metrics. Good enough for a single exporter; swap for prom-client or
 * OpenTelemetry if this service grows serious dashboards.
 */

interface HistogramState {
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

const DEFAULT_BUCKETS = [50, 100, 250, 300, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000];

const counters = new Map<string, number>();
const histograms = new Map<string, HistogramState>();

export function incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  const key = `${name}|${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",")}`;
  counters.set(key, (counters.get(key) ?? 0) + value);
}

export function observeHistogram(name: string, valueMs: number): void {
  let h = histograms.get(name);
  if (!h) {
    h = { buckets: new Map(DEFAULT_BUCKETS.map((b) => [b, 0])), count: 0, sum: 0 };
    histograms.set(name, h);
  }
  h.count += 1;
  h.sum += valueMs;
  for (const [le, n] of h.buckets) {
    if (valueMs <= le) h.buckets.set(le, n + 1);
  }
}

/** Rough p95 from observed histogram buckets. */
export function histogramP95(name: string): number | null {
  const h = histograms.get(name);
  if (!h || h.count === 0) return null;
  const target = h.count * 0.95;
  let cumulative = 0;
  for (const le of [...h.buckets.keys()].sort((a, b) => a - b)) {
    cumulative = h.buckets.get(le) ?? 0;
    if (cumulative >= target) return le;
  }
  return null;
}


export function renderPrometheus(): string {
  const lines: string[] = [];
  const byMetric = new Map<string, Array<[string, number]>>();
  for (const [key, value] of counters) {
    const sep = key.indexOf("|");
    const name = sep === -1 ? key : key.slice(0, sep);
    const labelPart = sep === -1 ? "" : key.slice(sep + 1);
    const list = byMetric.get(name) ?? [];
    list.push([labelPart, value]);
    byMetric.set(name, list);
  }
  for (const [name, list] of byMetric) {
    lines.push(`# TYPE ${name} counter`);
    for (const [labelPart, value] of list) {
      lines.push(
        labelPart ? `${name}{${labelPart}} ${value}` : `${name} ${value}`
      );
    }
  }
  for (const [name, h] of histograms) {
    lines.push(`# TYPE ${name} histogram`);
    let cumulative = 0;
    for (const le of [...h.buckets.keys()].sort((a, b) => a - b)) {
      cumulative = h.buckets.get(le) ?? 0;
      lines.push(`${name}_bucket{le="${le}"} ${cumulative}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum ${h.sum}`);
    lines.push(`${name}_count ${h.count}`);
  }
  return `${lines.join("\n")}\n`;
}
