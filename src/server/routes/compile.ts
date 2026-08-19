import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { requireUser } from "../auth.js";
import { accessibleProject, canEdit } from "../projects.js";
import { resolveSourcePath, safeRelativePath, texFileStem } from "../files.js";
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
import type { CompileSnapshot } from "../compiler.js";
import { parseCompileDiagnostics } from "../compileDiagnostics.js";
import { pdfToSource, sourceToPdf } from "../synctex.js";
import type { CollaborationService } from "../collaboration.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { MetricRegistry } from "../metrics.js";
import {
  availablePdf,
  compileRunPdf,
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
  projectMutations: ProjectMutationCoordinator;
  compileCoordinator: ProjectCompileCoordinator;
  metrics: MetricRegistry;
  pruneCompileRuns: (projectId: string) => void;
}

const now = (): string => new Date().toISOString();
const timingDuration = (milliseconds: number): number => Math.round(milliseconds * 10) / 10;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_AFTER_SECONDS = 1;

class CompileSnapshotBusyError extends Error {
  readonly code = "COMPILE_SNAPSHOT_BUSY";

  constructor() {
    super("项目仍在持续编辑，暂时无法取得一致的编译快照，请稍后重试");
    this.name = "CompileSnapshotBusyError";
  }
}

export function registerCompileRoutes(app: FastifyInstance, context: CompileRouteContext): void {
  const { config, db, collaboration, projectMutations, compileCoordinator, metrics, pruneCompileRuns } = context;

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
    // A retained legacy PDF has no run bundle, so its file version (mtime) is
    // the only stable token that can be resolved back to those bytes.
    const pdfVersion = published?.runId ?? pdf?.version;
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
    return await projectMutations.runSerialized(id, async () => {
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
      const currentMainFile = compileMainFile(config, id, currentProject.main_file, query.mainFile);
      if (!currentMainFile || currentMainFile !== mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
      const published = publishedCompileArtifacts(config, id, mainFile, mainFile === currentProject.main_file);
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
        const temporaryDirectory = path.join(config.dataDir, "tmp");
        const temporaryFile = path.join(temporaryDirectory, `artifact-${id}-${randomUUID()}`);
        await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
        try {
          await fs.promises.copyFile(resolved, temporaryFile);
        } catch (error) {
          await fs.promises.rm(temporaryFile, { force: true }).catch(() => undefined);
          throw error;
        }
        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Disposition", contentDisposition(path.basename(relative), "attachment"));
        reply.header("Content-Length", stat.size);
        const stream = fs.createReadStream(temporaryFile);
        const cleanup = () => { void fs.promises.rm(temporaryFile, { force: true }).catch(() => undefined); };
        stream.once("close", cleanup);
        stream.once("error", cleanup);
        return reply.send(stream);
      }
      if (stat.size > 2 * 1024 * 1024 || !isTextCompileArtifact(relative)) {
        return apiError(reply, 415, "ARTIFACT_PREVIEW_UNSUPPORTED", "该产物不能作为文本预览，请下载后查看");
      }
      return { path: relative, content: fs.readFileSync(resolved, "utf8") };
    }, { flush: false, preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
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
    return await projectMutations.runCompileExclusive(id, () => {
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
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject || !canEdit(currentProject)) return apiError(reply, 403, "COMPILE_FORBIDDEN", "没有清理编译产物的权限");
      const runs = db.prepare(`SELECT id FROM compile_runs
        WHERE project_id = ? AND main_file = ? AND status NOT IN ('queued', 'running')`).all(id, mainFile) as Array<{ id: string }>;
      cleanCompileArtifacts(config, id, mainFile, currentProject.main_file, runs.map((run) => run.id));
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
    }, { preflight: () => {
      const current = accessibleProject(db, id, user);
      if (!current || !canEdit(current)) throw Object.assign(new Error("没有清理编译产物的权限"), { statusCode: 403, code: "COMPILE_FORBIDDEN" });
      const selected = compileMainFile(config, id, current.main_file, body.mainFile);
      if (!selected || selected !== mainFile) throw Object.assign(new Error("所选文件不是有效的 LaTeX 主文档"), { statusCode: 400, code: "MAIN_DOCUMENT_INVALID" });
    } });
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
    return await projectMutations.runConsistentRead(id, async () => {
      if (!fs.existsSync(resolveSourcePath(config, id, sourcePath))) {
        return apiError(reply, 404, "SOURCE_FILE_NOT_FOUND", "源码文件不存在");
      }
      const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
      if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE", "项目尚无可用的 SyncTeX 数据，请重新编译");
      return await sourceToPdf(artifacts.source, artifacts.pdf, sourcePath, line, column);
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
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
    return await projectMutations.runConsistentRead(id, async () => {
      const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
      if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE", "项目尚无可用的 SyncTeX 数据，请重新编译");
      const location = await pdfToSource(artifacts.source, artifacts.pdf, page, x, y);
      const sourceDirectory = path.resolve(artifacts.source);
      const relative = path.relative(sourceDirectory, path.resolve(location.input));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return apiError(reply, 400, "SYNCTEX_EXTERNAL_PATH", "SyncTeX 返回了项目外部的源码路径");
      }
      return { path: safeRelativePath(relative.replaceAll(path.sep, "/")), line: location.line, column: location.column };
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
  });

  app.post("/api/projects/:id/compile", async (request, reply) => {
    const requestStartedAt = performance.now();
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const initialProject = accessibleProject(db, id, user);
    if (!initialProject || !canEdit(initialProject)) return apiError(reply, 403, "COMPILE_FORBIDDEN", "没有编译权限");
    const body = (request.body ?? {}) as { mainFile?: unknown };
    const initialMainFile = compileMainFile(config, id, initialProject.main_file, body.mainFile);
    if (!initialMainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const runId = randomUUID();

    // Admission must stay cheap. In particular, do not call
    // captureCompileSnapshot here: several collaborators can reach this
    // endpoint at the same time, and the coordinator needs to coalesce them
    // before any project files are copied or hashed.
    const admission = await projectMutations.runSnapshot(id, () => {
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject || !canEdit(currentProject)) throw new Error("Project access changed while waiting for a source snapshot");
      const currentMainFile = compileMainFile(config, id, currentProject.main_file, body.mainFile);
      if (!currentMainFile) throw new Error("Selected main document is no longer available");
      // flushProject() is also the final durability barrier for collaborative
      // edits. Its revision is stable for a no-op flush, so concurrent
      // admissions observe the same generation without reading file contents.
      const revisionBeforeFlush = collaboration.currentRevision(id);
      const receipt = collaboration.hasPendingChanges(id) ? collaboration.flushProject(id) : null;
      const refreshedProject = accessibleProject(db, id, user);
      if (!refreshedProject || !canEdit(refreshedProject)) {
        throw new Error("Project access changed while preparing a compile request");
      }
      const generationRevision = receipt?.revision ?? revisionBeforeFlush;
      const admissionResult = {
        project: refreshedProject,
        mainFile: currentMainFile,
        generation: compileRequestGeneration(
          refreshedProject,
          generationRevision,
          collaboration.currentGeneration(id),
          config.extraArgs
        )
      };
      // Insert the queued probe while the project lock is still held. A
      // concurrent clean request must observe this row before the compile
      // coordinator starts copying a snapshot.
      db.prepare("INSERT INTO compile_runs (id, project_id, requested_by, main_file, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
        .run(runId, id, user.id, currentMainFile, now());
      return admissionResult;
    });
    let project = admission.project;
    let mainFile = admission.mainFile;
    const requestedBy = { id: user.id, username: user.username, name: user.display_name };
    let phase: "queued" | "running" | "succeeded" | "failed" = "queued";
    const broadcast = () => collaboration.signalCompileState(id, { mainFile, runId, status: phase, requestedBy, updatedAt: now() });
    const result = await compileCoordinator.request({
      projectId: id,
      target: mainFile,
      runId,
      // This key is computed before snapshot creation. The content digest
      // returned by captureCompileSnapshot is only the result revision.
      generation: admission.generation,
      revision: admission.generation,
      onQueued: broadcast,
      onSelected: broadcast,
      onDiscarded: () => {
        db.prepare("DELETE FROM compile_runs WHERE id = ? AND status = 'queued'").run(runId);
      },
      // The compile reservation protects the shared compiler cache and
      // prevents Git/cleanup/deletion from replacing the project while
      // latexmk is running, but it deliberately does not occupy the ordinary
      // project queue for the duration of the subprocess.
      execute: async () => projectMutations.runCompile(id, async () => {
        let snapshot: CompileSnapshot | null = null;
        let snapshotMs = 0;
        const snapshotStartedAt = performance.now();
        try {
          // Refresh the cheap generation after waiting for any queued source
          // operation. This makes the no-op check safe when a Git/HTTP write
          // completed after admission but before this compile got a worker.
          const refreshed = await projectMutations.runSerialized(id, () => {
            const currentProject = accessibleProject(db, id, user);
            if (!currentProject || !canEdit(currentProject)) {
              throw new Error("Project access changed while waiting for a source snapshot");
            }
            const currentMainFile = compileMainFile(config, id, currentProject.main_file, body.mainFile);
            if (!currentMainFile) throw new Error("Selected main document is no longer available");
            project = currentProject;
            mainFile = currentMainFile;
            return {
              generation: compileRequestGeneration(
                currentProject,
                collaboration.currentRevision(id),
                collaboration.currentGeneration(id),
                config.extraArgs
              )
            };
          });
          const currentGeneration = refreshed.generation;
          const publishedBeforeSnapshot = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
          const publishedRunBeforeSnapshot = publishedBeforeSnapshot ? db.prepare(`SELECT id, status, log, finished_at
            FROM compile_runs WHERE id = ? AND project_id = ?`).get(publishedBeforeSnapshot.runId, id) as {
              id: string; status: string; log: string; finished_at: string | null;
            } | undefined : undefined;
          const latestRunBeforeSnapshot = db.prepare(`SELECT id, status FROM compile_runs
            WHERE project_id = ? AND main_file = ? AND id <> ? ORDER BY created_at DESC LIMIT 1`).get(id, mainFile, runId) as {
              id: string; status: string;
            } | undefined;
          const activeRunBeforeSnapshot = db.prepare(`SELECT 1 AS active FROM compile_runs
            WHERE project_id = ? AND main_file = ? AND id <> ? AND status IN ('queued', 'running') LIMIT 1`).get(id, mainFile, runId);
          if (!activeRunBeforeSnapshot && publishedBeforeSnapshot?.generation === currentGeneration
            && publishedRunBeforeSnapshot?.status === "succeeded"
            && latestRunBeforeSnapshot?.id === publishedRunBeforeSnapshot.id
            && hasCompileCache(config, id, mainFile)) {
            db.prepare("DELETE FROM compile_runs WHERE id = ? AND status = 'queued'").run(runId);
            phase = "succeeded";
            broadcast();
            return {
              runId: publishedBeforeSnapshot.runId,
              ok: true,
              skipped: true,
              log: publishedRunBeforeSnapshot.log ?? "",
              diagnostics: parseCompileDiagnostics(publishedRunBeforeSnapshot.log ?? "", "succeeded"),
              pdfPath: null,
              synctexPath: publishedBeforeSnapshot.synctex,
              revision: publishedBeforeSnapshot.revision,
              snapshotMs: 0
            };
          }
          const captured = await projectMutations.runSerialized(id, async () => {
            const currentProject = accessibleProject(db, id, user);
            if (!currentProject || !canEdit(currentProject)) {
              throw new Error("Project access changed while waiting for a source snapshot");
            }
            const currentMainFile = compileMainFile(config, id, currentProject.main_file, body.mainFile);
            if (!currentMainFile) throw new Error("Selected main document is no longer available");
            project = currentProject;
            mainFile = currentMainFile;
            // Capture only after all exclusive source-tree operations queued
            // before this request have completed. A collaboration barrier
            // keeps autosave and explicit flushes from changing the source
            // directory while the asynchronous copy is in progress.
            for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
              const revisionBeforeFlush = collaboration.currentRevision(id);
              const receipt = collaboration.hasPendingChanges(id) ? collaboration.flushProject(id) : null;
              const expectedRevision = receipt?.revision ?? revisionBeforeFlush;
              const snapshotGeneration = compileRequestGeneration(
                project,
                expectedRevision,
                collaboration.currentGeneration(id),
                config.extraArgs
              );
              let candidate: CompileSnapshot | null = null;
              let captureError: unknown = null;
              let releaseError: unknown = null;
              let afterBarrierRevision: number | null = null;
              collaboration.beginSnapshotBarrier(id);
              try {
                candidate = await captureCompileSnapshot(config, id, runId, {
                  mainFile,
                  engine: project.engine,
                  latexmkrc: project.latexmkrc,
                  extraArgs: config.extraArgs,
                  generation: snapshotGeneration
                });
              } catch (error) {
                captureError = error;
              }
              try {
                const afterBarrier = collaboration.endSnapshotBarrier(id);
                afterBarrierRevision = afterBarrier?.revision ?? collaboration.currentRevision(id);
              } catch (error) {
                releaseError = error;
              }
              if (captureError) {
                if (candidate) discardCompileSnapshot(candidate);
                throw captureError;
              }
              if (releaseError) {
                if (candidate) discardCompileSnapshot(candidate);
                throw releaseError;
              }
              if (!candidate) throw new Error("Unable to create a compile snapshot");
              const roomCreatedWithoutEdits = expectedRevision === null
                && afterBarrierRevision === 0 && !collaboration.hasPendingChanges(id);
              const stable = (afterBarrierRevision === expectedRevision || roomCreatedWithoutEdits)
                && collaboration.isStable(id, afterBarrierRevision);
              if (stable) return candidate;
              discardCompileSnapshot(candidate);
            }
            throw new CompileSnapshotBusyError();
          }, { flush: false });
          snapshot = captured;
          snapshotMs = performance.now() - snapshotStartedAt;
          metrics.record("compile.snapshot", snapshotMs);

          const published = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
          const publishedRun = published ? db.prepare(`SELECT id, status, log, finished_at
            FROM compile_runs WHERE id = ? AND project_id = ?`).get(published.runId, id) as {
              id: string; status: string; log: string; finished_at: string | null;
            } | undefined : undefined;
          // The current queued row is intentionally excluded. It is a request
          // probe, not evidence that the last successful compile is stale.
          const latestRun = db.prepare(`SELECT id, status FROM compile_runs
            WHERE project_id = ? AND main_file = ? AND id <> ? ORDER BY created_at DESC LIMIT 1`).get(id, mainFile, runId) as {
              id: string; status: string;
            } | undefined;
          const activeRun = db.prepare(`SELECT 1 AS active FROM compile_runs
            WHERE project_id = ? AND main_file = ? AND id <> ? AND status IN ('queued', 'running') LIMIT 1`).get(id, mainFile, runId);
          if (!activeRun && published && publishedRun?.status === "succeeded"
            && latestRun?.id === publishedRun.id && snapshot.revision === published.revision
            && hasCompileCache(config, id, mainFile)) {
            discardCompileSnapshot(snapshot);
            snapshot = null;
            db.prepare("DELETE FROM compile_runs WHERE id = ? AND status = 'queued'").run(runId);
            phase = "succeeded";
            broadcast();
            return {
              runId: published.runId,
              ok: true,
              skipped: true,
              log: publishedRun.log ?? "",
              diagnostics: parseCompileDiagnostics(publishedRun.log ?? "", "succeeded"),
              pdfPath: null,
              synctexPath: published.synctex,
              revision: published.revision,
              snapshotMs
            };
          }

          phase = "running";
          db.prepare("UPDATE compile_runs SET status = 'running' WHERE id = ?").run(runId);
          broadcast();
          let compiled;
          try {
            compiled = await compileProject(config, snapshot, mainFile, project.engine, project.latexmkrc);
            if (compiled.ok && compiled.pdfPath) {
              const publishStartedAt = performance.now();
              // Publishing is short and atomic, but still goes through the
              // ordinary project queue so it cannot overlap a source-tree
              // archive/read or another output mutation. The long latexmk
              // process above remains outside that queue.
              await projectMutations.runSerialized(id, () => {
                if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new Error("项目已被删除");
                publishCompileArtifacts(config, id, snapshot!, compiled!);
              }, { flush: false });
              if (compiled.timings) {
                compiled.timings.publishMs = performance.now() - publishStartedAt;
                compiled.timings.totalMs += compiled.timings.publishMs;
              }
            } else {
              discardCompileSnapshot(snapshot);
              snapshot = null;
            }
          } catch (error) {
            if (snapshot) discardCompileSnapshot(snapshot);
            snapshot = null;
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
          return { ...compiled, runId, revision: snapshot?.revision ?? admission.generation, snapshotMs };
        } catch (error) {
          if (snapshot) discardCompileSnapshot(snapshot);
          if (error instanceof CompileSnapshotBusyError) {
            snapshotMs = performance.now() - snapshotStartedAt;
            metrics.record("compile.snapshot", snapshotMs);
            phase = "failed";
            db.prepare("DELETE FROM compile_runs WHERE id = ? AND status = 'queued'").run(runId);
            broadcast();
            return {
              ok: false,
              retryable: true,
              errorCode: error.code,
              log: error.message,
              diagnostics: { warnings: [], errors: [] },
              pdfPath: null,
              synctexPath: null,
              runId,
              revision: admission.generation,
              snapshotMs
            };
          }
          const log = error instanceof Error ? error.message : String(error);
          phase = "failed";
          db.prepare("UPDATE compile_runs SET status = 'failed', log = ?, finished_at = ? WHERE id = ?")
            .run(log, now(), runId);
          broadcast();
          return {
            ok: false,
            log,
            diagnostics: parseCompileDiagnostics(log, "failed"),
            pdfPath: null,
            synctexPath: null,
            runId,
            revision: admission.generation,
            snapshotMs
          };
        }
      }),
    });
    const completed = db.prepare("SELECT finished_at FROM compile_runs WHERE id = ?").get(result.runId) as {
      finished_at: string | null;
    } | undefined;
    const requestMs = performance.now() - requestStartedAt;
    metrics.record("compile.request", requestMs);
    if (result.retryable) {
      await projectMutations.runSerialized(id, () => { pruneCompileRuns(id); }, { flush: false });
      reply.header("Retry-After", String(SNAPSHOT_RETRY_AFTER_SECONDS));
      reply.header("Server-Timing", [
        `snapshot;dur=${timingDuration(result.snapshotMs ?? 0)}`,
        `total;dur=${timingDuration(requestMs)}`
      ].join(", "));
      return apiError(
        reply,
        409,
        result.errorCode ?? "COMPILE_SNAPSHOT_BUSY",
        result.log,
        { retryable: true, retryAfterSeconds: SNAPSHOT_RETRY_AFTER_SECONDS }
      );
    }
    if (result.timings) {
      metrics.record("compile.cacheSync", result.timings.cacheSyncMs);
      metrics.record("compile.latexmk", result.timings.latexmkMs);
      metrics.record("compile.artifactCopy", result.timings.artifactCopyMs);
    }
    await projectMutations.runSerialized(id, () => { pruneCompileRuns(id); }, { flush: false });
    const timings = result.timings
      ? { snapshotMs: result.snapshotMs ?? 0, ...result.timings, requestMs }
      : { snapshotMs: result.snapshotMs ?? 0, requestMs };
    reply.header("Server-Timing", [
      `snapshot;dur=${timingDuration(result.snapshotMs ?? 0)}`,
      result.timings ? `cache;dur=${timingDuration(result.timings.cacheSyncMs)}` : "",
      result.timings ? `latexmk;dur=${timingDuration(result.timings.latexmkMs)}` : "",
      result.timings ? `artifacts;dur=${timingDuration(result.timings.artifactCopyMs)}` : "",
      result.timings?.publishMs !== undefined ? `publish;dur=${timingDuration(result.timings.publishMs)}` : "",
      `total;dur=${timingDuration(requestMs)}`
    ].filter(Boolean).join(", "));
    return {
      mainFile, runId: result.runId, ok: result.ok, skipped: result.skipped === true, log: result.log, diagnostics: result.diagnostics,
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
    const query = request.query as { mainFile?: string; download?: string; run?: string };
    const requestedMainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!requestedMainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    const pdfResponse = await projectMutations.runSerialized(id, async () => {
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
      const currentMainFile = compileMainFile(config, id, currentProject.main_file, query.mainFile);
      if (!currentMainFile || currentMainFile !== requestedMainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
      const project = currentProject;
      const mainFile = currentMainFile;
    const downloading = query.download === "1";
    let artifact = availablePdf(config, id, mainFile, project.main_file);
    if (!artifact) return apiError(reply, 404, "PDF_NOT_FOUND", "尚未生成 PDF");
    let versioned = false;
    if (query.run) {
      if (/^[a-f0-9-]{36}$/i.test(query.run)) {
        const run = db.prepare(`SELECT main_file, status FROM compile_runs
          WHERE id = ? AND project_id = ?`).get(query.run, id) as {
            main_file: string; status: string;
          } | undefined;
        if (!run || run.status !== "succeeded" || run.main_file !== mainFile) {
          return apiError(reply, 404, "PDF_NOT_FOUND", "指定的编译 PDF 不存在");
        }
        artifact = compileRunPdf(config, id, mainFile, query.run);
        if (!artifact) return apiError(reply, 404, "PDF_NOT_FOUND", "指定的编译 PDF 已被清理");
        versioned = true;
      } else if (artifact.version !== query.run) {
        return apiError(reply, 404, "PDF_NOT_FOUND", "指定的编译 PDF 不存在");
      }
    }
    const pdf = artifact.path;
    const stat = fs.statSync(pdf);
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    reply.header("Content-Type", "application/pdf");
    const targetSuffix = mainFile === project.main_file ? "" : `-${texFileStem(mainFile)}`;
    const filename = downloading ? `${project.name}${targetSuffix}-${pdfDownloadTimestamp()}.pdf` : `${project.name}${targetSuffix}.pdf`;
    reply.header("Content-Disposition", contentDisposition(filename, downloading ? "attachment" : "inline"));
    // The run query identifies an immutable successful compile. Keep it in the
    // browser's private cache so reopening a project does not re-download the
    // same PDF; a new successful compile receives a new run URL.
    reply.header(
      "Cache-Control",
      downloading
        ? "private, no-store"
        : versioned
          ? "private, max-age=31536000, immutable"
          : "private, max-age=60, must-revalidate"
    );
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
      return { kind: "stream" as const, statusCode: 206 as const, stream: await openReadStream(fs.createReadStream(pdf, range)) };
    }
    reply.header("Content-Length", stat.size);
    return { kind: "stream" as const, statusCode: 200 as const, stream: await openReadStream(fs.createReadStream(pdf)) };
    }, { flush: false, preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
    if (isPreparedPdfStream(pdfResponse)) {
      return reply.code(pdfResponse.statusCode).send(pdfResponse.stream);
    }
    return pdfResponse;
  });
}

async function openReadStream(stream: fs.ReadStream): Promise<fs.ReadStream> {
  const opened = new Promise<void>((resolve, reject) => {
    stream.once("open", () => resolve());
    stream.once("error", reject);
  });
  await opened;
  return stream;
}

interface PreparedPdfStream {
  kind: "stream";
  statusCode: 200 | 206;
  stream: fs.ReadStream;
}

function isPreparedPdfStream(value: unknown): value is PreparedPdfStream {
  return typeof value === "object" && value !== null
    && "kind" in value && value.kind === "stream"
    && "stream" in value && value.stream instanceof fs.ReadStream;
}

function compileRequestGeneration(
  project: { main_file: string; engine: string; latexmkrc: string | null; updated_at: string },
  persistedRevision: number | null,
  sourceGeneration: number,
  extraArgs: readonly string[]
): string {
  return JSON.stringify({
    mainFile: project.main_file,
    engine: project.engine,
    latexmkrc: project.latexmkrc,
    updatedAt: project.updated_at,
    persistedRevision,
    sourceGeneration,
    extraArgs
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
