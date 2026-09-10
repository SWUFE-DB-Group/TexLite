import { appPath, currentBasePath, stripAppBasePath } from "./basePath";

const projectRoutePattern = /^\/projects?\/([^/]+)\/?$/;

/** Return the canonical browser URL for a project. */
export function projectPath(projectId: string, mentionId?: string | null, basePath = currentBasePath()): string {
  const path = appPath(`/project/${encodeURIComponent(projectId)}`, basePath);
  return mentionId ? `${path}?${new URLSearchParams({ mention: mentionId }).toString()}` : path;
}

/** Read one optional personal mention target from a project route. */
export function mentionIdFromSearch(search: string): string | null {
  const mentionId = new URLSearchParams(search).get("mention");
  return mentionId && mentionId.length <= 128 ? mentionId : null;
}

/** Read a project id from either the canonical route or its plural alias. */
export function projectIdFromPath(pathname: string, basePath = currentBasePath()): string | null {
  const relativePath = stripAppBasePath(pathname, basePath);
  const match = relativePath ? projectRoutePattern.exec(relativePath) : null;
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]);
    return projectId && !projectId.includes("/") ? projectId : null;
  } catch {
    return null;
  }
}

/** Build the login URL that remembers one validated project destination. */
export function projectLoginPath(projectId: string, mentionId?: string | null, basePath = currentBasePath()): string {
  const query = new URLSearchParams({ return: projectPath(projectId, mentionId, basePath) });
  return appPath("/", basePath) + "?" + query.toString();
}

/** Accept only an internal project route from the login return parameter. */
function projectReturnUrl(search: string): URL | null {
  const value = new URLSearchParams(search).get("return");
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    return new URL(value, "https://texlite.invalid");
  } catch {
    return null;
  }
}

export function projectIdFromReturn(search: string, basePath = currentBasePath()): string | null {
  const url = projectReturnUrl(search);
  return url ? projectIdFromPath(url.pathname, basePath) : null;
}

export function mentionIdFromReturn(search: string, basePath = currentBasePath()): string | null {
  const url = projectReturnUrl(search);
  return url && projectIdFromPath(url.pathname, basePath) ? mentionIdFromSearch(url.search) : null;
}

export type TexLiteHistoryState =
  | { texliteRoute: "dashboard" }
  | { texliteRoute: "project"; projectId: string; fromDashboard: boolean };

export function isProjectHistoryState(value: unknown): value is Extract<TexLiteHistoryState, { texliteRoute: "project" }> {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<Extract<TexLiteHistoryState, { texliteRoute: "project" }>>;
  return state.texliteRoute === "project" && typeof state.projectId === "string" && typeof state.fromDashboard === "boolean";
}
