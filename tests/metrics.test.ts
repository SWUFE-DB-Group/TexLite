import { describe, expect, it, vi } from "vitest";
import { EVENT_LOOP_DELAY_RESOLUTION_MS, eventLoopDelaySummary } from "../src/server/metrics";

describe("event-loop scheduling lag", () => {
  const baselineNs = EVENT_LOOP_DELAY_RESOLUTION_MS * 1_000_000;

  it("removes the shared sampling baseline before rounding each statistic", () => {
    const percentile = vi.fn((value: number) => baselineNs + (value === 50 ? 87_000 : 169_000));
    expect(eventLoopDelaySummary({ count: 29, percentile, max: baselineNs + 532_000 })).toEqual({
      p50Ms: 0.1, p95Ms: 0.2, maxMs: 0.5
    });
    expect(percentile.mock.calls).toEqual([[50], [95]]);
  });

  it("preserves genuine stalls rather than hiding them with the baseline", () => {
    expect(eventLoopDelaySummary({ count: 10, percentile: () => baselineNs, max: baselineNs + 80_532_000 })).toEqual({
      p50Ms: 0, p95Ms: 0, maxMs: 80.5
    });
  });

  it("clamps below-baseline timer jitter without producing negative values", () => {
    expect(eventLoopDelaySummary({ count: 10, percentile: () => baselineNs - 500_000, max: baselineNs })).toEqual({
      p50Ms: 0, p95Ms: 0, maxMs: 0
    });
  });

  it("does not invent zero-lag measurements before the first sample", () => {
    const percentile = vi.fn();
    expect(eventLoopDelaySummary({ count: 0, percentile, max: 0 })).toEqual({ p50Ms: null, p95Ms: null, maxMs: null });
    expect(percentile).not.toHaveBeenCalled();
  });

  it("handles nonfinite values and does not reset the histogram when read", () => {
    const histogram = { count: 3, percentile: (value: number) => value === 50 ? NaN : baselineNs, max: Infinity, reset: vi.fn() };
    expect(eventLoopDelaySummary(histogram)).toEqual({ p50Ms: null, p95Ms: 0, maxMs: null });
    eventLoopDelaySummary(histogram);
    expect(histogram.reset).not.toHaveBeenCalled();
  });
});
