import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import { isCollaborativeTextFile, maxCollaborativeFileBytes } from "../collaboration.js";
import type { DatabaseConnection } from "../db.js";
import { hashText, type ProjectEditHistoryService } from "../editHistory.js";
import type { HistoryReason, ProjectHistoryService } from "../history.js";
import { HISTORY_RETENTION_DELAY_MS } from "../historyRetention.js";
import { resolveSourcePath, safeRelativePath } from "../files.js";
import { apiError, httpError } from "../http.js";
import { MAX_TEXT_PREVIEW_BYTES } from "../limits.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject, canEdit } from "../projects.js";
import {
  commentsSummaryForProject,
  projectJson,
  projectTextSnapshot,
  reanchorProjectSnapshot,
  requireEditableProject,
  requireProjectOwnerPermission,
  tagsForProject,
  text,
  touchProject
} from "./projectShared.js";

interface ProjectHistoryRouteContext {
  config: Config;
  db: DatabaseConnection;
  history: ProjectHistoryService;
  editHistory: ProjectEditHistoryService;
  clearPendingEdits: (id: string) => void;
  scheduleHistoryRetention: (id: string) => void;
  projectMutations: ProjectMutationCoordinator;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

/** Register retained project version listing, inspection, restoration, and cleanup routes. */
export function registerProjectHistoryRoutes(app: FastifyInstance, context: ProjectHistoryRouteContext): void {
  const { config, db, history, editHistory, projectMutations, recordHistory } = context;

  app.get("/api/projects/:id/edit-history/stats", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (accessibleProject(db, id, user)?.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    return editHistory.stats(id);
  });

  app.delete("/api/projects/:id/edit-history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (accessibleProject(db, id, user)?.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    return await projectMutations.runWrite(id, () => {
      editHistory.clear(id);
      context.clearPendingEdits(id);
      return editHistory.stats(id);
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });

  /**
   * Return only author-attributed edits that can be mapped to the caller's
   * current selection. Recovery snapshots live under /history and deliberately
   * remain a separate concern.
   */
  app.get("/api/projects/:id/edit-history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { path?: string; start?: string; end?: string; limit?: string; sourceHash?: string };
    if (typeof query.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(query.sourceHash)) return apiError(reply, 400, "REQUEST_INVALID");
    let filePath: string;
    try { filePath = safeRelativePath(query.path ?? ""); }
    catch { return apiError(reply, 400, "REQUEST_INVALID"); }
    if (!isCollaborativeTextFile(filePath)) return apiError(reply, 400, "REQUEST_INVALID");
    const start = parseOffset(query.start);
    const end = parseOffset(query.end);
    if (start === null || end === null || start === end) return apiError(reply, 400, "REQUEST_INVALID");
    const requestedLimit = parseOffset(query.limit);
    return await projectMutations.runConsistentRead(id, () => {
      const source = resolveSourcePath(config, id, filePath);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return apiError(reply, 404, "FILE_NOT_FOUND", { path: filePath });
      if (fs.statSync(source).size > maxCollaborativeFileBytes(config)) return apiError(reply, 413, "FILE_TOO_LARGE", { path: filePath });
      const content = fs.readFileSync(source, "utf8");
      if (hashText(content) !== query.sourceHash) return apiError(reply, 409, "SELECTION_HISTORY_SOURCE_CHANGED");
      if (start > end || end > content.length) return apiError(reply, 400, "REQUEST_INVALID");
      return editHistory.selectionHistory(id, filePath, content, start, end, requestedLimit ?? undefined);
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  app.get("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { limit?: unknown; before?: unknown };
    if (query.before !== undefined && typeof query.before !== "string") return apiError(reply, 400, "REQUEST_INVALID");
    const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 100;
    const page = history.listPage(id, Number.isFinite(limit) ? limit : 100, query.before);
    return {
      versions: page.versions,
      nextCursor: page.nextCursor,
      stats: project.permission === "owner" ? history.stats(id) : null
    };
  });

  app.get("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const version = history.version(versionId, id);
    const manifest = history.manifest(id, versionId);
    if (!version || !manifest) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND");
    return {
      version,
      settings: manifest.settings,
      files: Object.entries(manifest.files).map(([filePath, file]) => ({ path: filePath, size: file.size })).sort((left, right) => left.path.localeCompare(right.path))
    };
  });

  app.get("/api/projects/:id/history/:versionId/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { path?: string; against?: string };
    const filePath = safeRelativePath(query.path ?? "");
    return await projectMutations.runConsistentRead(id, () => {
      const historical = history.readTextFile(id, versionId, filePath);
      if (historical === null) return apiError(reply, 415, "HISTORY_FILE_PREVIEW_UNSUPPORTED", { path: filePath });
      let comparison = "";
      const previousVersion = query.against === "__previous__" ? history.previousVersion(id, versionId) : null;
      const against = query.against === "__previous__" ? previousVersion?.id ?? "__none__" : query.against;
      if (query.against) {
        comparison = history.readTextFile(id, against!, filePath) ?? "";
      } else {
        const current = resolveSourcePath(config, id, filePath);
        if (fs.existsSync(current) && fs.statSync(current).isFile() && fs.statSync(current).size <= MAX_TEXT_PREVIEW_BYTES) {
          comparison = fs.readFileSync(current, "utf8");
        }
      }
      return { path: filePath, historical, comparison, against: against ?? "current", previousVersion };
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  app.patch("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { label?: unknown; snapshotHash?: unknown } | undefined;
    if (body?.snapshotHash !== undefined && (typeof body.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotHash))) {
      return apiError(reply, 400, "REQUEST_INVALID");
    }
    const snapshotHash = typeof body?.snapshotHash === "string" ? body.snapshotHash : undefined;
    history.assertSnapshotHash(id, versionId, snapshotHash);
    const label = body?.label === null || body?.label === "" ? null : text(body?.label, 80);
    const version = history.setLabel(id, versionId, label);
    if (!version) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND");
    if (!label) context.scheduleHistoryRetention(id);
    return { version, retentionScheduled: !label, retentionRefreshAfterMs: !label ? HISTORY_RETENTION_DELAY_MS + 1_000 : 0,
      stats: project.permission === "owner" ? history.stats(id) : null };
  });

  app.delete("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    return await projectMutations.runWrite(id, () => {
      if (!history.deleteVersion(id, versionId)) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND");
      return { ok: true, stats: history.stats(id) };
    }, { preflight: () => {
      requireProjectOwnerPermission(db, id, user);
      if (!history.version(versionId, id)) {
        throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
      }
    } });
  });

  app.delete("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    return await projectMutations.runWrite(id, () => {
      history.clear(id);
      return { ok: true, stats: history.stats(id) };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });

  app.post("/api/projects/:id/history/:versionId/restore", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { path?: unknown; snapshotHash?: unknown } | undefined;
    const filePath = typeof body?.path === "string" ? safeRelativePath(body.path) : undefined;
    // Current clients bind a restore to the snapshot they displayed. Accept
    // an omitted fingerprint only for already-open clients during an upgrade.
    if (body?.snapshotHash !== undefined && (typeof body.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotHash))) {
      return apiError(reply, 400, "REQUEST_INVALID");
    }
    const snapshotHash = typeof body?.snapshotHash === "string" ? body.snapshotHash : undefined;
    return await projectMutations.runExclusive(id, "history restore", () => {
      const currentProject = requireEditableProject(db, id, user);
      history.assertSnapshotHash(id, versionId, snapshotHash);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      const restored = history.restore(id, versionId, filePath);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "restore", filePath ? [filePath] : undefined);
      return {
        ok: true,
        restoredPaths: restored.restoredPaths,
        project: projectJson(
          accessibleProject(db, id, user) ?? currentProject,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => {
      requireEditableProject(db, id, user);
      if (!history.version(versionId, id)) {
        throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
      }
      history.validateRestoreTarget(id, versionId, filePath);
    } });
  });
}

function parseOffset(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
