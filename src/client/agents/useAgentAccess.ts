import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentAccess } from "../../shared/agentProtocol";

/** Notify badges after local mutations or terminal state messages; polling covers other tabs. */
export function notifyAgentTasksChanged(): void {
  window.dispatchEvent(new Event("texlite:agent-tasks"));
}

const noAccess: AgentAccess = { visible: false, activeCount: 0 };

export function useAgentAccess(scope: string, projectId?: string): AgentAccess {
  const [result, setResult] = useState<{ scope: string; projectId?: string; access: AgentAccess } | null>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      const url = projectId ? `/api/agents/access?${new URLSearchParams({ project: projectId })}` : "/api/agents/access";
      void api<AgentAccess>(url, { signal: current.signal })
        .then((access) => { if (!disposed && !current.signal.aborted) setResult({ scope, projectId, access }); }).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5_000);
    window.addEventListener("focus", load);
    window.addEventListener("texlite:agents-policy", load);
    window.addEventListener("texlite:agent-tasks", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener("texlite:agents-policy", load);
      window.removeEventListener("texlite:agent-tasks", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [scope, projectId]);
  return result?.scope === scope && result.projectId === projectId ? result.access : noAccess;
}
