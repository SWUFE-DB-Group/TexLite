import type { IntervalHistogram } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { requireAdmin, requireUser } from "../auth.js";
import { maxCollaborativeFileBytes } from "../collaboration.js";
import type { CollaborationService } from "../collaboration.js";
import type { CompileQueue } from "../compiler.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import { eventLoopDelaySummary, type MetricRegistry } from "../metrics.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { MAX_CITATION_BIBTEX_BYTES } from "../limits.js";
import { MIN_PASSWORD_LENGTH } from "../security.js";
import type { UpdateChecker } from "../updates.js";
import { apiError } from "../http.js";
import { ResourceMetrics } from "../resourceMetrics.js";
import { CompilerVersionService } from "../compilerVersions.js";
import { inspectCompilerEnvironment } from "../environment.js";

interface SystemRouteContext {
  config: Config;
  db: DatabaseConnection;
  queue: CompileQueue;
  collaboration: CollaborationService;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  metrics: MetricRegistry;
  eventLoopDelay: IntervalHistogram;
  updates: UpdateChecker;
}

/** Register routes that describe the running server or its live connections. */
export function registerSystemRoutes(app: FastifyInstance, context: SystemRouteContext): void {
  const { config, db, queue, collaboration, latexCompletions, projectOutlines, metrics, eventLoopDelay } = context;
  const resources = new ResourceMetrics();
  const compilerVersions = new CompilerVersionService(() => inspectCompilerEnvironment(config));

  app.get("/api/compiler/versions", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    reply.header("Cache-Control", "no-store");
    return compilerVersions.getVersions();
  });

  app.get("/api/admin/updates", async (request, reply) => {
    const user = requireAdmin(request, reply, db);
    if (!user) return;
    reply.header("Cache-Control", "no-store");
    await context.updates.check();
    return { update: context.updates.notice(user.id) };
  });

  app.post<{ Body: { version?: unknown } }>("/api/admin/updates/dismiss", async (request, reply) => {
    const user = requireAdmin(request, reply, db);
    if (!user) return;
    if (!context.updates.dismiss(user.id, request.body?.version)) return apiError(reply, 400, "REQUEST_INVALID");
    return { ok: true };
  });

  app.get("/api/config", async () => ({
    siteName: config.siteName,
    adminEmail: config.adminEmail,
    basePath: config.basePath,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxCitationBibtexBytes: MAX_CITATION_BIBTEX_BYTES,
    maxUploadSizeMB: Math.floor(config.maxUploadBytes / 1024 / 1024),
    maxCollaborativeFileSizeMB: Math.floor(maxCollaborativeFileBytes(config) / 1024 / 1024),
    allowedEngines: config.allowedEngines,
    allowProjectLatexmkrc: config.allowProjectLatexmkrc
  }));

  app.get("/api/health", async () => ({ ok: true, pid: process.pid, latexmk: config.latexmk }));

  app.get("/api/health/metrics", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    reply.header("Cache-Control", "no-store");
    const resourceMemory = await resources.sample();
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      ...resourceMemory,
      eventLoopDelay: eventLoopDelaySummary(eventLoopDelay),
      compileQueue: queue.stats(),
      collaboration: collaboration.stats(),
      caches: { completions: latexCompletions.stats(), outlines: projectOutlines.stats() },
      durationsMs: metrics.summaries()
    };
  });

}
