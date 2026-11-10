import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentAccess } from "../../shared/agentProtocol";

/** Notify badges after local mutations or terminal state messages; polling covers other tabs. */
export function notifyAgentTasksChanged(): void {
  window.dispatchEvent(new Event("texlite:agent-tasks"));
}

const noAccess: AgentAccess = { visible: false, activeCount: 0, enabled: false };
const POLL_INTERVAL_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 30_000;

export function useAgentAccess(scope: string, projectId?: string): AgentAccess {
  const [result, setResult] = useState<{ scope: string; projectId?: string; access: AgentAccess } | null>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    let lastRequestedAt = -Infinity;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      lastRequestedAt = Date.now();
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      const url = projectId ? `/api/agents/access?${new URLSearchParams({ project: projectId })}` : "/api/agents/access";
      void api<AgentAccess>(url, { signal: current.signal })
        .then((access) => { if (!disposed && !current.signal.aborted) setResult({ scope, projectId, access }); }).catch(() => undefined);
    };
    const refreshIfStale = () => {
      if (Date.now() - lastRequestedAt >= REFRESH_COOLDOWN_MS) load();
    };
    load();
    // Badges are reminders, not execution/permission checks. Task and policy
    // events remain immediate; infrequent polling catches changes in other tabs.
    const timer = window.setInterval(refreshIfStale, POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshIfStale);
    window.addEventListener("texlite:agents-policy", load);
    window.addEventListener("texlite:agent-tasks", load);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfStale);
      window.removeEventListener("texlite:agents-policy", load);
      window.removeEventListener("texlite:agent-tasks", load);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [scope, projectId]);
  return result?.scope === scope && result.projectId === projectId ? result.access : noAccess;
}
