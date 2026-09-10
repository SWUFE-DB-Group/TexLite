import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
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
import { ProjectEditHistoryService } from "./editHistory.js";
import { HistoryRetentionScheduler } from "./historyRetention.js";
import { EditHistoryRetry } from "./editHistoryRetry.js";
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
import { registerProjectReferenceRoutes } from "./routes/projectReferences.js";
import { registerProjectHistoryRoutes } from "./routes/projectHistory.js";
import { registerProjectGitRoutes } from "./routes/projectGit.js";
import { registerProjectCatalogRoutes } from "./routes/projects.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerUserManagementRoutes } from "./routes/users.js";
import { registerWordCountRoutes } from "./routes/wordCount.js";
import { HarperService } from "./harper.js";
import { TexcountService } from "./texcount.js";
import { basePathHref, basePathPrefix, withoutBasePath } from "../shared/basePath.js";

// Retained public helper for callers and tests; implementation lives with the file routes.
export { escapeGlobPattern } from "./routes/projectShared.js";

const SESSION_CLEANUP_INTERVAL_MS = 15 * 60_000;
const now = (): string => new Date().toISOString();

/** Inject the runtime mount point into a single, path-independent Vite build. */
export function renderClientIndex(source: string, basePath: string): string {
  const href = escapeHtmlAttribute(basePathHref(basePath));
  const value = escapeHtmlAttribute(basePath);
  const baseElement = `<base href="${href}" />`;
  const metaElement = `<meta name="texlite-base-path" content="${value}" />`;
  let hadBase = false;
  let rendered = source.replace(/<base\s+href=(?:"[^"]*"|'[^']*')\s*\/?\s*>/i, () => {
    hadBase = true;
    return baseElement;
  });
  if (!hadBase) rendered = rendered.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n    ${baseElement}`);
  let hadMeta = false;
  rendered = rendered.replace(/<meta\s+name=(?:"texlite-base-path"|'texlite-base-path')\s+content=(?:"[^"]*"|'[^']*')\s*\/?\s*>/i, () => {
    hadMeta = true;
    return metaElement;
  });
  if (!hadMeta) rendered = rendered.replace(baseElement, `${baseElement}\n    ${metaElement}`);
  return rendered;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}


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
  const editHistory = new ProjectEditHistoryService(db, config.editHistoryMaxStorageBytes);
  const historyRetention = new HistoryRetentionScheduler(history, {
    onError: (error, projectId) => app.log.error({ err: error, projectId }, "Failed to enforce project history retention")
  });
  const latexCompletions = new LatexCompletionService(config);
  const projectOutlines = new ProjectOutlineService(config);
  const harper = new HarperService();
  const texcount = new TexcountService();
  // Probe the optional host Harper CLI without delaying startup. Its absence is
  // supported: the browser spellchecker remains the writing-check fallback.
  void harper.preload().catch((error) => app.log.info({ err: error }, "Optional Harper CLI is unavailable"));
  const failedSnapshots = new Set<string>();
  const failedEdits = new Map<string, "retrying" | "incomplete">();
  const signalHistory = (id: string) => collaboration.setHistoryWarning(id, failedSnapshots.has(id) || failedEdits.has(id));
  const editRetry = new EditHistoryRetry((id, edits) => editHistory.record(id, edits),
    (id) => Boolean(db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)),
    (id, state, error) => {
      if (state === "discarded") {
        failedEdits.delete(id);
        failedSnapshots.delete(id);
        signalHistory(id);
        return;
      }
      if (failedEdits.get(id) !== "incomplete") {
        if (state === "ok") failedEdits.delete(id); else failedEdits.set(id, state);
      }
      if (error) app.log.error({ err: error, projectId: id }, "Failed to record project edit history");
      signalHistory(id);
    });
  const recordHistory = (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => {
    try {
      const version = history.record(projectId, userId, reason, failedSnapshots.has(projectId) ? undefined : paths, { deferRetention: reason === "autosave" });
      if (failedSnapshots.delete(projectId)) signalHistory(projectId);
      if (version && reason === "autosave") historyRetention.schedule(projectId);
      return version;
    }
    catch (error) {
      failedSnapshots.add(projectId);
      signalHistory(projectId);
      app.log.error({ err: error, projectId }, "Failed to record project history");
      return null;
    }
  };
  const collaboration = new CollaborationService(config, db, ({ projectId, userId, paths, edits, durationMs }) => {
    const started = performance.now();
    editRetry.save(projectId, edits);
    recordHistory(projectId, userId, "autosave", paths);
    metrics.record("collaboration.persist", durationMs + performance.now() - started);
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
    editHistory.enforceRetention(row.id);
    pruneCompileRuns(row.id);
    pruneOrphanedCompileRuns(config, row.id);
  }
  app.addHook("onClose", async () => {
    eventLoopDelay.disable();
    historyRetention.dispose();
    editRetry.dispose();
    await harper.dispose();
    await texcount.dispose();
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
    const registeredRoute = request.routeOptions.url;
    const route = registeredRoute
      ? withoutBasePath(config.basePath, registeredRoute) ?? registeredRoute
      : null;
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

  app.addHook("onClose", async () => collaboration.destroy());

  const indexPath = path.join(config.clientDir, "index.html");
  const renderedIndex = fs.existsSync(indexPath)
    ? renderClientIndex(fs.readFileSync(indexPath, "utf8"), config.basePath)
    : null;
  const routePrefix = basePathPrefix(config.basePath);
  await app.register(async (routes) => {
    routes.addHook("onRequest", async (request) => {
      const requestPath = withoutBasePath(config.basePath, request.url) ?? request.url;
      if (requestPath.startsWith("/api/")
        && requestPath !== "/api/auth/login"
        && requestPath !== "/api/health"
        && requestPath !== "/api/config") {
        const token = request.cookies.texlite_session;
        if (token && !currentUser(request, db)) {
          db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
        }
      }
    });

    registerSystemRoutes(routes, {
      config,
      db,
      queue,
      collaboration,
      latexCompletions,
      projectOutlines,
      metrics,
      eventLoopDelay
    });
    registerCollaborationRoutes(routes, { db, collaboration, metrics });
    registerAuthRoutes(routes, { config, db, loginLimiter });
    registerCitationRoutes(routes, { db });
    registerUserManagementRoutes(routes, {
      config,
      db,
      collaboration,
      projectMutations,
      latexCompletions,
      projectOutlines
    });
    registerCommentRoutes(routes, { config, db, collaboration, projectMutations });
    registerProjectMemberRoutes(routes, { db, collaboration, projectMutations });
    registerProjectFileRoutes(routes, {
      config,
      db,
      collaboration,
      projectMutations,
      latexCompletions,
      projectOutlines,
      metrics,
      recordHistory
    });
    registerProjectReferenceRoutes(routes, { config, db, projectMutations });
    registerProjectHistoryRoutes(routes, { config, db, history, editHistory, projectMutations, recordHistory,
      clearPendingEdits: (id) => { editRetry.clear(id); failedEdits.delete(id); signalHistory(id); },
      scheduleHistoryRetention: (id) => historyRetention.schedule(id) });
    registerProjectGitRoutes(routes, { config, db, collaboration, projectMutations, projectGit, recordHistory });
    registerProjectCatalogRoutes(routes, {
      config,
      db,
      collaboration,
      projectMutations,
      latexCompletions,
      projectOutlines,
      harper,
      recordHistory
    });
    registerWordCountRoutes(routes, { config, db, projectMutations, texcount });
    registerCompileRoutes(routes, { config, db, collaboration, projectMutations, compileCoordinator, metrics, pruneCompileRuns });

    // The factory owns shared services and lifecycle hooks; route modules own endpoint behavior.
    if (renderedIndex !== null) {
      await routes.register(staticPlugin, {
        root: config.clientDir,
        wildcard: false,
        index: false,
        globIgnore: ["index.html"],
        // Vite fingerprints everything under assets/. These large JS/WASM
        // files are safe to cache indefinitely; a new build produces a new
        // URL. The rendered SPA shell below always remains fresh.
        cacheControl: false,
        setHeaders(reply, filePath) {
          const relativePath = path.relative(config.clientDir, filePath).split(path.sep).join("/");
          if (relativePath.startsWith("assets/")) {
            reply.header("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            reply.header("Cache-Control", "public, max-age=3600");
          }
        }
      });
      const sendIndex = async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("Cache-Control", "no-store");
        return reply.type("text/html; charset=utf-8").send(renderedIndex);
      };
      routes.get("/", sendIndex);
      routes.get("/index.html", sendIndex);
      routes.get("/*", async (request, reply) => {
        const requestPath = withoutBasePath(config.basePath, request.url) ?? request.url;
        if (requestPath.startsWith("/api/")) return apiError(reply, 404, "API_NOT_FOUND");
        return sendIndex(request, reply);
      });
    }
  }, { prefix: routePrefix });

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
