import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentCatalog, AgentTask, AgentTaskPage } from "../../shared/agentProtocol";
import { AGENT_TASK_PAGE_SIZE } from "../../shared/agentProtocol";
import { errorMessage } from "../errors";
import { notifyAgentTasksChanged } from "./useAgentAccess";

export function useAgentTasks(projectId: string) {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [result, setResult] = useState<AgentTaskPage>({ tasks: [], page: 1, pageSize: AGENT_TASK_PAGE_SIZE, total: 0 });
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentCatalog>("/api/agents", { signal: controller.signal }).then(setCatalog).catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [projectId, refresh]);
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    const load = () => {
      if (document.visibilityState === "hidden" || pending.current) return;
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      const requestedRevision = revision.current;
      const params = new URLSearchParams({ project: projectId, page: String(page) });
      void api<AgentTaskPage>(`/api/agent-tasks?${params}`, { signal: current.signal }).then((value) => {
        if (disposed || current.signal.aborted || requestedRevision !== revision.current) return;
        setResult(value);
        setSelectedId((id) => value.tasks.some((task) => task.id === id) ? id : value.tasks[0]?.id ?? "");
      }).catch((failure) => { if (!disposed && !current.signal.aborted && requestedRevision === revision.current) setError(errorMessage(failure)); });
    };
    load();
    const timer = window.setInterval(load, 5_000);
    window.addEventListener("focus", load);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [projectId, page, refresh]);
  const refreshTasks = useCallback(() => setRefresh((value) => value + 1), []);
  const acceptTask = useCallback((task: AgentTask) => {
    // A delayed polling response cannot replace a newer WebSocket/mutation result.
    revision.current++;
    setResult((current) => ({ ...current,
      activeTaskId: ["starting", "running", "stopping"].includes(task.state) ? task.id : current.activeTaskId === task.id ? null : current.activeTaskId,
      tasks: current.tasks.some((entry) => entry.id === task.id) ? current.tasks.map((entry) => entry.id === task.id ? task : entry) : [task, ...current.tasks],
      total: current.tasks.some((entry) => entry.id === task.id) ? current.total : current.total + 1 }));
    if (!pending.current) notifyAgentTasksChanged();
  }, []);
  const mutate = async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true); setError("");
    try { return await operation(); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { pending.current = false; notifyAgentTasksChanged(); if (mounted.current) { setBusy(false); refreshTasks(); } }
  };
  return { catalog, result, page, setPage, selectedId, setSelectedId,
    selected: result.tasks.find((task) => task.id === selectedId) ?? null,
    error, setError, busy, mutate, acceptTask };
}
