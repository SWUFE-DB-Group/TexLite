import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryRetentionScheduler } from "../src/server/historyRetention.js";

describe("history retention scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces multiple autosaves for one project into one maintenance run", () => {
    vi.useFakeTimers();
    const enforceRetention = vi.fn();
    const scheduler = new HistoryRetentionScheduler({ enforceRetention }, { delayMs: 50 });

    scheduler.schedule("project-1");
    scheduler.schedule("project-1");
    scheduler.schedule("project-2");
    vi.advanceTimersByTime(49);
    expect(enforceRetention).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(enforceRetention).toHaveBeenCalledTimes(2);
    expect(enforceRetention).toHaveBeenCalledWith("project-1");
    expect(enforceRetention).toHaveBeenCalledWith("project-2");
  });

  it("cancels pending maintenance during shutdown", () => {
    vi.useFakeTimers();
    const enforceRetention = vi.fn();
    const scheduler = new HistoryRetentionScheduler({ enforceRetention }, { delayMs: 50 });

    scheduler.schedule("project-1");
    scheduler.dispose();
    vi.advanceTimersByTime(50);

    expect(enforceRetention).not.toHaveBeenCalled();
  });
});
