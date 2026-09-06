import { afterEach, describe, expect, it, vi } from "vitest";
import { EditHistoryRetry } from "../src/server/editHistoryRetry.js";
import type { EditHistorySegmentInput } from "../src/server/editHistory.js";

const segment = (suffix: string): EditHistorySegmentInput => ({
  filePath: "main.tex", authorId: "alice", kind: "edit",
  beforeHash: `before-${suffix}`, afterHash: `after-${suffix}`,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  steps: []
});

describe("edit history retry", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps failed batches ordered and retries the combined batch once", () => {
    vi.useFakeTimers();
    const recorded: string[][] = [];
    let attempts = 0;
    const states: string[] = [];
    const retry = new EditHistoryRetry((_id, edits) => {
      if (++attempts === 1) throw new Error("temporary database failure");
      recorded.push(edits.map((edit) => edit.afterHash));
    }, () => true, (_id, state) => states.push(state));

    retry.save("project", [segment("one")]);
    retry.save("project", [segment("two")]);
    expect(attempts).toBe(1);
    vi.advanceTimersByTime(5_000);

    expect(recorded).toEqual([["after-one", "after-two"]]);
    expect(states.at(-1)).toBe("ok");
    retry.dispose();
  });

  it("attempts a large normal edit before applying retry-buffer limits", () => {
    const record = vi.fn();
    const states: string[] = [];
    const retry = new EditHistoryRetry(record, () => true, (_id, state) => states.push(state));
    const large = { ...segment("large"), afterHash: "x".repeat(4 * 1024 * 1024 + 1) };

    retry.save("project", [large]);

    expect(record).toHaveBeenCalledWith("project", [large]);
    expect(states).toEqual([]);
    retry.dispose();
  });

  it("stops after a bounded number of failed retries", () => {
    vi.useFakeTimers();
    const record = vi.fn(() => { throw new Error("database unavailable"); });
    const states: string[] = [];
    const retry = new EditHistoryRetry(record, () => true, (_id, state) => states.push(state));

    retry.save("project", [segment("one")]);
    vi.advanceTimersByTime(15_000);
    expect(record).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toBe("incomplete");
    vi.advanceTimersByTime(10_000);
    expect(record).toHaveBeenCalledTimes(4);
    retry.dispose();
  });

  it("never retries history explicitly cleared before its timer fires", () => {
    vi.useFakeTimers();
    const record = vi.fn(() => { throw new Error("database unavailable"); });
    const retry = new EditHistoryRetry(record, () => true, () => undefined);

    retry.save("project", [segment("one")]);
    retry.clear("project");
    vi.advanceTimersByTime(5_000);
    expect(record).toHaveBeenCalledTimes(1);
    retry.dispose();
  });

  it("drops a pending retry when its project was deleted", () => {
    vi.useFakeTimers();
    const record = vi.fn(() => { throw new Error("database unavailable"); });
    const states: string[] = [];
    const retry = new EditHistoryRetry(record, () => false, (_id, state) => states.push(state));

    retry.save("project", [segment("one")]);
    vi.advanceTimersByTime(5_000);

    expect(record).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("discarded");
    retry.dispose();
  });
});
