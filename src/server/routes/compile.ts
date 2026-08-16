import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { requireUser } from "../auth.js";
import { accessibleProject, canEdit } from "../projects.js";
import { resolveSourcePath, safeRelativePath } from "../files.js";
import {
  captureCompileSnapshot,
  cleanCompileArtifacts,
  cleanCompileCache,
  compileProject,
  discardCompileSnapshot,
  hasCompileCache,
  publishCompileArtifacts,
  publishedCompileArtifacts,
  type ProjectCompileCoordinator
} from "../compiler.js";
import { parseCompileDiagnostics } from "../compileDiagnostics.js";
import { pdfToSource, sourceToPdf } from "../synctex.js";
import type { CollaborationService } from "../collaboration.js";
import type { MetricRegistry } from "../metrics.js";
import {
  availablePdf,
  compileMainFile,
  compilePdfUrl,
  isTextCompileArtifact,
  listCompileArtifacts,
  syncArtifacts
} from "../compileArtifacts.js";
import { apiError, contentDisposition } from "../http.js";

interface CompileRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  compileCoordinator: ProjectCompileCoordinator;
  metrics: MetricRegistry;
  pruneCompileRuns: (projectId: string) => void;
}

const now = (): string => new Date().toISOString();
const timingDuration = (milliseconds: number): number => Math.round(milliseconds * 10) / 10;

export function registerCompileRoutes(app: FastifyInstance, context: CompileRouteContext): void {
  const { config, db, collaboration, compileCoordinator, metrics, pruneCompileRuns } = context;

  app.get("/api/projects/:id/compile/latest", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const latest = db.prepare(`SELECT run.id, run.status, run.log, run.created_at, run.finished_at,
      run.requested_by, user.username AS requested_by_username, user.display_name AS requested_by_name
      FROM compile_runs run LEFT JOIN users user ON user.id = run.requested_by
      WHERE run.project_id = ? AND run.main_file = ?
      ORDER BY CASE run.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, run.created_at DESC LIMIT 1`).get(id, mainFile) as {
        id: string; status: string; log: string; created_at: string; finished_at: string | null;
        requested_by: string | null; requested_by_username: string | null; requested_by_name: string | null;
      } | undefined;
    const latestSuccess = db.prepare(`SELECT id, finished_at FROM compile_runs
      WHERE project_id = ? AND main_file = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`).get(id, mainFile) as {
        id: string; finished_at: string | null;
      } | undefined;
    const pdf = availablePdf(config, id, mainFile, project.main_file);
    const published = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
    const publishedRun = published ? db.prepare(`SELECT id, finished_at FROM compile_runs
      WHERE id = ? AND project_id = ? AND status = 'succeeded'`).get(published.runId, id) as {
        id: string; finished_at: string | null;
      } | undefined : undefined;
    const pdfVersion = published?.runId ?? latestSuccess?.id ?? pdf?.version;
    return {
      mainFile,
      latestRun: latest ? {
        id: latest.id, status: latest.status, log: latest.log,
        diagnostics: parseCompileDiagnostics(
          latest.log,
          latest.status === "succeeded" || latest.status === "failed" ? latest.status : null
        ),
        createdAt: latest.created_at, finishedAt: latest.finished_at,
        requestedBy: latest.requested_by ? {
          id: latest.requested_by,
          username: latest.requested_by_username ?? "deleted-user",
          name: latest.requested_by_name ?? "Deleted User"
        } : null
      } : null,
      hasPdf: Boolean(pdf),
      pdfUrl: pdf ? compilePdfUrl(id, mainFile, pdfVersion ?? pdf.version) : null,
      pdfCompiledAt: publishedRun?.finished_at ?? latestSuccess?.finished_at ?? null
    };
  });

  app.get("/api/projects/:id/compile/artifacts", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string; path?: string; download?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const published = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
    if (!query.path) return { mainFile, runId: published?.runId ?? null, artifacts: published ? listCompileArtifacts(published.output) : [] };
    if (!published) return apiError(reply, 404, "COMPILE_ARTIFACTS_NOT_FOUND", "尚无可用的编译产物");
    const relative = safeRelativePath(query.path);
    const absolute = path.join(published.output, relative);
    const outputDirectory = path.resolve(published.output);
    const resolved = path.resolve(absolute);
    if (!resolved.startsWith(`${outputDirectory}${path.sep}`)
      || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND", "编译产物不存在");
    }
    const stat = fs.statSync(resolved);
    if (query.download === "1") {
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", contentDisposition(path.basename(relative), "attachment"));
      reply.header("Content-Length", stat.size);
      return reply.send(fs.createReadStream(resolved));
    }
    if (stat.size > 2 * 1024 * 1024 || !isTextCompileArtifact(relative)) {
      return apiError(reply, 415, "ARTIFACT_PREVIEW_UNSUPPORTED", "该产物不能作为文本预览，请下载后查看");
    }
    return { path: relative, content: fs.readFileSync(resolved, "utf8") };
  });

  app.post("/api/projects/:id/compile/clean", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "COMPILE_FORBIDDEN", "没有清理编译产物的权限");
    const body = (request.body ?? {}) as { mainFile?: unknown; mode?: unknown };
    const mainFile = compileMainFile(config, id, project.main_file, body.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    if (body.mode !== "cache" && body.mode !== "artifacts") {
      return apiError(reply, 400, "REQUEST_INVALID", "清理模式无效");
    }
    const activeRun = db.prepare(`SELECT 1 AS active FROM compile_runs
      WHERE project_id = ? AND main_file = ? AND status IN ('queued', 'running') LIMIT 1`).get(id, mainFile);
    if (activeRun) return apiError(reply, 409, "COMPILE_CLEAN_BUSY", "当前主文档正在编译，请稍后再清理");
    const requestedBy = { id: user.id, username: user.username, name: user.display_name };
    if (body.mode === "cache") {
      cleanCompileCache(config, id, mainFile);
      collaboration.signalCompileState(id, {
        mainFile,
        runId: `clean-${randomUUID()}`,
        status: "cleaned",
        cleanMode: "cache",
        requestedBy,
        updatedAt: now()
      });
      return { ok: true, mode: "cache", mainFile, retainedPdf: true };
    }
    const runs = db.prepare(`SELECT id FROM compile_runs
      WHERE project_id = ? AND main_file = ? AND status NOT IN ('queued', 'running')`).all(id, mainFile) as Array<{ id: string }>;
    cleanCompileArtifacts(config, id, mainFile, project.main_file, runs.map((run) => run.id));
    db.prepare("DELETE FROM compile_runs WHERE project_id = ? AND main_file = ? AND status NOT IN ('queued', 'running')").run(id, mainFile);
    pruneCompileRuns(id);
    collaboration.signalCompileState(id, {
      mainFile,
      runId: `clean-${randomUUID()}`,
      status: "cleaned",
      cleanMode: "artifacts",
      requestedBy,
      updatedAt: now()
    });
    return { ok: true, mode: "artifacts", mainFile, retainedPdf: false };
  });

  app.get("/api/projects/:id/sync/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string; path?: string; line?: string; column?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const sourcePath = safeRelativePath(query.path ?? "");
    const line = Number(query.line);
    const column = Number(query.column ?? 1);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      return apiError(reply, 400, "SYNC_SOURCE_INVALID", "源码位置无效");
    }
    if (!fs.existsSync(resolveSourcePath(config, id, sourcePath))) {
      return apiError(reply, 404, "SOURCE_FILE_NOT_FOUND", "源码文件不存在");
    }
    const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
    if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE", "项目尚无可用的 SyncTeX 数据，请重新编译");
    return await sourceToPdf(artifacts.source, artifacts.pdf, sourcePath, line, column);
  });

  app.get("/api/projects/:id/sync/source", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string; page?: string; x?: string; y?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const page = Number(query.page);
    const x = Number(query.x);
    const y = Number(query.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
      return apiError(reply, 400, "SYNC_PDF_INVALID", "PDF 位置无效");
    }
    const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
    if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE", "项目尚无可用的 SyncTeX 数据，请重新编译");
    const location = await pdfToSource(artifacts.source, artifacts.pdf, page, x, y);
    const sourceDirectory = path.resolve(artifacts.source);
    const relative = path.relative(sourceDirectory, path.resolve(location.input));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return apiError(reply, 400, "SYNCTEX_EXTERNAL_PATH", "SyncTeX 返回了项目外部的源码路径");
    }
    return { path: safeRelativePath(relative.replaceAll(path.sep, "/")), line: location.line, column: location.column };
  });

  app.post("/api/projects/:id/compile", async (request, reply) => {
    const requestStartedAt = performance.now();
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "COMPILE_FORBIDDEN", "没有编译权限");
    const body = (request.body ?? {}) as { mainFile?: unknown };
    const mainFile = compileMainFile(config, id, project.main_file, body.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    collaboration.flushProject(id);

    const runId = randomUUID();
    const snapshotStartedAt = performance.now();
    const snapshot = await captureCompileSnapshot(config, id, runId, {
      mainFile,
      engine: project.engine,
      latexmkrc: project.latexmkrc,
      extraArgs: config.extraArgs
    });
    const snapshotMs = performance.now() - snapshotStartedAt;
    metrics.record("compile.snapshot", snapshotMs);

    const published = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
    const publishedRun = published ? db.prepare(`SELECT id, status, log, finished_at
      FROM compile_runs WHERE id = ? AND project_id = ?`).get(published.runId, id) as {
        id: string; status: string; log: string; finished_at: string | null;
      } | undefined : undefined;
    const latestRun = db.prepare(`SELECT id, status FROM compile_runs
      WHERE project_id = ? AND main_file = ? ORDER BY created_at DESC LIMIT 1`).get(id, mainFile) as {
        id: string; status: string;
      } | undefined;
    const activeRun = db.prepare(`SELECT 1 AS active FROM compile_runs
      WHERE project_id = ? AND main_file = ? AND status IN ('queued', 'running') LIMIT 1`).get(id, mainFile);
    if (!activeRun && published && publishedRun?.status === "succeeded"
      && latestRun?.id === publishedRun.id && snapshot.revision === published.revision
      && hasCompileCache(config, id, mainFile)) {
      discardCompileSnapshot(snapshot);
      const requestMs = performance.now() - requestStartedAt;
      metrics.record("compile.request", requestMs);
      reply.header("Server-Timing", `snapshot;dur=${timingDuration(snapshotMs)}, total;dur=${timingDuration(requestMs)}`);
      return {
        runId: published.runId,
        ok: true,
        skipped: true,
        log: publishedRun.log ?? "",
        diagnostics: parseCompileDiagnostics(publishedRun.log ?? "", "succeeded"),
        mainFile,
        pdfUrl: compilePdfUrl(id, mainFile, published.runId),
        pdfCompiledAt: publishedRun.finished_at,
        timings: { snapshotMs, requestMs }
      };
    }

    db.prepare("INSERT INTO compile_runs (id, project_id, requested_by, main_file, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(runId, id, user.id, mainFile, now());
    const requestedBy = { id: user.id, username: user.username, name: user.display_name };
    let phase: "queued" | "running" | "succeeded" | "failed" = "queued";
    const broadcast = () => collaboration.signalCompileState(id, { mainFile, runId, status: phase, requestedBy, updatedAt: now() });
    const result = await compileCoordinator.request({
      projectId: id,
      target: mainFile,
      runId,
      revision: snapshot.revision,
      onQueued: broadcast,
      onSelected: broadcast,
      onDiscarded: () => {
        db.prepare("DELETE FROM compile_runs WHERE id = ? AND status = 'queued'").run(runId);
        discardCompileSnapshot(snapshot);
      },
      execute: async () => {
        phase = "running";
        db.prepare("UPDATE compile_runs SET status = 'running' WHERE id = ?").run(runId);
        broadcast();
        let compiled;
        try {
          compiled = await compileProject(config, snapshot, mainFile, project.engine, project.latexmkrc);
          if (compiled.ok && compiled.pdfPath) {
            if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new Error("项目已被删除");
            const publishStartedAt = performance.now();
            publishCompileArtifacts(config, id, snapshot, compiled);
            if (compiled.timings) {
              compiled.timings.publishMs = performance.now() - publishStartedAt;
              compiled.timings.totalMs += compiled.timings.publishMs;
            }
          } else {
            discardCompileSnapshot(snapshot);
          }
        } catch (error) {
          discardCompileSnapshot(snapshot);
          compiled = {
            ok: false,
            log: error instanceof Error ? error.message : String(error),
            diagnostics: parseCompileDiagnostics(error instanceof Error ? error.message : String(error), "failed"),
            pdfPath: null,
            synctexPath: null
          };
        }
        phase = compiled.ok ? "succeeded" : "failed";
        db.prepare("UPDATE compile_runs SET status = ?, log = ?, finished_at = ? WHERE id = ?")
          .run(phase, compiled.log, now(), runId);
        broadcast();
        return { ...compiled, runId, revision: snapshot.revision };
      }
    });
    const completed = db.prepare("SELECT finished_at FROM compile_runs WHERE id = ?").get(result.runId) as {
      finished_at: string | null;
    } | undefined;
    const requestMs = performance.now() - requestStartedAt;
    metrics.record("compile.request", requestMs);
    if (result.timings) {
      metrics.record("compile.cacheSync", result.timings.cacheSyncMs);
      metrics.record("compile.latexmk", result.timings.latexmkMs);
      metrics.record("compile.artifactCopy", result.timings.artifactCopyMs);
    }
    pruneCompileRuns(id);
    const timings = result.timings ? { snapshotMs, ...result.timings, requestMs } : { snapshotMs, requestMs };
    reply.header("Server-Timing", [
      `snapshot;dur=${timingDuration(snapshotMs)}`,
      result.timings ? `cache;dur=${timingDuration(result.timings.cacheSyncMs)}` : "",
      result.timings ? `latexmk;dur=${timingDuration(result.timings.latexmkMs)}` : "",
      result.timings ? `artifacts;dur=${timingDuration(result.timings.artifactCopyMs)}` : "",
      result.timings?.publishMs !== undefined ? `publish;dur=${timingDuration(result.timings.publishMs)}` : "",
      `total;dur=${timingDuration(requestMs)}`
    ].filter(Boolean).join(", "));
    return {
      mainFile, runId: result.runId, ok: result.ok, skipped: false, log: result.log, diagnostics: result.diagnostics,
      pdfUrl: result.ok ? compilePdfUrl(id, mainFile, result.runId) : null,
      pdfCompiledAt: result.ok ? completed?.finished_at ?? null : null,
      timings
    };
  });

  app.get("/api/projects/:id/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string; download?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const downloading = query.download === "1";
    const artifact = availablePdf(config, id, mainFile, project.main_file);
    if (!artifact) return apiError(reply, 404, "PDF_NOT_FOUND", "尚未生成 PDF");
    const pdf = artifact.path;
    const stat = fs.statSync(pdf);
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    reply.header("Content-Type", "application/pdf");
    const targetSuffix = mainFile === project.main_file ? "" : `-${path.basename(mainFile, ".tex")}`;
    const filename = downloading ? `${project.name}${targetSuffix}-${pdfDownloadTimestamp()}.pdf` : `${project.name}${targetSuffix}.pdf`;
    reply.header("Content-Disposition", contentDisposition(filename, downloading ? "attachment" : "inline"));
    reply.header("Cache-Control", "private, no-cache");
    reply.header("Accept-Ranges", "bytes");
    reply.header("ETag", etag);
    reply.header("Last-Modified", stat.mtime.toUTCString());
    if (request.headers["if-none-match"]?.split(",").some((candidate) => candidate.trim() === etag)) {
      return reply.code(304).send();
    }
    const range = parseByteRange(request.headers.range, stat.size);
    if (range === "invalid") {
      reply.header("Content-Range", `bytes */${stat.size}`);
      return reply.code(416).send();
    }
    if (range) {
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header("Content-Length", range.end - range.start + 1);
      return reply.code(206).send(fs.createReadStream(pdf, range));
    }
    reply.header("Content-Length", stat.size);
    return reply.send(fs.createReadStream(pdf));
  });
}

function pdfDownloadTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "");
}

type ByteRange = { start: number; end: number };

function parseByteRange(value: string | undefined, size: number): ByteRange | "invalid" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return "invalid";
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
