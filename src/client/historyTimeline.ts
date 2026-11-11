import type { HistoryVersion } from "./types";

/** Runs this long or longer of plain automatic saves are folded in the timeline. */
export const MIN_FOLDED_AUTOSAVES = 3;

export type HistoryTimelineItem =
  | { kind: "day"; key: string; date: string }
  | { kind: "version"; version: HistoryVersion }
  | { kind: "autosaves"; id: string; versions: HistoryVersion[] };

/** Plain automatic saves carry no name and no coding-agent changes. */
function foldable(version: HistoryVersion): boolean {
  return version.reason === "autosave" && !version.label && !version.hasAgent;
}

/**
 * Arrange a newest-first snapshot list for display: a header for each local
 * calendar day, and consecutive plain automatic saves of one day folded into
 * a single expandable item. Named, agent and other snapshots always stay
 * visible on their own. The versions themselves are not changed.
 */
export function historyTimeline(versions: readonly HistoryVersion[], dayKey: (createdAt: string) => string): HistoryTimelineItem[] {
  const items: HistoryTimelineItem[] = [];
  let day = "";
  let run: HistoryVersion[] = [];
  const flush = () => {
    // Keyed by the oldest member: new saves join a run at its newest end.
    if (run.length >= MIN_FOLDED_AUTOSAVES) items.push({ kind: "autosaves", id: run.at(-1)!.id, versions: run });
    else for (const version of run) items.push({ kind: "version", version });
    run = [];
  };
  for (const version of versions) {
    const key = dayKey(version.createdAt);
    if (key !== day) {
      flush();
      day = key;
      items.push({ kind: "day", key, date: version.createdAt });
    }
    if (foldable(version)) {
      run.push(version);
      continue;
    }
    flush();
    items.push({ kind: "version", version });
  }
  flush();
  return items;
}

/** Local calendar day of an ISO timestamp, for grouping. */
export function localDayKey(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : createdAt;
}

/**
 * Merge a freshly loaded first page into the loaded list. The page replaces
 * the versions it covers, which picks up new snapshots, coalesced autosaves
 * and removals, while older pages the user loaded stay. `nextCursor` is
 * `undefined` when the loaded older pages keep their own cursor.
 */
export function mergeNewestHistoryPage(
  loaded: readonly HistoryVersion[],
  fresh: readonly HistoryVersion[],
  freshNextCursor: string | null
): { versions: HistoryVersion[]; nextCursor: string | null | undefined } {
  // Without a next page the fresh page holds every version there is.
  if (!freshNextCursor || fresh.length === 0) return { versions: [...fresh], nextCursor: freshNextCursor };
  const freshIds = new Set(fresh.map((version) => version.id));
  const oldestFresh = fresh.at(-1)!.createdAt;
  const older = loaded.filter((version) => !freshIds.has(version.id) && version.createdAt <= oldestFresh);
  return { versions: [...fresh, ...older], nextCursor: older.length ? undefined : freshNextCursor };
}
