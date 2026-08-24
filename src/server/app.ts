import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Config } from "./config.js";
import { pruneExpiredSessions, type DatabaseConnection } from "./db.js";
import { digestToken, LoginRateLimiter } from "./security.js";
import { currentUser } from "./auth.js";
import { pruneTrashDirectory } from "./files.js";
import {
  CompileQueue,
  ProjectCompileCoordinator,
  listPublishedCompileArtifacts,
  pruneOrphanedCompileRuns,
  reconcilePublishedCompileRuns
} from "./compiler.js";
import { CollaborationService } from "./collaboration.js";
import { ProjectMutationCoordinator } from "./projectMutations.js";
import { ProjectGitService } from "./git.js";
import { LatexCompletionService } from "./latexCompletion.js";
import { ProjectHistoryService, type HistoryReason } from "./history.js";
import { ProjectOutlineService } from "./projectOutline.js";
import { MetricRegistry } from "./metrics.js";
import { apiError, HttpError } from "./http.js";
import { registerCompileRoutes } from "./routes/compile.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCollaborationRoutes } from "./routes/collaboration.js";
import { registerCitationRoutes } from "./routes/citations.js";
import { registerCommentRoutes } from "./routes/comments.js";
import { registerProjectMemberRoutes } from "./routes/projectMembers.js";
import { registerProjectFileRoutes } from "./routes/projectFiles.js";
import { registerProjectHistoryRoutes } from "./routes/projectHistory.js";
import { registerProjectGitRoutes } from "./routes/projectGit.js";
import { registerProjectCatalogRoutes } from "./routes/projects.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerUserManagementRoutes } from "./routes/users.js";
import { HarperService } from "./harper.js";

// Retained public helper for callers and tests; implementation lives with the file routes.
export { escapeGlobPattern } from "./routes/projectShared.js";

const SESSION_CLEANUP_INTERVAL_MS = 15 * 60_000;
const now = (): string => new Date().toISOString();


export async function buildApp(
  config: Config,
  db: DatabaseConnection,
  options: { logger?: boolean; githubFetch?: typeof fetch } = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: Math.max(12 * 1024 * 1024, config.maxUploadBytes + 1024 * 1024)
  });
  const queue = new CompileQueue(config.maxCompileJobs);
  const compileCoordinator = new ProjectCompileCoordinator(queue);
  const metrics = new MetricRegistry(200);
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const history = new ProjectHistoryService(config, db);
  const latexCompletions = new LatexCompletionService(config);
  const projectOutlines = new ProjectOutlineService(config);
  const harper = new HarperService();
  // Warm the single server-side runtime without delaying startup. The first
  // request shares this promise if initialization is still in progress.
  void harper.preload().catch((error) => app.log.warn({ err: error }, "Harper could not be initialized"));
  const recordHistory = (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => {
    try { return history.record(projectId, userId, reason, paths); }
    catch (error) {
      app.log.error({ err: error, projectId }, "Failed to record project history");
      return null;
    }
  };
  const collaboration = new CollaborationService(config, db, ({ projectId, userId, paths, durationMs }) => {
    metrics.record("collaboration.persist", durationMs);
    recordHistory(projectId, userId, "autosave", paths);
  });
  const projectMutations = new ProjectMutationCoordinator(collaboration);
  const projectGit = new ProjectGitService(config, db, options.githubFetch);
  const loginLimiter = new LoginRateLimiter();
  for (const row of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    reconcilePublishedCompileRuns(config, db, row.id);
  }
  db.prepare(`UPDATE compile_runs SET status = 'failed',
    log = CASE WHEN log = '' THEN 'Server restarted before compilation finished.' ELSE log END,
    finished_at = ? WHERE status IN ('queued', 'running')`).run(now());
  const pruneCompileRuns = (projectId: string): void => {
    const keep = new Set(listPublishedCompileArtifacts(config, projectId).map((artifact) => artifact.runId));
    const completed = db.prepare(`SELECT id, main_file FROM compile_runs
      WHERE project_id = ? AND status NOT IN ('queued', 'running')
      ORDER BY created_at DESC, rowid DESC`).all(projectId) as Array<{ id: string; main_file: string }>;
    const latestTargets = new Set<string>();
    for (const run of completed) {
      if (!latestTargets.has(run.main_file)) {
        latestTargets.add(run.main_file);
        keep.add(run.id);
      }
    }
    const remove = db.prepare("DELETE FROM compile_runs WHERE id = ?");
    db.transaction(() => {
      for (const run of completed) if (!keep.has(run.id)) remove.run(run.id);
    })();
  };
  // No second TexLite instance can mutate the data directory while the
  // instance lock is held. Finish cleanup before accepting requests so a
  // freshly started server never races a stale trash/tmp removal.
  await pruneTrashDirectory(config);
  for (const row of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    history.enforceRetention(row.id);
    pruneCompileRuns(row.id);
    pruneOrphanedCompileRuns(config, row.id);
  }
  app.addHook("onClose", async () => {
    eventLoopDelay.disable();
    await harper.dispose();
  });
  await app.register(cookie, { hook: "onRequest" });
  await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes }
  });
  const requestStarts = new WeakMap<object, number>();
  app.addHook("onRequest", async (request) => { requestStarts.set(request, performance.now()); });
  app.addHook("onResponse", async (request) => {
    const startedAt = requestStarts.get(request);
    if (startedAt === undefined) return;
    const route = request.routeOptions.url;
    if (!route) return;
    const metric = ({
      "/api/projects/:id": "workspace.project",
      "/api/projects/:id/files": "workspace.files",
      "/api/projects/:id/compile/latest": "workspace.compileState"
    } as Record<string, string>)[route];
    if (metric) metrics.record(metric, performance.now() - startedAt);
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const rawStatus = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    const isClientError = rawStatus !== undefined && rawStatus >= 400 && rawStatus < 500;
    const status = isClientError ? rawStatus : 500;

    if (isClientError) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "REQUEST_INVALID";
      // Only structured HttpError details are included in the response. This
      // prevents operational Error messages (paths, command output, etc.) from
      // leaking while still allowing safe interpolation such as minLength.
      const details = error instanceof HttpError ? error.details : {};
      void apiError(reply, status, code, details);
    } else {
      void apiError(reply, 500, "SERVER_ERROR");
    }
  });

  registerSystemRoutes(app, {
    config,
    db,
    queue,
    collaboration,
    latexCompletions,
    projectOutlines,
    metrics,
    eventLoopDelay
  });
  registerCollaborationRoutes(app, { db, collaboration, metrics });
  registerAuthRoutes(app, { config, db, loginLimiter });
  registerCitationRoutes(app, { db });
  registerUserManagementRoutes(app, {
    config,
    db,
    collaboration,
    projectMutations,
    latexCompletions,
    projectOutlines
  });
  registerCommentRoutes(app, { config, db, collaboration, projectMutations });
  registerProjectMemberRoutes(app, { db, collaboration, projectMutations });
  registerProjectFileRoutes(app, {
    config,
    db,
    collaboration,
    projectMutations,
    latexCompletions,
    projectOutlines,
    metrics,
    recordHistory
  });
  registerProjectHistoryRoutes(app, { config, db, history, projectMutations, recordHistory });
  registerProjectGitRoutes(app, { config, db, collaboration, projectMutations, projectGit, recordHistory });
  registerProjectCatalogRoutes(app, {
    config,
    db,
    collaboration,
    projectMutations,
    latexCompletions,
    projectOutlines,
    harper,
    recordHistory
  });

  registerCompileRoutes(app, { config, db, collaboration, projectMutations, compileCoordinator, metrics, pruneCompileRuns });

  // The factory owns shared services and lifecycle hooks; route modules own endpoint behavior.

  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/") && request.url !== "/api/auth/login" && request.url !== "/api/health" && request.url !== "/api/config") {
      const token = request.cookies.texlite_session;
      if (token && !currentUser(request, db)) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
      }
    }
  });

  app.addHook("onClose", async () => collaboration.destroy());

  if (fs.existsSync(config.clientDir)) {
    await app.register(staticPlugin, {
      root: config.clientDir,
      wildcard: false,
      // Vite fingerprints everything under assets/. These large JS/WASM files
      // are safe to cache indefinitely; a new build produces a new URL. Keep
      // index.html fresh so it always points at the current fingerprints.
      cacheControl: false,
      setHeaders(reply, filePath) {
        const relativePath = path.relative(config.clientDir, filePath).split(path.sep).join("/");
        if (relativePath === "index.html") {
          reply.header("Cache-Control", "no-store");
        } else if (relativePath.startsWith("assets/")) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          reply.header("Cache-Control", "public, max-age=3600");
        }
      }
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) return apiError(reply, 404, "API_NOT_FOUND");
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html");
    });
  }

  const cleanupExpiredSessions = (): void => {
    try {
      pruneExpiredSessions(db, now());
      loginLimiter.prune();
    } catch (error) {
      app.log.error({ err: error }, "Failed to prune expired sessions");
    }
  };
  // Clean up at startup as well as periodically so long-running deployments do
  // not retain one row per historical login indefinitely.
  cleanupExpiredSessions();
  const sessionCleanupTimer = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();
  app.addHook("onClose", async () => { clearInterval(sessionCleanupTimer); });

  return app;
}
