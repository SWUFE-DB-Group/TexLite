import { performance, type IntervalHistogram } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { currentUser, requireAdmin } from "../auth.js";
import { maxCollaborativeFileBytes } from "../collaboration.js";
import type { CollaborationService } from "../collaboration.js";
import type { CompileQueue } from "../compiler.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { MetricRegistry } from "../metrics.js";
import type { ProjectOutlineService } from "../projectOutline.js";

interface SystemRouteContext {
  config: Config;
  db: DatabaseConnection;
  queue: CompileQueue;
  collaboration: CollaborationService;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  metrics: MetricRegistry;
  eventLoopDelay: IntervalHistogram;
}

/** Register routes that describe the running server or its live connections. */
export function registerSystemRoutes(app: FastifyInstance, context: SystemRouteContext): void {
  const { config, db, queue, collaboration, latexCompletions, projectOutlines, metrics, eventLoopDelay } = context;

  app.get("/api/config", async () => ({
    siteName: config.siteName,
    adminEmail: config.adminEmail,
    maxUploadSizeMB: Math.floor(config.maxUploadBytes / 1024 / 1024),
    maxCollaborativeFileSizeMB: Math.floor(maxCollaborativeFileBytes(config) / 1024 / 1024),
    allowedEngines: config.allowedEngines,
    allowProjectLatexmkrc: config.allowProjectLatexmkrc
  }));

  app.get("/api/health", async () => ({ ok: true, pid: process.pid, latexmk: config.latexmk }));

  app.get("/api/health/metrics", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      eventLoopDelay: {
        p50Ms: Math.round(eventLoopDelay.percentile(50) / 100_000) / 10,
        p95Ms: Math.round(eventLoopDelay.percentile(95) / 100_000) / 10,
        maxMs: Math.round(eventLoopDelay.max / 100_000) / 10
      },
      compileQueue: queue.stats(),
      collaboration: collaboration.stats(),
      caches: { completions: latexCompletions.stats(), outlines: projectOutlines.stats() },
      durationsMs: metrics.summaries()
    };
  });

  app.get("/api/collaboration/:id", { websocket: true }, (socket, request) => {
    const user = currentUser(request, db);
    if (!user) {
      socket.close(1008, "Authentication required");
      return;
    }
    const { id } = request.params as { id: string };
    const startedAt = performance.now();
    void collaboration.connect(socket, id, user)
      .finally(() => metrics.record("collaboration.connect", performance.now() - startedAt));
  });
}
