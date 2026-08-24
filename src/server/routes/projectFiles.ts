import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { reanchorFileComments } from "../anchors.js";
import { isCollaborativeTextFile, maxCollaborativeFileBytes, type CollaborationService } from "../collaboration.js";
import { compileMainFile } from "../compileArtifacts.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  assertNoSourceSymlinks,
  listProjectFilesAsync,
  resolveSourcePath,
  safePathSegment,
  safeRelativePath,
  sourceRoot
} from "../files.js";
import type { HistoryReason } from "../history.js";
import { apiError, contentDisposition, httpError } from "../http.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { MetricRegistry } from "../metrics.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { accessibleProject, canEdit } from "../projects.js";
import { replaceProject, searchProject } from "../projectSearch.js";
import { mainDocumentCandidates } from "../latexRoot.js";
import {
  commentsForFile,
  escapeGlobPattern,
  movedProjectPath,
  now,
  requireEditableProject,
  touchProject
} from "./projectShared.js";

interface ProjectFileRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  metrics: MetricRegistry;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

/** Register project file-tree, editor content, search, and upload routes. */
export function registerProjectFileRoutes(app: FastifyInstance, context: ProjectFileRouteContext): void {
  const { config, db, collaboration, projectMutations, latexCompletions, projectOutlines, metrics, recordHistory } = context;

  app.get("/api/projects/:id/files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    // Directory walks can be slow on external/project-mounted storage. Keep
    // this request off the event loop and unblocked by Yjs room initialization
    // so the file tree and retained-PDF stream can be served concurrently, but
    // still serialize it with source-tree mutations and collaborative flushes.
    return await projectMutations.runFilesystemRead(id, async () => ({
      files: await listProjectFilesAsync(config, id)
    }), {
      preflight: () => {
        if (!accessibleProject(db, id, user)) {
          throw httpError(404, "PROJECT_NOT_FOUND");
        }
      }
    });
  });

  app.get("/api/projects/:id/main-files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    return await projectMutations.runFilesystemRead(id, async () => {
      const files = await listProjectFilesAsync(config, id);
      return await mainDocumentCandidates(config, id, files);
    }, {
      preflight: () => {
        if (!accessibleProject(db, id, user)) {
          throw httpError(404, "PROJECT_NOT_FOUND");
        }
      }
    });
  });

  app.get("/api/projects/:id/outline", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { mainFile?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID");
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, async () => ({
        outline: await projectOutlines.build(id, mainFile), mainFile
      }), {
        preflight: () => {
          const current = accessibleProject(db, id, user);
          if (!current) throw httpError(404, "PROJECT_NOT_FOUND");
          const selected = compileMainFile(config, id, current.main_file, query.mainFile);
          if (!selected || selected !== mainFile) throw httpError(400, "MAIN_DOCUMENT_INVALID");
        }
      });
    }
    finally { metrics.record("outline.build", performance.now() - startedAt); }
  });

  app.get("/api/projects/:id/search", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { q?: string; caseSensitive?: string; wholeWord?: string };
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, () => searchProject(config, id, {
          query: query.q ?? "",
          caseSensitive: query.caseSensitive === "1",
          wholeWord: query.wholeWord === "1"
        }), {
          preflight: () => {
            if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
          }
      });
    } finally { metrics.record("search.project", performance.now() - startedAt); }
  });

  app.post("/api/projects/:id/search/replace", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { query?: unknown; replacement?: unknown; caseSensitive?: unknown; wholeWord?: unknown };
    if (typeof body.query !== "string" || typeof body.replacement !== "string" || body.replacement.length > 100_000) {
      return apiError(reply, 400, "SEARCH_QUERY_INVALID");
    }
    return await projectMutations.runExclusive(id, "project-wide replace", async () => {
      const changed = await replaceProject(config, id, {
        query: body.query as string,
        caseSensitive: body.caseSensitive === true,
        wholeWord: body.wholeWord === true,
        maxFileBytes: maxCollaborativeFileBytes(config)
      }, body.replacement as string);
      let replacements = 0;
      for (const file of changed) {
        reanchorFileComments(db, id, file.path, file.previous, file.content);
        collaboration.updateFile(id, file.path, file.content, user.id);
        replacements += file.count;
      }
      if (changed.length) {
        touchProject(db, id, user.id);
        recordHistory(id, user.id, "file", changed.map((file) => file.path));
      }
      return { ok: true, replacements, files: changed.map((file) => file.path) };
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });

  app.get("/api/projects/:id/completions", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, async () => ({ index: await latexCompletions.build(id) }), {
        preflight: () => {
          if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
        }
      });
    }
    finally { metrics.record("completions.build", performance.now() - startedAt); }
  });

  app.post("/api/projects/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { path?: unknown };
    const folderPath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    return await projectMutations.runWrite(id, () => {
      const absolute = resolveSourcePath(config, id, folderPath);
      if (fs.existsSync(absolute)) return apiError(reply, 409, "PATH_EXISTS", { path: folderPath });
      fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
      touchProject(db, id, user.id);
      // Empty folders have no file entry to trigger a refresh on their own.
      // Publish a source-tree event so other open sessions see the folder
      // immediately instead of waiting for a later file operation.
      collaboration.invalidateSourceTree(id, folderPath);
      return reply.code(201).send({ ok: true, path: folderPath });
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });

  app.patch("/api/projects/:id/path", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { source?: unknown; destinationDirectory?: unknown; destinationName?: unknown };
    const source = safeRelativePath(typeof body.source === "string" ? body.source : "");
    const destinationDirectory = body.destinationDirectory === "" ? ""
      : safeRelativePath(typeof body.destinationDirectory === "string" ? body.destinationDirectory : "");
    const destinationName = body.destinationName === undefined
      ? path.posix.basename(source)
      : safePathSegment(typeof body.destinationName === "string" ? body.destinationName : "");
    const destination = destinationDirectory ? `${destinationDirectory}/${destinationName}` : destinationName;

    const sourceAbsolute = resolveSourcePath(config, id, source);
    if (!fs.existsSync(sourceAbsolute)) return apiError(reply, 404, "PATH_NOT_FOUND", { path: source });
    if (destination === source) return { ok: true, path: source };
    const initialSourceStat = fs.statSync(sourceAbsolute);
    if (initialSourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
      return apiError(reply, 400, "MOVE_INTO_SELF", { path: source });
    }
    const destinationRoot = destinationDirectory
      ? resolveSourcePath(config, id, destinationDirectory)
      : sourceRoot(config, id);
    if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
      return apiError(reply, 404, "DIRECTORY_NOT_FOUND", { path: destinationDirectory });
    }
    const destinationAbsolute = resolveSourcePath(config, id, destination);
    if (fs.existsSync(destinationAbsolute)) return apiError(reply, 409, "PATH_EXISTS", { path: destination });
    let currentProject = project;
    const validateMove = (): void => {
      currentProject = requireEditableProject(db, id, user);
      assertNoSourceSymlinks(config, id);
      if (!fs.existsSync(sourceAbsolute)) {
        throw httpError(404, "PATH_NOT_FOUND", { path: source });
      }
      const sourceStat = fs.statSync(sourceAbsolute);
      if (sourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
        throw httpError(400, "MOVE_INTO_SELF", { path: source });
      }
      if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
        throw httpError(404, "DIRECTORY_NOT_FOUND", { path: destinationDirectory });
      }
      if (fs.existsSync(destinationAbsolute)) {
        throw httpError(409, "PATH_EXISTS", { path: destination });
      }
    };

    return await projectMutations.runExclusive(id, "move project path", () => {
      fs.renameSync(sourceAbsolute, destinationAbsolute);
      let hasCommentUpdates = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const mainFile = movedProjectPath(currentProject.main_file, source, destination)!;
        const latexmkrc = movedProjectPath(currentProject.latexmkrc, source, destination);
        const changedAt = now();
        db.prepare(`UPDATE projects SET main_file = ?, latexmkrc = ?, updated_at = ?, last_modified_by = ? WHERE id = ?`)
          .run(mainFile, latexmkrc, changedAt, user.id, id);
        const comments = db.prepare("SELECT id, file_path FROM comments WHERE project_id = ?").all(id) as Array<{ id: string; file_path: string }>;
        const updateComment = db.prepare("UPDATE comments SET file_path = ?, updated_at = ? WHERE id = ?");
        for (const comment of comments) {
          const nextPath = movedProjectPath(comment.file_path, source, destination);
          if (nextPath !== comment.file_path) {
            updateComment.run(nextPath, changedAt, comment.id);
            hasCommentUpdates = true;
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        fs.renameSync(destinationAbsolute, sourceAbsolute);
        throw error;
      }
      collaboration.movePath(id, source, destination, user.id);
      if (hasCommentUpdates) collaboration.signalComments(id);
      recordHistory(id, user.id, "file", [source, destination]);
      return { ok: true, path: destination };
    }, { preflight: validateMove });
  });

  app.get("/api/projects/:id/file/raw", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { path?: string; download?: string };
    const filePath = safeRelativePath(query.path ?? "");
    const temporaryDirectory = path.join(config.dataDir, "tmp");
    const temporaryFile = path.join(temporaryDirectory, `file-${id}-${randomUUID()}`);
    try {
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await projectMutations.runConsistentRead(id, async () => {
        const absolute = resolveSourcePath(config, id, filePath);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          throw httpError(404, "FILE_NOT_FOUND", { path: filePath });
        }
        await fs.promises.copyFile(absolute, temporaryFile);
      }, { preflight: () => {
        if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
      } });
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }
    const extension = path.extname(filePath).toLocaleLowerCase();
    const contentTypes: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
      ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
      ".pdf": "application/pdf"
    };
    const contentType = contentTypes[extension] ?? "application/octet-stream";
    const downloading = query.download === "1";
    reply.header("Content-Type", contentType);
    reply.header("Content-Disposition", contentDisposition(path.basename(filePath), downloading ? "attachment" : "inline"));
    reply.header("Cache-Control", "private, no-cache");
    reply.header("Content-Length", fs.statSync(temporaryFile).size);
    const stream = fs.createReadStream(temporaryFile);
    const cleanup = () => { void fs.promises.rm(temporaryFile, { force: true }).catch(() => undefined); };
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return reply.send(stream);
  });

  app.get("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const relative = safeRelativePath(filePath ?? "");
    return await projectMutations.runConsistentRead(id, () => {
      const absolute = resolveSourcePath(config, id, relative);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return apiError(reply, 404, "FILE_NOT_FOUND", { path: relative });
      if (isCollaborativeTextFile(relative) && fs.statSync(absolute).size > maxCollaborativeFileBytes(config)) {
        return apiError(reply, 413, "FILE_TOO_LARGE", { path: relative });
      }
      return { path: relative, content: fs.readFileSync(absolute, "utf8") };
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  // Creating a file is intentionally separate from updating one.  The editor
  // uses PUT for autosaves, but a user action such as "New file" must never
  // silently replace an existing file.
  app.post("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") return apiError(reply, 400, "FILE_CONTENT_INVALID");
    const content = body.content;
    const byteLength = Buffer.byteLength(content, "utf8");
    const limit = isCollaborativeTextFile(filePath) ? maxCollaborativeFileBytes(config) : config.maxUploadBytes;
    if (byteLength > limit) {
      return apiError(reply, 413, "FILE_TOO_LARGE", { path: filePath, size: Math.floor(limit / 1024 / 1024) });
    }
    return await projectMutations.runWrite(id, () => {
      const absolute = resolveSourcePath(config, id, filePath);
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      } catch (error) {
        if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          return apiError(reply, 409, "PATH_EXISTS", { path: filePath });
        }
        throw error;
      }
      try {
        fs.writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return apiError(reply, 409, "FILE_EXISTS", { path: filePath });
        }
        throw error;
      }
      touchProject(db, id, user.id);
      collaboration.updateFile(id, filePath, content, user.id);
      recordHistory(id, user.id, "file", [filePath]);
      return reply.code(201).send({ ok: true, path: filePath, comments: commentsForFile(db, config, id, filePath) });
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });

  app.put("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") return apiError(reply, 400, "FILE_CONTENT_INVALID");
    const content = body.content;
    const byteLength = Buffer.byteLength(content, "utf8");
    const limit = isCollaborativeTextFile(filePath) ? maxCollaborativeFileBytes(config) : config.maxUploadBytes;
    if (byteLength > limit) {
      return apiError(reply, 413, "FILE_TOO_LARGE", { path: filePath, size: Math.floor(limit / 1024 / 1024) });
    }
    return await projectMutations.runWrite(id, () => {
      const absolute = resolveSourcePath(config, id, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const previousContent = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
      reanchorFileComments(db, id, filePath, previousContent, content);
      fs.writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600 });
      touchProject(db, id, user.id);
      collaboration.updateFile(id, filePath, content, user.id);
      recordHistory(id, user.id, "file", [filePath]);
      return { ok: true, comments: commentsForFile(db, config, id, filePath) };
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });

  app.delete("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const { path: filePath } = request.query as { path?: string };
    const relative = safeRelativePath(filePath ?? "");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    return await projectMutations.runWrite(id, () => {
      const currentProject = requireEditableProject(db, id, user);
      if (relative === currentProject.main_file || currentProject.main_file.startsWith(`${relative}/`)) {
        return apiError(reply, 400, "MAIN_FILE_DELETE_FORBIDDEN", { path: relative });
      }
      const absolute = resolveSourcePath(config, id, relative, { allowFinalSymlink: true });
      try { fs.lstatSync(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return apiError(reply, 404, "PATH_NOT_FOUND", { path: relative });
        throw error;
      }
      fs.rmSync(absolute, { recursive: true, force: true });
      const deleteResult = db.prepare("DELETE FROM comments WHERE project_id = ? AND (file_path = ? OR file_path GLOB ?)").run(id, relative, `${escapeGlobPattern(relative)}/*`);
      touchProject(db, id, user.id);
      collaboration.removePath(id, relative);
      if (deleteResult.changes > 0) collaboration.signalComments(id);
      recordHistory(id, user.id, "file", [relative]);
      return { ok: true };
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });

  app.post("/api/projects/:id/upload", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN");
    const part = await request.file();
    if (!part) return apiError(reply, 400, "UPLOAD_EMPTY");
    const { directory, overwrite } = request.query as { directory?: string; overwrite?: string };
    const relative = safeRelativePath(directory ? `${safeRelativePath(directory)}/${part.filename}` : part.filename);
    const uploadLimit = isCollaborativeTextFile(relative) ? maxCollaborativeFileBytes(config) : config.maxUploadBytes;
    const tmpDir = path.join(config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(tmpDir, `upload-${randomUUID()}.tmp`);
    let byteLength = 0;
    try {
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          byteLength += chunk.length;
          if (byteLength > uploadLimit) {
            callback(new Error("FILE_TOO_LARGE"));
          } else {
            callback(null, chunk);
          }
        }
      });
      await pipeline(part.file, limiter, fs.createWriteStream(tmpPath, { mode: 0o600 }));
    } catch (error) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      if (error instanceof Error && error.message === "FILE_TOO_LARGE") {
        return apiError(reply, 413, "FILE_TOO_LARGE", { path: relative, size: Math.floor(uploadLimit / 1024 / 1024) });
      }
      throw error;
    }
    try {
      return await projectMutations.runWrite(id, () => {
        const absolute = resolveSourcePath(config, id, relative);
        try {
          fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
        } catch (error) {
          if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            return apiError(reply, 409, "PATH_EXISTS", { path: relative });
          }
          throw error;
        }
        const replacing = overwrite === "1";
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
          return apiError(reply, 409, "PATH_EXISTS", { path: relative });
        }
        if (!replacing && fs.existsSync(absolute)) {
          return apiError(reply, 409, "FILE_EXISTS", { path: relative });
        }
        const collaborativeText = isCollaborativeTextFile(relative);
        let previousContent: string | null = null;
        if (replacing && collaborativeText && fs.existsSync(absolute)) {
          // runWrite() has flushed any live Yjs edits before entering this
          // callback. Prefer the room's text so comment anchors are based on
          // exactly what collaborators last saved, then fall back to disk for
          // projects without an active collaboration room.
          previousContent = collaboration.fileContent(id, relative);
          if (previousContent === null) previousContent = fs.readFileSync(absolute, "utf8");
        }
        try {
          fs.renameSync(tmpPath, absolute);
        } catch {
          fs.copyFileSync(tmpPath, absolute);
          fs.unlinkSync(tmpPath);
        }
        touchProject(db, id, user.id);
        if (collaborativeText) {
          const content = fs.readFileSync(absolute, "utf8");
          if (previousContent !== null && previousContent !== content) {
            reanchorFileComments(db, id, relative, previousContent, content);
            collaboration.signalComments(id);
          }
          collaboration.updateFile(id, relative, content, user.id);
        } else {
          collaboration.invalidateSourceTree(id, relative);
        }
        recordHistory(id, user.id, "file", [relative]);
        return reply.code(201).send({ ok: true, path: relative });
      }, { preflight: () => { requireEditableProject(db, id, user); } });
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  });
}
