import { useEffect, useState } from "react";
import type { WorkspaceLayout } from "./types";

function storageKey(userId: string, projectId: string): string {
  return `texlite.workspaceLayout:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
}

function loadWorkspaceLayout(userId: string, projectId: string): WorkspaceLayout {
  try {
    const saved = window.localStorage.getItem(storageKey(userId, projectId));
    if (saved === "editor-pdf" || saved === "editor-only" || saved === "pdf-only") return saved;
  } catch { /* Browser storage can be unavailable in private/restricted contexts. */ }
  return "editor-pdf";
}

export function useWorkspaceLayout(userId: string, projectId: string) {
  const [workspaceLayout, setWorkspaceLayoutState] = useState<WorkspaceLayout>(
    () => loadWorkspaceLayout(userId, projectId)
  );

  useEffect(() => {
    setWorkspaceLayoutState(loadWorkspaceLayout(userId, projectId));
  }, [userId, projectId]);

  const setWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayoutState(next);
    try {
      window.localStorage.setItem(storageKey(userId, projectId), next);
    } catch { /* Keep the in-memory choice. */ }
  };

  return { workspaceLayout, setWorkspaceLayout };
}
