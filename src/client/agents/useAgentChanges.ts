import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { scopedStorageKey } from "../basePath";
import { errorMessage } from "../errors";
import type { AgentChange, AgentChangeFile } from "../../shared/agentProtocol";
import { isLocalStorageEvent, readStorageJson, writeStorageJson } from "../browserStorage";

/** A change still to review, with the file it belongs to. */
export interface PendingAgentChange extends AgentChange {
  path: string;
  sourceHash: string;
}

export interface AgentChangeReview {
  /** Unreviewed changes in file order, then source order. */
  pending: PendingAgentChange[];
  /** Unreviewed changes of one file, with the source they refer to. */
  forFile: (path: string) => { sourceHash: string; changes: AgentChange[] } | null;
  loading: boolean;
  error: string;
  refresh: () => void;
  /** Ask for a refresh shortly, for example when an editor holds unsaved text. */
  refreshSoon: () => void;
  markReviewed: (change: AgentChange) => void;
  markAllReviewed: () => void;
}

/** While one of the user's agent tasks runs, its new changes appear this quickly. */
const RUNNING_POLL_MS = 4_000;
const SOON_DELAY_MS = 2_000;
/** "Soon" refreshes allowed per window, so an editor that never matches cannot loop. */
const MAX_SOON_REFRESHES = 3;
const SOON_WINDOW_MS = 30_000;
/** Marks kept in this browser; beyond this the oldest ones with no current change go first. */
const MAX_REVIEW_MARKS = 2_000;

function storageKey(userId: string, projectId: string): string {
  return scopedStorageKey(`texlite-agent-review:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`);
}

function readReviewed(key: string): Set<string> {
  const value = readStorageJson(key);
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

/** Review marks are a convenience; a browser that refuses storage keeps them in memory only. */
function writeReviewed(key: string, reviewed: ReadonlySet<string>): void {
  writeStorageJson(key, [...reviewed]);
}

/**
 * Absence from one result does not mean a change is gone: a file can briefly
 * not match its edit chain. Ids are never reused, so a leftover mark is harmless
 * and only the size limit removes marks, never one for a change still listed.
 */
export function limitReviewed(reviewed: ReadonlySet<string>, present: ReadonlySet<string>, limit = MAX_REVIEW_MARKS): ReadonlySet<string> {
  let excess = reviewed.size - limit;
  if (excess <= 0) return reviewed;
  const kept = new Set<string>();
  for (const id of reviewed) {
    if (excess > 0 && !present.has(id)) excess -= 1;
    else kept.add(id);
  }
  return kept;
}

/**
 * The user's own coding-agent changes in a project, for manual review. The
 * server maps them to the current sources on each request; which ones were
 * reviewed is remembered only in this browser, per user and project.
 */
export function useAgentChanges(userId: string, projectId: string, agentRunning: boolean): AgentChangeReview {
  const key = storageKey(userId, projectId);
  const [files, setFiles] = useState<AgentChangeFile[]>([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => readReviewed(key));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const soonTimer = useRef<number | undefined>(undefined);
  const soonBudget = useRef({ windowStart: 0, used: 0 });
  const requesting = useRef(false);

  const refresh = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    requesting.current = true;
    setLoading(true);
    void api<{ files: AgentChangeFile[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-changes`, { signal: current.signal })
      .then((result) => {
        if (current.signal.aborted) return;
        setFiles(result.files);
        setError("");
        const present = new Set(result.files.flatMap((file) => file.changes.flatMap((change) => change.ids)));
        setReviewed((previous) => {
          const kept = limitReviewed(previous, present);
          if (kept !== previous) writeReviewed(key, kept);
          return kept;
        });
      })
      .catch((reason: unknown) => {
        if (!current.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => { if (controller.current === current) { requesting.current = false; setLoading(false); } });
  }, [projectId, key]);

  const refreshSoon = useCallback(() => {
    if (soonTimer.current !== undefined) return;
    const budget = soonBudget.current;
    const now = Date.now();
    if (now - budget.windowStart >= SOON_WINDOW_MS) { budget.windowStart = now; budget.used = 0; }
    if (budget.used >= MAX_SOON_REFRESHES) return;
    budget.used += 1;
    soonTimer.current = window.setTimeout(() => { soonTimer.current = undefined; refresh(); }, SOON_DELAY_MS);
  }, [refresh]);

  useEffect(() => {
    setReviewed(readReviewed(key));
    setFiles([]);
    refresh();
    const onTasks = () => refresh();
    window.addEventListener("texlite:agent-tasks", onTasks);
    // Another tab of this browser reviewed something.
    const onStorage = (event: StorageEvent) => {
      if (isLocalStorageEvent(event) && (event.key === key || event.key === null)) setReviewed(readReviewed(key));
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("texlite:agent-tasks", onTasks);
      window.removeEventListener("storage", onStorage);
      controller.current?.abort();
      window.clearTimeout(soonTimer.current);
      soonTimer.current = undefined;
    };
  }, [key, refresh]);

  useEffect(() => {
    if (!agentRunning) return;
    // A slow response is left to finish; replacing it each time would never show a result.
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden" && !requesting.current) refresh(); }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [agentRunning, refresh]);

  const unreviewed = useCallback((change: AgentChange) => change.ids.some((id) => !reviewed.has(id)), [reviewed]);
  const pending = useMemo(() => files.flatMap((file) => file.changes.filter(unreviewed)
    .map((change) => ({ ...change, path: file.path, sourceHash: file.sourceHash }))), [files, unreviewed]);

  const forFile = useCallback((path: string) => {
    const file = files.find((candidate) => candidate.path === path);
    return file ? { sourceHash: file.sourceHash, changes: file.changes.filter(unreviewed) } : null;
  }, [files, unreviewed]);

  const mark = useCallback((ids: readonly string[]) => setReviewed((previous) => {
    const next = new Set([...readReviewed(key), ...previous, ...ids]);
    writeReviewed(key, next);
    return next;
  }), [key]);

  return {
    pending,
    forFile,
    loading,
    error,
    refresh,
    refreshSoon,
    markReviewed: useCallback((change: AgentChange) => mark(change.ids), [mark]),
    markAllReviewed: useCallback(() => mark(files.flatMap((file) => file.changes.flatMap((change) => change.ids))), [mark, files])
  };
}
