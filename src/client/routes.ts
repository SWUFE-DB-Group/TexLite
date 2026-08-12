const projectRoutePattern = /^\/projects?\/([^/]+)\/?$/;

/** Return the canonical browser URL for a project. */
export function projectPath(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}`;
}

/** Read a project id from either the canonical route or its plural alias. */
export function projectIdFromPath(pathname: string): string | null {
  const match = projectRoutePattern.exec(pathname);
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]);
    return projectId && !projectId.includes("/") ? projectId : null;
  } catch {
    return null;
  }
}

export type TexLiteHistoryState =
  | { texliteRoute: "dashboard" }
  | { texliteRoute: "project"; projectId: string; fromDashboard: boolean };

export function isProjectHistoryState(value: unknown): value is Extract<TexLiteHistoryState, { texliteRoute: "project" }> {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<Extract<TexLiteHistoryState, { texliteRoute: "project" }>>;
  return state.texliteRoute === "project" && typeof state.projectId === "string" && typeof state.fromDashboard === "boolean";
}
