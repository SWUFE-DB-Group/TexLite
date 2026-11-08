import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { scopedStorageKey } from "../basePath";
import { errorMessage } from "../errors";
import type { AgentChange, AgentChangeFile } from "../../shared/agentProtocol";

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
/** Consecutive "soon" refreshes without a newer result, so a busy editor cannot loop. */
const MAX_SOON_REFRESHES = 3;

function storageKey(userId: string, projectId: string): string {
  return scopedStorageKey(`texlite-agent-review:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`);
}

function readReviewed(key: string): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeReviewed(key: string, reviewed: ReadonlySet<string>): void {
  try { window.localStorage.setItem(key, JSON.stringify([...reviewed])); }
  catch { /* Review marks are a convenience; private windows may refuse storage. */ }
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
  const soonCount = useRef(0);

  const load = useCallback((soon: boolean) => {
    // Only "soon" requests count towards their limit; any other refresh ends the run.
    if (!soon) soonCount.current = 0;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    void api<{ files: AgentChangeFile[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-changes`, { signal: current.signal })
      .then((result) => {
        if (current.signal.aborted) return;
        setFiles(result.files);
        setError("");
        // Forget marks for changes that no longer exist, so storage stays small.
        const present = new Set(result.files.flatMap((file) => file.changes.flatMap((change) => change.ids)));
        setReviewed((previous) => {
          const kept = new Set([...previous].filter((id) => present.has(id)));
          if (kept.size !== previous.size) writeReviewed(key, kept);
          return kept;
        });
      })
      .catch((reason: unknown) => {
        if (!current.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => { if (controller.current === current) setLoading(false); });
  }, [projectId, key]);
  const refresh = useCallback(() => load(false), [load]);

  const refreshSoon = useCallback(() => {
    if (soonTimer.current !== undefined || soonCount.current >= MAX_SOON_REFRESHES) return;
    soonCount.current += 1;
    soonTimer.current = window.setTimeout(() => { soonTimer.current = undefined; load(true); }, SOON_DELAY_MS);
  }, [load]);

  useEffect(() => {
    setReviewed(readReviewed(key));
    setFiles([]);
    refresh();
    const onTasks = () => refresh();
    window.addEventListener("texlite:agent-tasks", onTasks);
    return () => {
      window.removeEventListener("texlite:agent-tasks", onTasks);
      controller.current?.abort();
      window.clearTimeout(soonTimer.current);
      soonTimer.current = undefined;
    };
  }, [key, refresh]);

  useEffect(() => {
    if (!agentRunning) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, RUNNING_POLL_MS);
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
    const next = new Set(previous);
    for (const id of ids) next.add(id);
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
