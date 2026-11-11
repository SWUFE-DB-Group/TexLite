import { describe, expect, it } from "vitest";
import { historyTimeline, mergeNewestHistoryPage } from "../src/client/historyTimeline";
import type { HistoryVersion } from "../src/client/types";

const version = (id: string, createdAt: string, extra: Partial<HistoryVersion> = {}): HistoryVersion => ({
  id, snapshotHash: id, reason: "autosave", label: null, createdAt, author: null, hasAgent: false,
  changedPaths: ["main.tex"], fileCount: 1, totalSize: 1, ...extra
});
const day = (createdAt: string) => createdAt.slice(0, 10);
const shape = (versions: HistoryVersion[]) => historyTimeline(versions, day).map((item) =>
  item.kind === "day" ? `day ${item.key}` : item.kind === "version" ? item.version.id : `run ${item.versions.map((entry) => entry.id).join(",")}`);

describe("snapshot timeline grouping", () => {
  it("adds day headers and folds runs of three or more plain automatic saves", () => {
    expect(shape([
      version("a5", "2026-01-02T12:00:00Z"), version("a4", "2026-01-02T11:58:00Z"), version("a3", "2026-01-02T11:56:00Z"),
      version("file", "2026-01-02T11:00:00Z", { reason: "file" }),
      version("a2", "2026-01-02T10:02:00Z"), version("a1", "2026-01-02T10:00:00Z"),
      version("old", "2026-01-01T09:00:00Z")
    ])).toEqual(["day 2026-01-02", "run a5,a4,a3", "file", "a2", "a1", "day 2026-01-01", "old"]);
  });

  it("keeps named and agent snapshots visible and never folds across days", () => {
    expect(shape([
      version("a4", "2026-01-02T00:04:00Z"), version("named", "2026-01-02T00:03:00Z", { label: "Draft" }),
      version("a3", "2026-01-02T00:02:00Z"), version("agent", "2026-01-02T00:01:30Z", { hasAgent: true }),
      version("a2", "2026-01-02T00:01:00Z"), version("a1", "2026-01-01T23:59:00Z"), version("a0", "2026-01-01T23:58:00Z")
    ])).toEqual(["day 2026-01-02", "a4", "named", "a3", "agent", "a2", "day 2026-01-01", "a1", "a0"]);
  });
});

describe("refreshing the newest snapshot page", () => {
  const ids = (versions: HistoryVersion[]) => versions.map((entry) => entry.id);
  const loaded = [version("c", "2026-01-03T00:00:00Z"), version("b", "2026-01-02T00:00:00Z"),
    version("gone", "2026-01-01T12:00:00Z"), version("a", "2026-01-01T00:00:00Z"), version("older", "2025-12-31T00:00:00Z")];

  it("adds new and updated versions, drops removed ones it covers, and keeps loaded older pages", () => {
    const fresh = [version("d", "2026-01-04T00:00:00Z"), version("c", "2026-01-03T00:00:00Z", { snapshotHash: "grown" }),
      version("b", "2026-01-02T00:00:00Z"), version("a", "2026-01-01T00:00:00Z")];
    const merged = mergeNewestHistoryPage(loaded, fresh, "cursor-after-a");
    expect(ids(merged.versions)).toEqual(["d", "c", "b", "a", "older"]);
    expect(merged.versions[1]!.snapshotHash).toBe("grown");
    // The older page keeps the cursor it was loaded with.
    expect(merged.nextCursor).toBeUndefined();
  });

  it("takes the fresh cursor when no older page was loaded, and the fresh list when nothing is older", () => {
    const fresh = [version("d", "2026-01-04T00:00:00Z"), version("c", "2026-01-03T00:00:00Z")];
    expect(mergeNewestHistoryPage(loaded.slice(0, 1), fresh, "next")).toEqual({ versions: fresh, nextCursor: "next" });
    expect(mergeNewestHistoryPage(loaded, fresh, null)).toEqual({ versions: fresh, nextCursor: null });
    expect(mergeNewestHistoryPage(loaded, [], null)).toEqual({ versions: [], nextCursor: null });
  });
});
