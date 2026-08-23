import { api } from "./api";
import type { Project } from "./types";
import type { LatestCompileResponse } from "./workspace/useProjectCompilation";

export const loadPdfPreview = () => import("./PdfPreview");

export interface WorkspacePreload {
  projectId: string;
  project: Promise<{ project: Project }>;
  latestCompile: Promise<LatestCompileResponse>;
}

const recentPreloads = new Map<string, { preload: WorkspacePreload; createdAt: number }>();
const PRELOAD_DEDUPLICATION_MS = 2_000;

/**
 * Start the project critical path as soon as App can see a project route.
 * This runs while /api/me is still in flight, removing the previous serial
 * project -> compile/latest -> PDF.js chain after a full page refresh.
 */
export function preloadWorkspace(projectId: string, options: { force?: boolean } = {}): WorkspacePreload {
  const now = Date.now();
  const existing = recentPreloads.get(projectId);
  if (!options.force && existing && now - existing.createdAt < PRELOAD_DEDUPLICATION_MS) return existing.preload;

  const project = api<{ project: Project }>(`/api/projects/${projectId}`, { suppressSessionExpired: true });
  const latestCompile = api<LatestCompileResponse>(`/api/projects/${projectId}/compile/latest`, { suppressSessionExpired: true });
  const pdfModule = loadPdfPreview();
  const preload = { projectId, project, latestCompile };
  recentPreloads.set(projectId, { preload, createdAt: now });
  // Attach a rejection observer immediately; the original promise is still
  // handed to the workspace so it can render the localized error later.
  void project.catch(() => undefined);

  // PDF.js and the retained document are both safe to prepare before the
  // workspace mounts. Failures remain handled by the normal workspace UI.
  void Promise.all([pdfModule, latestCompile])
    .then(([module, latest]) => {
      if (latest.pdfUrl) module.preloadPdf(latest.pdfUrl);
    })
    .catch(() => undefined);

  window.setTimeout(() => {
    if (recentPreloads.get(projectId)?.preload === preload) recentPreloads.delete(projectId);
  }, PRELOAD_DEDUPLICATION_MS);
  return preload;
}
