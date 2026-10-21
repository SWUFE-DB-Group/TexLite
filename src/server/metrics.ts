import type { IntervalHistogram } from "node:perf_hooks";

export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

/** Interval histograms include the sampling period. Expose estimated excess
 * scheduling delay, not the raw interval, and preserve the cumulative window.
 */
export function eventLoopDelaySummary(histogram: Pick<IntervalHistogram, "count" | "percentile" | "max">): {
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
} {
  if (histogram.count === 0) return { p50Ms: null, p95Ms: null, maxMs: null };
  const lagMs = (nanoseconds: number): number | null => Number.isFinite(nanoseconds)
    ? Math.round(Math.max(0, nanoseconds / 1_000_000 - EVENT_LOOP_DELAY_RESOLUTION_MS) * 10) / 10
    : null;
  return { p50Ms: lagMs(histogram.percentile(50)), p95Ms: lagMs(histogram.percentile(95)), maxMs: lagMs(histogram.max) };
}

export interface MetricSummary {
  count: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

/** A deliberately small in-memory window; metrics never contain source text. */
export class MetricRegistry {
  private readonly samples = new Map<string, number[]>();

  constructor(private readonly capacity = 200) {}

  record(name: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const values = this.samples.get(name) ?? [];
    values.push(Math.round(milliseconds * 10) / 10);
    if (values.length > this.capacity) values.splice(0, values.length - this.capacity);
    this.samples.set(name, values);
  }

  summaries(): Record<string, MetricSummary> {
    return Object.fromEntries([...this.samples].map(([name, values]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return [name, {
        count: values.length,
        last: values.at(-1) ?? 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1) ?? 0
      }];
    }));
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}
