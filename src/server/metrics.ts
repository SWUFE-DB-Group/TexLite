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
