import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { requireUser } from "../auth.js";
import { createSessionToken } from "../security.js";
import { requireActualProjectOwner } from "./projectShared.js";
import { httpError, contentDisposition } from "../http.js";
import { requireViewLink, viewCookieName, viewLinkJson, type ViewLinkRow } from "../viewLinks.js";
import { decryptViewLinkToken, encryptViewLinkToken } from "../viewLinkTokens.js";
import { listProjectFilesAsync, resolveSourcePath, safeRelativePath } from "../files.js";
import { isTextContent, MAX_TEXT_EDITOR_BYTES, resourceFileKind } from "../../shared/fileTypes.js";
import { availablePdf, pdfLoadingMode } from "../compileArtifacts.js";
import { withBasePath } from "../../shared/basePath.js";
import { parseByteRange } from "../byteRange.js";
import type { SharedProjectData } from "../../shared/projectViewLinks.js";
import type { ProjectOutlineService } from "../projectOutline.js";

const defaultLifetimeMs = 7 * 24 * 60 * 60_000;
const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff"
};

function privateResponse(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("X-Content-Type-Options", "nosniff");
}

export function registerProjectViewLinkRoutes(app: FastifyInstance, { db, config, projectMutations, projectOutlines }: {
  db: DatabaseConnection; config: Config; projectMutations: ProjectMutationCoordinator; projectOutlines: ProjectOutlineService;
}): void {
  const owner = (request: FastifyRequest, reply: FastifyReply) => {
    privateResponse(reply);
    const user = requireUser(request, reply, db);
    if (!user) return null;
    const { id } = request.params as { id: string };
    requireActualProjectOwner(db, id, user);
    return id;
  };
  const viewPath = (id: string, token: string) => `${withBasePath(config.basePath, `/share/${id}`)}#${token}`;
  const createdLink = (row: ViewLinkRow, token: string) => {
    const path = viewPath(row.id, token);
    return { link: viewLinkJson(row, path), path };
  };
  const createLink = db.transaction((projectId: string, label: string, expiresAt: string | null) => {
    const now = new Date().toISOString();
    // Check and insert under the same write lock, including requests from other
    // tabs. Copying an existing link must never change its token or lifetime.
    const active = db.prepare(`SELECT id FROM project_view_links
      WHERE project_id = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`).get(projectId, now);
    if (active) throw httpError(409, "VIEW_LINK_EXISTS");
    const { token, digest } = createSessionToken();
    const row: ViewLinkRow = { id: randomUUID(), project_id: projectId, token_hash: digest, token_ciphertext: null, label,
      created_at: now, expires_at: expiresAt };
    row.token_ciphertext = encryptViewLinkToken(config, row, token);
    db.prepare(`INSERT INTO project_view_links (id, project_id, token_hash, token_ciphertext, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, projectId, digest, row.token_ciphertext, row.label, now, expiresAt);
    return createdLink(row, token);
  });

  app.get("/api/projects/:id/view-links", async (request, reply) => {
    const id = owner(request, reply); if (!id) return;
    const rows = db.prepare("SELECT * FROM project_view_links WHERE project_id = ? ORDER BY created_at DESC, id").all(id) as ViewLinkRow[];
    return { links: rows.map((row) => {
      const token = decryptViewLinkToken(config, row);
      return viewLinkJson(row, token ? viewPath(row.id, token) : null);
    }) };
  });
  app.post("/api/projects/:id/view-links", { bodyLimit: 4096 }, async (request, reply) => {
    const id = owner(request, reply); if (!id) return;
    const body = (request.body ?? {}) as { label?: unknown; expiresAt?: unknown };
    if (body.label !== undefined && (typeof body.label !== "string" || body.label.trim().length > 80)) throw httpError(400, "VIEW_LINK_LABEL_INVALID");
    const expiry = body.expiresAt === undefined ? Date.now() + defaultLifetimeMs
      : body.expiresAt === null ? null : typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > 8.64e15)) throw httpError(400, "VIEW_LINK_EXPIRY_INVALID");
    return reply.code(201).send(createLink.immediate(id, (body.label as string | undefined)?.trim() ?? "", expiry === null ? null : new Date(expiry).toISOString()));
  });
  app.delete("/api/projects/:id/view-links/:linkId", async (request, reply) => {
    const id = owner(request, reply); if (!id) return;
    const { linkId } = request.params as { linkId: string };
    // Idempotent so retrying after a lost response also removes the stale UI row.
    db.prepare("DELETE FROM project_view_links WHERE id = ? AND project_id = ?").run(linkId, id);
    return { ok: true };
  });

  // Encapsulation keeps all guest responses (including errors) private. No guest
  // route delegates to authenticated project endpoints or creates a Yjs room.
  void app.register(async (guest) => {
    guest.addHook("onRequest", async (_request, reply) => { privateResponse(reply); });
    guest.post("/:linkId/access", { bodyLimit: 1024 }, async (request, reply) => {
      const token = (request.body as { token?: unknown } | null)?.token;
      if (typeof token !== "string") throw httpError(410, "VIEW_LINK_INVALID");
      const row = requireViewLink(db, request, token);
      const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
      reply.setCookie(viewCookieName(row.id), token, { httpOnly: true, sameSite: "strict", secure: isSecure,
        path: withBasePath(config.basePath, `/api/shared/${row.id}`), ...(row.expires_at ? { expires: new Date(row.expires_at) } : {}) });
      return { ok: true };
    });
    guest.get("/:linkId/access", async (request) => {
      const row = requireViewLink(db, request);
      return { expiresAt: row.expires_at };
    });

    guest.get("/:linkId", async (request) => {
      const row = requireViewLink(db, request);
      return projectMutations.runFilesystemRead(row.project_id, async (): Promise<SharedProjectData> => {
        const files = await listProjectFilesAsync(config, row.project_id);
        requireViewLink(db, request);
        const project = db.prepare("SELECT name, main_file, engine FROM projects WHERE id = ?").get(row.project_id) as { name: string; main_file: string; engine: SharedProjectData["project"]["engine"] };
        const outline = await projectOutlines.build(row.project_id, project.main_file);
        const pdf = availablePdf(config, row.project_id, project.main_file);
        let size: number | null = null;
        if (pdf) {
          try { size = (await fs.promises.stat(pdf.path)).size; }
          catch (error) { if (!missingFile(error)) throw error; }
        }
        requireViewLink(db, request);
        const run = pdf ? db.prepare("SELECT finished_at FROM compile_runs WHERE id = ? AND project_id = ? AND status = 'succeeded'")
          .get(pdf.version, row.project_id) as { finished_at: string | null } | undefined : undefined;
        return { siteName: config.siteName, outline, project: { name: project.name, mainFile: project.main_file, engine: project.engine }, expiresAt: row.expires_at,
          files: files.map(({ path, type, size }) => ({ path, type, ...(size !== undefined ? { size } : {}) })),
          pdf: pdf && size !== null ? { size, compiledAt: run?.finished_at ?? null, loadingMode: pdfLoadingMode(config, size),
            url: withBasePath(config.basePath, `/api/shared/${row.id}/pdf?version=${encodeURIComponent(pdf.version)}`) } : null };
      }, { preflight: () => { requireViewLink(db, request); } });
    });

    guest.get("/:linkId/file", async (request) => {
      const row = requireViewLink(db, request);
      const relative = safeRelativePath((request.query as { path?: string }).path ?? "");
      return projectMutations.runFilesystemRead(row.project_id, async () => {
        const handle = await openFile(resolveSourcePath(config, row.project_id, relative));
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw httpError(404, "FILE_NOT_FOUND");
          // Sniff a bounded prefix before reporting size, so a huge binary is
          // never decoded or reported as an editable text file.
          const prefix = Buffer.alloc(Math.min(stat.size, 8192));
          const read = await handle.read(prefix, 0, prefix.length, 0);
          if (!isTextContent(prefix.subarray(0, read.bytesRead), read.bytesRead < stat.size)) throw httpError(400, "FILE_CONTENT_INVALID");
          if (stat.size > MAX_TEXT_EDITOR_BYTES) throw httpError(413, "FILE_TOO_LARGE");
          // Bounded read also handles a file growing during the request.
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of handle.createReadStream({ start: 0, end: MAX_TEXT_EDITOR_BYTES, autoClose: false })) {
            const bytes = chunk as Buffer;
            length += bytes.length;
            if (length > MAX_TEXT_EDITOR_BYTES) throw httpError(413, "FILE_TOO_LARGE");
            chunks.push(bytes);
          }
          const content = Buffer.concat(chunks, length);
          if (!isTextContent(content)) throw httpError(400, "FILE_CONTENT_INVALID");
          requireViewLink(db, request);
          return { path: relative, content: content.toString("utf8") };
        } finally { await handle.close(); }
      }, { preflight: () => { requireViewLink(db, request); } });
    });

    guest.get("/:linkId/resource", async (request, reply) => {
      const row = requireViewLink(db, request);
      const relative = safeRelativePath((request.query as { path?: string }).path ?? "");
      const kind = resourceFileKind(relative);
      if (kind !== "image" && kind !== "pdf") throw httpError(400, "FILE_CONTENT_INVALID");
      return projectMutations.runFilesystemRead(row.project_id, async () => {
        const absolute = resolveSourcePath(config, row.project_id, relative);
        // An uploaded SVG is an image, never an executable same-origin document.
        reply.header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        return sendResource(request, reply, absolute, kind === "pdf" ? "application/pdf" : imageTypes[path.extname(relative).toLowerCase()],
          path.basename(relative), () => { requireViewLink(db, request); });
      }, { preflight: () => { requireViewLink(db, request); } });
    });
    guest.get("/:linkId/pdf", async (request, reply) => {
      const row = requireViewLink(db, request);
      const project = db.prepare("SELECT name, main_file FROM projects WHERE id = ?").get(row.project_id) as { name: string; main_file: string };
      const pdf = availablePdf(config, row.project_id, project.main_file);
      // Do not expose compile history or mix bytes from two versions in Range requests.
      if (!pdf || (request.query as { version?: string }).version !== pdf.version) throw httpError(404, "PDF_NOT_FOUND");
      return sendResource(request, reply, pdf.path, "application/pdf", `${project.name}.pdf`, () => { requireViewLink(db, request); });
    });
  }, { prefix: "/api/shared" });
}

function missingFile(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}
async function openFile(file: string) {
  try { return await fs.promises.open(file, "r"); }
  catch (error) { if (missingFile(error)) throw httpError(404, "FILE_NOT_FOUND"); throw error; }
}
async function sendResource(request: FastifyRequest, reply: FastifyReply, file: string, type: string, filename: string, validate: () => void) {
  const handle = await openFile(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw httpError(404, "FILE_NOT_FOUND");
    validate();
    reply.header("Content-Type", type);
    reply.header("Content-Disposition", contentDisposition(filename, (request.query as { download?: string }).download === "1" ? "attachment" : "inline"));
    reply.header("Accept-Ranges", "bytes");
    const range = parseByteRange(request.headers.range, stat.size);
    if (range === "invalid") {
      await handle.close();
      return reply.header("Content-Range", `bytes */${stat.size}`).code(416).send();
    }
    if (range) reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    reply.header("Content-Length", range ? range.end - range.start + 1 : stat.size);
    if (request.method === "HEAD") { await handle.close(); return reply.code(range ? 206 : 200).send(); }
    // The open descriptor pins this file even if a source-tree operation replaces it.
    return reply.code(range ? 206 : 200).send(handle.createReadStream(range ?? {}));
  } catch (error) { await handle.close(); throw error; }
}
