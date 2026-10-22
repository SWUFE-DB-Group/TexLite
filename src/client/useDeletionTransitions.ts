import { useCallback, useEffect, useState } from "react";

export const PROJECT_DELETION_DURATION_MS = 250;
export const FILE_DELETION_DURATION_MS = 180;

export interface DeletionEntry<T> {
  item: T;
  removeAt: number | null;
}

interface DeletionOptions<T> {
  scopeKey: string;
  deletedKey: string | null;
  keyOf: (item: T) => string;
  contains?: (deletedKey: string, itemKey: string) => boolean;
  duration: number;
}

/** Keep only confirmed deletions temporarily; ordinary filtering and moves stay immediate. */
export function reconcileDeletionEntries<T>(
  previous: readonly DeletionEntry<T>[], items: readonly T[],
  options: Omit<DeletionOptions<T>, "scopeKey">, now: number
): DeletionEntry<T>[] {
  const { deletedKey, keyOf, contains = (root, key) => root === key, duration } = options;
  const entries: DeletionEntry<T>[] = items.map((item) => ({ item, removeAt: null }));
  const liveKeys = new Set(items.map(keyOf));
  previous.forEach((entry, index) => {
    const key = keyOf(entry.item);
    if (liveKeys.has(key)) return;
    if (entry.removeAt !== null ? entry.removeAt <= now : !deletedKey || !contains(deletedKey, key)) return;
    entries.splice(Math.min(index, entries.length), 0, {
      item: entry.item, removeAt: entry.removeAt ?? now + duration + 50
    });
  });
  return entries;
}

/** Canonical data changes immediately; only the rendered list retains inert exit rows. */
export function useDeletionTransitions<T>(items: readonly T[], options: DeletionOptions<T>) {
  const { scopeKey, deletedKey, keyOf } = options;
  const [state, setState] = useState(() => ({
    items, scopeKey, deletedKey, entries: items.map((item) => ({ item, removeAt: null } as DeletionEntry<T>))
  }));
  if (state.items !== items || state.scopeKey !== scopeKey || state.deletedKey !== deletedKey) {
    const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setState({ items, scopeKey, deletedKey, entries: state.scopeKey !== scopeKey || reduceMotion
      ? items.map((item) => ({ item, removeAt: null }))
      : reconcileDeletionEntries(state.entries, items, options, Date.now()) });
  }
  const finishExit = useCallback((key: string) => {
    setState((current) => ({ ...current, entries: current.entries.filter((entry) => keyOf(entry.item) !== key || entry.removeAt === null) }));
  }, [keyOf]);
  useEffect(() => {
    const deadlines = state.entries.flatMap((entry) => entry.removeAt === null ? [] : [entry.removeAt]);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setState((current) => ({ ...current, entries: current.entries.filter((entry) => entry.removeAt === null || entry.removeAt > now) }));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.entries]);
  return { entries: state.entries, finishExit };
}

/** Read the natural row height before its first animated frame; no wrapper affects layout. */
export function captureDeletionHeight(element: HTMLElement | null): void {
  if (element) element.style.setProperty("--deletion-height", `${element.getBoundingClientRect().height}px`);
}
