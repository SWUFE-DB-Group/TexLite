import type { IntervalHistogram } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { requireAdmin } from "../auth.js";
import { maxCollaborativeFileBytes } from "../collaboration.js";
import type { CollaborationService } from "../collaboration.js";
import type { CompileQueue } from "../compiler.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { MetricRegistry } from "../metrics.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { MAX_CITATION_BIBTEX_BYTES } from "../limits.js";
import { MIN_PASSWORD_LENGTH } from "../security.js";

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

}
