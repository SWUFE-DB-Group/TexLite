import { useEffect, useState } from "react";
import type { WorkspaceLayout } from "./types";
import { scopedStorageKey } from "../basePath";
import { usePhoneWorkspace } from "./usePhoneWorkspace";
import { readStorage, writeStorage } from "../browserStorage";

function storageKey(userId: string, projectId: string, phone: boolean): string {
  return scopedStorageKey(`texlite.workspaceLayout:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}${phone ? ":phone" : ""}`);
}

function loadWorkspaceLayout(userId: string, projectId: string, phone: boolean): WorkspaceLayout {
  const saved = readStorage(storageKey(userId, projectId, phone));
  if (saved === "editor-only" || saved === "pdf-only" || !phone && saved === "editor-pdf") return saved;
  return phone ? "editor-only" : "editor-pdf";
}

export function useWorkspaceLayout(userId: string, projectId: string) {
  const phone = usePhoneWorkspace();
  const [workspaceLayout, setWorkspaceLayoutState] = useState<WorkspaceLayout>(
    () => loadWorkspaceLayout(userId, projectId, phone)
  );

  useEffect(() => {
    setWorkspaceLayoutState(loadWorkspaceLayout(userId, projectId, phone));
  }, [userId, projectId, phone]);

  const setWorkspaceLayout = (next: WorkspaceLayout) => {
    const layout = phone && next === "editor-pdf" ? "editor-only" : next;
    setWorkspaceLayoutState(layout);
    writeStorage(storageKey(userId, projectId, phone), layout);
  };

  return { workspaceLayout: phone && workspaceLayout === "editor-pdf" ? "editor-only" : workspaceLayout, setWorkspaceLayout, phone };
}
