import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { HistoryReason, ProjectHistoryService } from "../history.js";
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
  projectMutations: ProjectMutationCoordinator;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

/** Register retained project version listing, inspection, restoration, and cleanup routes. */
export function registerProjectHistoryRoutes(app: FastifyInstance, context: ProjectHistoryRouteContext): void {
  const { config, db, history, projectMutations, recordHistory } = context;

  app.get("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const { limit: limitInput } = request.query as { limit?: string };
    const limit = Number.parseInt(limitInput ?? "100", 10);
    return {
      versions: history.list(id, Number.isFinite(limit) ? limit : 100),
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
      if (query.against) {
        comparison = history.readTextFile(id, query.against, filePath) ?? "";
      } else {
        const current = resolveSourcePath(config, id, filePath);
        if (fs.existsSync(current) && fs.statSync(current).isFile() && fs.statSync(current).size <= MAX_TEXT_PREVIEW_BYTES) {
          comparison = fs.readFileSync(current, "utf8");
        }
      }
      return { path: filePath, historical, comparison, against: query.against ?? "current" };
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
    const body = request.body as { label?: unknown };
    const label = body.label === null || body.label === "" ? null : text(body.label, 80);
    const version = history.setLabel(id, versionId, label);
    if (!version) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND");
    return { version, stats: project.permission === "owner" ? history.stats(id) : null };
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
    const body = request.body as { path?: unknown } | undefined;
    const filePath = typeof body?.path === "string" ? safeRelativePath(body.path) : undefined;
    return await projectMutations.runExclusive(id, "history restore", () => {
      const currentProject = requireEditableProject(db, id, user);
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
