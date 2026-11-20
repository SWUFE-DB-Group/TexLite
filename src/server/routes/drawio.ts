import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser, requireUser } from "../auth.js";
import { browserOriginAllowed } from "../browserOrigin.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { CollaborationService } from "../collaboration.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { HistoryReason } from "../history.js";
import { outputRoot, renameProjectPath, resolveSourcePath, safeRelativePath } from "../files.js";
import { accessibleProject, canEdit } from "../projects.js";
import { apiError, HttpError, httpError } from "../http.js";
import { requireEditableProject, touchProject } from "./projectShared.js";
import { reanchorFileComments } from "../anchors.js";
import { DrawioPdfRenderer } from "../drawioPdf.js";
import { saveProjectText } from "../projectTextSave.js";
import { drawioPdfPath, isDrawioFile } from "../../shared/drawio.js";
import { isTextContent } from "../../shared/fileTypes.js";

const maxDiagramBytes = 5 * 1024 * 1024;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function diagramPath(value: unknown): string {
  const relative = safeRelativePath(typeof value === "string" ? value : "");
  if (!isDrawioFile(relative)) throw httpError(400, "DRAWIO_INVALID");
  return relative;
}
function readDiagram(absolute: string): string {
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw httpError(404, "FILE_NOT_FOUND");
  if (fs.statSync(absolute).size > maxDiagramBytes) throw httpError(413, "DRAWIO_INVALID");
  const bytes = fs.readFileSync(absolute);
  if (!isTextContent(bytes)) throw httpError(400, "DRAWIO_INVALID");
  return bytes.toString("utf8");
}
function validateXml(content: unknown, limit: number): asserts content is string {
  if (typeof content !== "string" || Buffer.byteLength(content) > limit || !isTextContent(Buffer.from(content))
    || !/^\s*(?:<\?xml[^>]*>\s*)?<(?:mxfile|mxGraphModel)(?:\s|>)/.test(content)
    || /<!DOCTYPE/i.test(content)) throw httpError(400, "DRAWIO_INVALID");
}
function pdfRevision(absolute: string): string | null {
  if (!fs.existsSync(absolute)) return null;
  if (!fs.statSync(absolute).isFile()) throw httpError(409, "PATH_EXISTS");
  // Only detect replacement conflicts; do not read an existing large PDF.
  const stat = fs.statSync(absolute, { bigint: true });
  return hash(`${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
}
function writeAtomic(absolute: string, bytes: Buffer): void {
  const temporary = path.join(path.dirname(absolute), `.texlite-drawio-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameProjectPath(temporary, absolute);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function registerDrawioRoutes(app: FastifyInstance, { config, db, collaboration, projectMutations, recordHistory }: {
  config: Config; db: DatabaseConnection; collaboration: CollaborationService; projectMutations: ProjectMutationCoordinator;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}): void {
  const renderer = new DrawioPdfRenderer((err) => app.log.warn({ err }, "draw.io browser export failed"));
  const locks = projectMutations.drawioLocks;
  // Cancel Windows browser jobs before Fastify waits for in-flight exports.
  app.addHook(process.platform === "win32" ? "preClose" : "onClose", async () => { await renderer.close(); });

  app.get("/api/projects/:id/drawio/lock", { websocket: true }, (socket, request) => {
    const user = currentUser(request, db);
    if (!user || user.must_change_password || !browserOriginAllowed(request)) { socket.close(1008, "Access denied"); return; }
    const { id } = request.params as { id: string };
    const valid = () => {
      const current = currentUser(request, db, true);
      const project = current && !current.must_change_password ? accessibleProject(db, id, current) : null;
      return Boolean(project && canEdit(project));
    };
    socket.on("error", () => {});
    let relative: string;
    try { relative = diagramPath((request.query as { path?: unknown }).path); }
    catch { socket.close(1008, "Invalid diagram"); return; }
    void projectMutations.runFilesystemRead(id, () => {
      if (socket.readyState !== 1) return;
      const content = readDiagram(resolveSourcePath(config, id, relative));
      validateXml(content, maxDiagramBytes);
      locks.acquire(id, relative, user.id, user.display_name, socket, valid, hash(content));
    }, { preflight: () => { if (!valid()) throw httpError(403, "PROJECT_EDIT_FORBIDDEN"); } })
      .catch(() => { socket.close(1008, "Diagram unavailable"); });
  });

  app.get("/api/projects/:id/drawio", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const relative = diagramPath((request.query as { path?: unknown }).path);
    reply.header("Cache-Control", "private, no-store");
    // Diagrams are not Yjs documents. Keep the filesystem mutation barrier,
    // without making the editor wait for unrelated room hydration.
    return projectMutations.runFilesystemRead(id, () => {
      const content = readDiagram(resolveSourcePath(config, id, relative));
      validateXml(content, maxDiagramBytes);
      return { content, revision: hash(content), pdfRevision: pdfRevision(resolveSourcePath(config, id, drawioPdfPath(relative))) };
    }, { preflight: () => { if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND"); } });
  });

  app.put("/api/projects/:id/drawio", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id } = request.params as { id: string };
    requireEditableProject(db, id, user);
    const body = request.body as { path?: unknown; content?: unknown; revision?: unknown; lockToken?: unknown };
    const relative = diagramPath(body.path);
    validateXml(body.content, Math.min(maxDiagramBytes, config.maxUploadBytes));
    const content = body.content;
    return projectMutations.runWrite(id, () => {
      locks.assertOwned(id, relative, body.lockToken, user.id);
      const absolute = resolveSourcePath(config, id, relative);
      const previous = readDiagram(absolute);
      // A lost response can leave the browser retrying the same save with its
      // old revision. Acknowledge identical bytes without another write.
      if (previous === content) return { revision: hash(previous) };
      if (hash(previous) !== body.revision) throw httpError(409, "DRAWIO_CONFLICT");
      saveProjectText(db, outputRoot(config, id), absolute, Buffer.from(content, "utf8"), fs.statSync(absolute), () => {
        reanchorFileComments(db, id, relative, previous, content);
        touchProject(db, id, user.id);
      }, (err, directory) => app.log.warn({ err, directory }, "Could not clean up diagram save staging"));
      collaboration.invalidateSourceTree(id, relative);
      recordHistory(id, user.id, "autosave", [relative]);
      return { revision: hash(content) };
    }, { preflight: () => { requireEditableProject(db, id, user); locks.assertOwned(id, relative, body.lockToken, user.id); } });
  });

  app.post("/api/projects/:id/drawio/pdf", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id } = request.params as { id: string };
    requireEditableProject(db, id, user);
    const body = request.body as { path?: unknown; svg?: unknown; revision?: unknown; pdfRevision?: unknown; lockToken?: unknown };
    const relative = diagramPath(body.path), output = drawioPdfPath(relative);
    if (typeof body.svg !== "string" || Buffer.byteLength(body.svg) > 10 * 1024 * 1024
      || !/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(body.svg)) return apiError(reply, 400, "DRAWIO_INVALID");
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () => { if (!reply.raw.writableEnded) controller.abort(); };
    const preflight = () => {
      signal.throwIfAborted();
      requireEditableProject(db, id, user);
    };
    const validate = () => {
      preflight();
      locks.assertOwned(id, relative, body.lockToken, user.id);
      if (hash(readDiagram(resolveSourcePath(config, id, relative))) !== body.revision
        || pdfRevision(resolveSourcePath(config, id, output)) !== body.pdfRevision) throw httpError(409, "DRAWIO_CONFLICT");
    };
    reply.raw.once("close", cancel);
    if (reply.raw.destroyed) cancel();
    try {
      // Validate before spawning, but never hold the project write queue while
      // rendering. Recheck source, output, and permissions at the actual write.
      if (signal.aborted) return;
      await projectMutations.runConsistentRead(id, validate, { preflight }).catch((error) => {
        if (!signal.aborted) throw error;
      });
      if (signal.aborted) return;
      try {
        const pdf = await renderer.render(body.svg, config.drawioBrowserPath, signal);
        signal.throwIfAborted();
        return await projectMutations.runWrite(id, () => {
          validate();
          const absolute = resolveSourcePath(config, id, output);
          writeAtomic(absolute, pdf);
          touchProject(db, id, user.id);
          collaboration.invalidateSourceTree(id, output);
          recordHistory(id, user.id, "file", [output]);
          return { path: output, pdfRevision: pdfRevision(absolute) };
        }, { preflight: validate });
      } catch (error) {
        if (signal.aborted) return;
        requireEditableProject(db, id, user);
        if (error instanceof HttpError) return apiError(reply, error.statusCode, error.code, error.details);
        return apiError(reply, 422, "DRAWIO_EXPORT_FAILED");
      }
    } finally { reply.raw.off("close", cancel); }
  });
}
