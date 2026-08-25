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
  CompileCancelledError,
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
  pdfLoadingMode,
  syncArtifacts
} from "../compileArtifacts.js";
import { MAX_TEXT_PREVIEW_BYTES } from "../limits.js";
import { apiError, contentDisposition, httpError } from "../http.js";

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

function pdfResponseMetadata(config: Config, pdfPath: string | null): {
  pdfSizeBytes: number | null;
  pdfLoadingMode: "full" | "range" | null;
} {
  if (!pdfPath) return { pdfSizeBytes: null, pdfLoadingMode: null };
  const stat = regularFileStat(pdfPath);
  if (!stat) return {
    pdfSizeBytes: null,
    pdfLoadingMode: config.pdfLoadingStrategy === "range" ? "range" : "full"
  };
  return {
    pdfSizeBytes: stat.size,
    pdfLoadingMode: pdfLoadingMode(config, stat.size)
  };
}

function mainDocumentChangedError(): Error {
  return httpError(409, "MAIN_DOCUMENT_CHANGED");
}

function throwIfCompileCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CompileCancelledError();
}

class CompileSnapshotBusyError extends Error {
  readonly code = "COMPILE_SNAPSHOT_BUSY";

  constructor() {
    super("COMPILE_SNAPSHOT_BUSY");
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
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
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
    const pdfMetadata = pdfResponseMetadata(config, pdf?.path ?? null);
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
      pdfCompiledAt: publishedRun?.finished_at ?? latestSuccess?.finished_at ?? null,
      ...pdfMetadata
    };
  });

  app.get("/api/projects/:id/compile/artifacts", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string; path?: string; download?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const published = publishedCompileArtifacts(config, id, mainFile, mainFile === project.main_file);
    if (!query.path) {
      if (!published) return { mainFile, runId: null, artifacts: [] };
      try {
        return { mainFile, runId: published.runId, artifacts: listCompileArtifacts(published.output) };
      } catch (error) {
        // Cleanup can remove a retained run after the manifest has been read.
        // Treat that narrow race as an empty artifact list instead of leaking
        // an internal ENOENT/ENOTDIR as a 500 response.
        if (isMissingFileError(error)) return { mainFile, runId: null, artifacts: [] };
        throw error;
      }
    }
    if (!published) return apiError(reply, 404, "COMPILE_ARTIFACTS_NOT_FOUND");
    const relative = safeRelativePath(query.path);
    const absolute = path.join(published.output, relative);
    const outputDirectory = path.resolve(published.output);
    const resolved = path.resolve(absolute);
    if (!resolved.startsWith(`${outputDirectory}${path.sep}`)) {
      return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile()) return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND");
    } catch (error) {
      if (isMissingFileError(error)) return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND");
      throw error;
    }
    if (query.download === "1") {
      const temporaryDirectory = path.join(config.dataDir, "tmp");
      const temporaryFile = path.join(temporaryDirectory, `artifact-${id}-${randomUUID()}`);
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      try {
        await fs.promises.copyFile(resolved, temporaryFile);
      } catch (error) {
        await fs.promises.rm(temporaryFile, { force: true }).catch(() => undefined);
        if (isMissingFileError(error)) return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND");
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
    if (stat.size > MAX_TEXT_PREVIEW_BYTES || !isTextCompileArtifact(relative)) {
      return apiError(reply, 415, "ARTIFACT_PREVIEW_UNSUPPORTED");
    }
    try {
      return { path: relative, content: fs.readFileSync(resolved, "utf8") };
    } catch (error) {
      if (isMissingFileError(error)) return apiError(reply, 404, "COMPILE_ARTIFACT_NOT_FOUND");
      throw error;
    }
  });

  app.post("/api/projects/:id/compile/clean", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "COMPILE_FORBIDDEN");
    const body = (request.body ?? {}) as { mainFile?: unknown; mode?: unknown };
    const mainFile = compileMainFile(config, id, project.main_file, body.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    if (body.mode !== "cache" && body.mode !== "artifacts") {
      return apiError(reply, 400, "REQUEST_INVALID");
    }
    return await projectMutations.runCompileExclusive(id, () => {
      const activeRun = db.prepare(`SELECT 1 AS active FROM compile_runs
        WHERE project_id = ? AND main_file = ? AND status IN ('queued', 'running') LIMIT 1`).get(id, mainFile);
      if (activeRun) return apiError(reply, 409, "COMPILE_CLEAN_BUSY");
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
      if (!currentProject || !canEdit(currentProject)) return apiError(reply, 403, "COMPILE_FORBIDDEN");
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
      if (!current || !canEdit(current)) throw httpError(403, "COMPILE_FORBIDDEN");
      const selected = compileMainFile(config, id, current.main_file, body.mainFile);
      if (!selected || selected !== mainFile) throw httpError(400, "MAIN_DOCUMENT_INVALID");
    } });
  });

  app.get("/api/projects/:id/sync/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string; path?: string; line?: string; column?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const sourcePath = safeRelativePath(query.path ?? "");
    const line = Number(query.line);
    const column = Number(query.column ?? 1);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      return apiError(reply, 400, "SYNC_SOURCE_INVALID");
    }
    return await projectMutations.runConsistentRead(id, async () => {
      if (!fs.existsSync(resolveSourcePath(config, id, sourcePath))) {
        return apiError(reply, 404, "SOURCE_FILE_NOT_FOUND");
      }
      const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
      if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE");
      return await sourceToPdf(artifacts.source, artifacts.pdf, sourcePath, line, column);
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  app.get("/api/projects/:id/sync/source", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string; page?: string; x?: string; y?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const page = Number(query.page);
    const x = Number(query.x);
    const y = Number(query.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
      return apiError(reply, 400, "SYNC_PDF_INVALID");
    }
    return await projectMutations.runConsistentRead(id, async () => {
      const artifacts = syncArtifacts(config, id, mainFile, project.main_file);
      if (!artifacts) return apiError(reply, 409, "SYNCTEX_NOT_AVAILABLE");
      const location = await pdfToSource(artifacts.source, artifacts.pdf, page, x, y);
      const sourceDirectory = path.resolve(artifacts.source);
      const relative = path.relative(sourceDirectory, path.resolve(location.input));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return apiError(reply, 400, "SYNCTEX_EXTERNAL_PATH");
      }
      return { path: safeRelativePath(relative.replaceAll(path.sep, "/")), line: location.line, column: location.column };
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  app.post("/api/projects/:id/compile/cancel", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "COMPILE_FORBIDDEN");
    const body = (request.body ?? {}) as { mainFile?: unknown };
    const mainFile = compileMainFile(config, id, project.main_file, body.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const cancelled = compileCoordinator.cancel(id, mainFile);
    return { cancelled: Boolean(cancelled), mainFile, runId: cancelled?.runId ?? null, status: cancelled?.status ?? null };
  });

  app.post("/api/projects/:id/compile", async (request, reply) => {
    const requestStartedAt = performance.now();
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const initialProject = accessibleProject(db, id, user);
    if (!initialProject || !canEdit(initialProject)) return apiError(reply, 403, "COMPILE_FORBIDDEN");
    const body = (request.body ?? {}) as { mainFile?: unknown };
    const requestedMainFile = typeof body.mainFile === "string" && body.mainFile ? body.mainFile : null;
    const initialMainFile = compileMainFile(config, id, initialProject.main_file, body.mainFile);
    if (!initialMainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
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
      if (!requestedMainFile && currentMainFile !== initialMainFile) {
        throw mainDocumentChangedError();
      }
      // flushProject() is also the final durability barrier for collaborative
      // edits. Its revision is stable for a no-op flush, so concurrent
      // admissions observe the same generation without reading file contents.
      const revisionBeforeFlush = collaboration.currentRevision(id);
      const receipt = collaboration.hasPendingChanges(id) ? projectMutations.flushProject(id) : null;
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
    let snapshotStale = false;
    let snapshotGeneration: string | null = null;
    const refreshSnapshotStale = () => {
      if (!snapshotGeneration) return;
      if (collaboration.hasPendingChanges(id)) {
        snapshotStale = true;
        return;
      }
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject) return;
      const currentGeneration = compileRequestGeneration(
        currentProject,
        collaboration.currentRevision(id),
        collaboration.currentGeneration(id),
        config.extraArgs
      );
      if (currentGeneration !== snapshotGeneration) snapshotStale = true;
    };
    const broadcast = (stateRunId: string = runId) => collaboration.signalCompileState(id, {
      mainFile, runId: stateRunId, status: phase, requestedBy, updatedAt: now(),
      ...(phase === "succeeded" && snapshotStale ? { stale: true } : {})
    });
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
      onCancelled: () => {
        phase = "failed";
        db.prepare("UPDATE compile_runs SET status = 'failed', log = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')")
          .run(new CompileCancelledError().message, now(), runId);
        broadcast();
      },
      // The compile reservation protects the shared compiler cache and
      // prevents Git/cleanup/deletion from replacing the project while
      // latexmk is running, but it deliberately does not occupy the ordinary
      // project queue for the duration of the subprocess.
      execute: async (signal) => projectMutations.runCompile(id, async () => {
        let snapshot: CompileSnapshot | null = null;
        let snapshotMs = 0;
        const snapshotStartedAt = performance.now();
        try {
          throwIfCompileCancelled(signal);
          // Revalidate settings after queued source operations. Do not use the
          // in-memory collaboration revision to skip before a snapshot: it is
          // not a durable content version and can collide after a room restart
          // or reconnect.
          await projectMutations.runSerialized(id, () => {
            throwIfCompileCancelled(signal);
            const currentProject = accessibleProject(db, id, user);
            if (!currentProject || !canEdit(currentProject)) {
              throw new Error("Project access changed while waiting for a source snapshot");
            }
            const currentMainFile = compileMainFile(config, id, currentProject.main_file, body.mainFile);
            if (!currentMainFile) throw new Error("Selected main document is no longer available");
            if (!requestedMainFile && currentMainFile !== mainFile) throw mainDocumentChangedError();
            project = currentProject;
            mainFile = currentMainFile;
          });
          const captured = await projectMutations.runSerialized(id, async () => {
            throwIfCompileCancelled(signal);
            const currentProject = accessibleProject(db, id, user);
            if (!currentProject || !canEdit(currentProject)) {
              throw new Error("Project access changed while waiting for a source snapshot");
            }
            const currentMainFile = compileMainFile(config, id, currentProject.main_file, body.mainFile);
            if (!currentMainFile) throw new Error("Selected main document is no longer available");
            if (!requestedMainFile && currentMainFile !== mainFile) throw mainDocumentChangedError();
            project = currentProject;
            mainFile = currentMainFile;
            // Capture only after all exclusive source-tree operations queued
            // before this request have completed. A collaboration barrier
            // keeps autosave and explicit flushes from changing the source
            // directory while the asynchronous copy is in progress.
            for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
              const revisionBeforeFlush = collaboration.currentRevision(id);
              const receipt = collaboration.hasPendingChanges(id) ? projectMutations.flushProject(id) : null;
              const expectedRevision = receipt?.revision ?? revisionBeforeFlush;
              const generationKey = compileRequestGeneration(
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
                  generation: generationKey
                });
                throwIfCompileCancelled(signal);
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
              // The barrier makes the candidate internally consistent. Edits
              // that arrive while files are being copied stay in Yjs memory
              // and are flushed only after the barrier is released; they do
              // not make the candidate a mixed or unsafe snapshot. Keep the
              // snapshot and surface that it predates those newer edits.
              const stable = collaboration.isStable(id, afterBarrierRevision);
              if (stable) {
                snapshotStale = afterBarrierRevision !== expectedRevision;
                snapshotGeneration = candidate.generation ?? null;
                return candidate;
              }
              discardCompileSnapshot(candidate);
            }
            throw new CompileSnapshotBusyError();
          }, { flush: false });
          snapshot = captured;
          throwIfCompileCancelled(signal);
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
            // The probe row was deleted, so broadcast the retained run that
            // clients can actually resolve from SQLite and the manifest.
            broadcast(published.runId);
            return {
              runId: published.runId,
              ok: true,
              skipped: true,
              stale: snapshotStale,
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
            compiled = await compileProject(config, snapshot, mainFile, project.engine, project.latexmkrc, { signal });
            refreshSnapshotStale();
            if (compiled.ok && compiled.pdfPath) {
              throwIfCompileCancelled(signal);
              const publishStartedAt = performance.now();
              // Publishing is short and atomic, but still goes through the
              // ordinary project queue so it cannot overlap a source-tree
              // archive/read or another output mutation. The long latexmk
              // process above remains outside that queue.
              await projectMutations.runSerialized(id, () => {
                throwIfCompileCancelled(signal);
                if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) {
                  throw new Error("Project was deleted before compile artifacts could be published.");
                }
                publishCompileArtifacts(config, id, snapshot!, compiled!);
              }, { flush: false });
              refreshSnapshotStale();
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
              ...(error instanceof CompileCancelledError ? { cancelled: true } : {}),
              log: error instanceof Error ? error.message : String(error),
              diagnostics: parseCompileDiagnostics(error instanceof Error ? error.message : String(error), "failed"),
              pdfPath: null,
              synctexPath: null
            };
          }
          // A killed latexmk can leave an incomplete dependency database in
          // the incremental cache. Keep the last published PDF, but make the
          // next requested compile a clean rebuild instead of trusting that
          // partial state.
          if (compiled.cancelled) cleanCompileCache(config, id, mainFile);
          phase = compiled.ok ? "succeeded" : "failed";
          db.prepare("UPDATE compile_runs SET status = ?, log = ?, finished_at = ? WHERE id = ?")
            .run(phase, compiled.log, now(), runId);
          broadcast();
          return { ...compiled, runId, revision: snapshot?.revision ?? admission.generation, stale: snapshotStale, snapshotMs };
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
            ...(error instanceof CompileCancelledError ? { cancelled: true } : {}),
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
    const responsePdf = result.ok ? availablePdf(config, id, mainFile, project.main_file) : null;
    const pdfMetadata = pdfResponseMetadata(config, responsePdf?.path ?? null);
    reply.header("Server-Timing", [
      `snapshot;dur=${timingDuration(result.snapshotMs ?? 0)}`,
      result.timings ? `cache;dur=${timingDuration(result.timings.cacheSyncMs)}` : "",
      result.timings ? `latexmk;dur=${timingDuration(result.timings.latexmkMs)}` : "",
      result.timings ? `artifacts;dur=${timingDuration(result.timings.artifactCopyMs)}` : "",
      result.timings?.publishMs !== undefined ? `publish;dur=${timingDuration(result.timings.publishMs)}` : "",
      `total;dur=${timingDuration(requestMs)}`
    ].filter(Boolean).join(", "));
    return {
      mainFile, runId: result.runId, ok: result.ok, cancelled: result.cancelled === true, skipped: result.skipped === true, log: result.log, diagnostics: result.diagnostics,
      pdfUrl: result.ok ? compilePdfUrl(id, mainFile, result.runId) : null,
      pdfCompiledAt: result.ok ? completed?.finished_at ?? null : null,
      ...pdfMetadata,
      timings
    };
  });

  // Published PDFs are retained, immutable artifacts. Keep this read outside
  // projectMutations: runSerialized/runConsistentRead wait for a cold Yjs room
  // to finish initializing, which would delay the first PDF paint after a
  // server restart. The manifest and per-run bundle are swapped atomically,
  // so a concurrent cleanup can safely result in a normal 404 instead.
  app.get("/api/projects/:id/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string; download?: string; run?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const downloading = query.download === "1";
    let artifact = availablePdf(config, id, mainFile, project.main_file);
    if (!artifact) return apiError(reply, 404, "PDF_NOT_FOUND");
    let versioned = false;
    if (query.run) {
      if (/^[a-f0-9-]{36}$/i.test(query.run)) {
        const run = db.prepare(`SELECT main_file, status FROM compile_runs
          WHERE id = ? AND project_id = ?`).get(query.run, id) as {
            main_file: string; status: string;
          } | undefined;
        if (!run || run.status !== "succeeded" || run.main_file !== mainFile) {
          return apiError(reply, 404, "PDF_NOT_FOUND");
        }
        artifact = compileRunPdf(config, id, mainFile, query.run);
        if (!artifact) return apiError(reply, 404, "PDF_NOT_FOUND");
        versioned = true;
      } else if (artifact.version !== query.run) {
        return apiError(reply, 404, "PDF_NOT_FOUND");
      }
    }
    const pdf = artifact.path;
    const stat = regularFileStat(pdf);
    if (!stat) return apiError(reply, 404, "PDF_NOT_FOUND");
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
      let stream: fs.ReadStream;
      try {
        stream = await openReadStream(fs.createReadStream(pdf, range));
      } catch (error) {
        if (isMissingFileError(error)) return apiError(reply, 404, "PDF_NOT_FOUND");
        throw error;
      }
      return reply.code(206).send(stream);
    }
    reply.header("Content-Length", stat.size);
    let stream: fs.ReadStream;
    try {
      stream = await openReadStream(fs.createReadStream(pdf));
    } catch (error) {
      if (isMissingFileError(error)) return apiError(reply, 404, "PDF_NOT_FOUND");
      throw error;
    }
    return reply.code(200).send(stream);
  });
}

function regularFileStat(filePath: string): fs.Stats | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function openReadStream(stream: fs.ReadStream): Promise<fs.ReadStream> {
  const opened = new Promise<void>((resolve, reject) => {
    stream.once("open", () => resolve());
    stream.once("error", reject);
  });
  await opened;
  return stream;
}

function compileRequestGeneration(
  project: { main_file: string; engine: string; latexmkrc: string | null },
  persistedRevision: number | null,
  sourceGeneration: number,
  extraArgs: readonly string[]
): string {
  return JSON.stringify({
    mainFile: project.main_file,
    engine: project.engine,
    latexmkrc: project.latexmkrc,
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
