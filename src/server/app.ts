import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Config } from "./config.js";
import { activeAdminCount, type DatabaseConnection, type ProjectRow, type UserRow } from "./db.js";
import { createSessionToken, hashPassword, verifyPassword, digestToken } from "./security.js";
import { currentUser, publicUser, requireAdmin, requireUser } from "./auth.js";
import { accessibleProject, canEdit } from "./projects.js";
import {
  createProjectFiles,
  duplicateProjectFiles,
  listProjectFiles,
  outputRoot,
  removeProjectDirectory,
  resolveSourcePath,
  safeRelativePath,
  sourceRoot
} from "./files.js";
import {
  CompileQueue,
  ProjectCompileCoordinator,
  captureCompileSnapshot,
  compileProject,
  discardCompileSnapshot,
  publishCompileArtifacts,
  publishedCompileArtifacts
} from "./compiler.js";
import { createSourceAnchor, offsetToLine, reanchorFileComments } from "./anchors.js";
import { extractProjectZip } from "./zip.js";
import { createProjectArchive } from "./archive.js";
import { pdfToSource, sourceToPdf } from "./synctex.js";
import { CollaborationService } from "./collaboration.js";
import { ProjectGitService } from "./git.js";
import { buildLatexCompletionIndex } from "./latexCompletion.js";
import { checkSpelling } from "./spellCheck.js";

const now = (): string => new Date().toISOString();
const timingDuration = (milliseconds: number): number => Math.round(milliseconds * 10) / 10;

function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name}格式不正确`);
  }
  return value.trim();
}

function dictionaryWord(value: unknown): string {
  if (typeof value !== "string") throw new Error("自定义词格式不正确");
  const word = value.trim();
  if (!word || word.length > 64 || /[\s\\{}$%]/u.test(word)) throw new Error("自定义词格式不正确");
  return word;
}

interface ProjectTag {
  id: string;
  name: string;
  color: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
}

const tagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;

function tagsForProject(db: DatabaseConnection, projectId: string, userId: string): ProjectTag[] {
  return db.prepare(`SELECT tag.id, tag.name, tag.color
    FROM user_tags tag JOIN user_project_tag_links link ON link.tag_id = tag.id
    WHERE link.project_id = ? AND tag.user_id = ? ORDER BY tag.name COLLATE NOCASE`)
    .all(projectId, userId) as unknown as ProjectTag[];
}

function tagsForProjects(db: DatabaseConnection, projectIds: string[], userId: string): Map<string, ProjectTag[]> {
  const result = new Map(projectIds.map((projectId) => [projectId, [] as ProjectTag[]]));
  for (let offset = 0; offset < projectIds.length; offset += 500) {
    const chunk = projectIds.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT link.project_id, tag.id, tag.name, tag.color
      FROM user_project_tag_links link JOIN user_tags tag ON tag.id = link.tag_id
      WHERE tag.user_id = ? AND link.project_id IN (${placeholders})
      ORDER BY tag.name COLLATE NOCASE`).all(userId, ...chunk) as unknown as Array<ProjectTag & { project_id: string }>;
    for (const row of rows) result.get(row.project_id)?.push({ id: row.id, name: row.name, color: row.color });
  }
  return result;
}

function projectJson(project: ProjectRow & {
  permission?: string;
  owner_username?: string;
  owner_display_name?: string;
  last_modified_username?: string | null;
  last_modified_display_name?: string | null;
  archived?: boolean | number;
}, tags: ProjectTag[] = []) {
  return {
    id: project.id,
    ownerId: project.owner_id,
    ownerUsername: project.owner_username,
    ownerDisplayName: project.owner_display_name,
    lastModifiedBy: project.last_modified_by,
    lastModifiedUsername: project.last_modified_username,
    lastModifiedDisplayName: project.last_modified_display_name,
    name: project.name,
    mainFile: project.main_file,
    latexmkrc: project.latexmkrc,
    engine: project.engine,
    permission: project.permission,
    tags,
    archived: Boolean(project.archived),
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

function touchProject(db: DatabaseConnection, projectId: string, userId: string): void {
  db.prepare("UPDATE projects SET updated_at = ?, last_modified_by = ? WHERE id = ?")
    .run(now(), userId, projectId);
}

function projectTextSnapshot(config: Config, projectId: string): Map<string, string> {
  const versionedText = (filePath: string) => /(?:\.tex|\.bib|\.sty|\.cls|\.txt|\.md|latexmkrc)$/i.test(filePath);
  return new Map(listProjectFiles(config, projectId).filter((entry) => entry.type === "file" && versionedText(entry.path)).map((entry) => {
    const absolute = resolveSourcePath(config, projectId, entry.path);
    return [entry.path, fs.statSync(absolute).size <= 5 * 1024 * 1024 ? fs.readFileSync(absolute, "utf8") : ""] as const;
  }));
}

function reanchorProjectSnapshot(db: DatabaseConnection, projectId: string, before: Map<string, string>, after: Map<string, string>): void {
  for (const filePath of new Set([...before.keys(), ...after.keys()])) {
    reanchorFileComments(db, projectId, filePath, before.get(filePath) ?? "", after.get(filePath) ?? "");
  }
}

function movedProjectPath(value: string | null, source: string, destination: string): string | null {
  if (value === null) return null;
  if (value === source) return destination;
  return value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
}

function contentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

function retainedPdfPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "latest.pdf");
}

function retainedSynctexPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "latest.synctex.gz");
}

function availablePdf(config: Config, projectId: string, mainFile: string): { path: string; version: string } | null {
  const published = publishedCompileArtifacts(config, projectId);
  if (published) return { path: published.pdf, version: published.runId };
  const retained = retainedPdfPath(config, projectId);
  if (fs.existsSync(retained)) return { path: retained, version: String(fs.statSync(retained).mtimeMs) };
  const legacy = path.join(outputRoot(config, projectId), `${path.basename(mainFile, ".tex")}.pdf`);
  return fs.existsSync(legacy) ? { path: legacy, version: String(fs.statSync(legacy).mtimeMs) } : null;
}

function syncArtifacts(config: Config, projectId: string, mainFile: string): { source: string; pdf: string; synctex: string } | null {
  const published = publishedCompileArtifacts(config, projectId);
  if (published?.synctex) return { source: published.source, pdf: published.pdf, synctex: published.synctex };
  const retained = {
    source: sourceRoot(config, projectId),
    pdf: retainedPdfPath(config, projectId),
    synctex: retainedSynctexPath(config, projectId)
  };
  if (fs.existsSync(retained.pdf) && fs.existsSync(retained.synctex)) return retained;
  const basename = path.basename(mainFile, ".tex");
  const legacy = {
    source: sourceRoot(config, projectId),
    pdf: path.join(outputRoot(config, projectId), `${basename}.pdf`),
    synctex: path.join(outputRoot(config, projectId), `${basename}.synctex.gz`)
  };
  return fs.existsSync(legacy.pdf) && fs.existsSync(legacy.synctex) ? legacy : null;
}

interface CompileArtifact {
  path: string;
  size: number;
  viewable: boolean;
}

function listCompileArtifacts(directory: string): CompileArtifact[] {
  const artifacts: CompileArtifact[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        artifacts.push({ path: relative, size, viewable: size <= 2 * 1024 * 1024 && isTextCompileArtifact(relative) });
      }
    }
  };
  visit(directory, "");
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function isTextCompileArtifact(filePath: string): boolean {
  return /(?:\.aux|\.bbl|\.bcf|\.blg|\.fls|\.log|\.lof|\.lot|\.nav|\.out|\.run\.xml|\.snm|\.toc|\.vrb|\.fdb_latexmk)$/i.test(filePath);
}

interface CommentRow {
  id: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  selected_text: string;
  start_offset: number;
  end_offset: number;
  content: string;
  resolved: number;
  orphaned: number;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

interface CommentReplyRow {
  id: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

function repliesForComment(db: DatabaseConnection, commentId: string) {
  const rows = db.prepare(`SELECT reply.*, user.username AS author_username,
      user.display_name AS author_display_name
    FROM comment_replies reply LEFT JOIN users user ON user.id = reply.author_id
    WHERE reply.comment_id = ? ORDER BY reply.created_at`)
    .all(commentId) as unknown as CommentReplyRow[];
  return rows.map((reply) => ({
    id: reply.id,
    authorId: reply.author_id,
    authorUsername: reply.author_username,
    authorDisplayName: reply.author_display_name,
    content: reply.content,
    createdAt: reply.created_at,
    updatedAt: reply.updated_at,
    editedAt: reply.edited_at
  }));
}

function commentsForFile(db: DatabaseConnection, config: Config, projectId: string, filePath: string) {
  const absolute = resolveSourcePath(config, projectId, filePath);
  const source = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
  const rows = db.prepare(`SELECT c.*, u.username AS author_username, u.display_name AS author_display_name FROM comments c
    LEFT JOIN users u ON u.id = c.author_id WHERE c.project_id = ? AND c.file_path = ? ORDER BY c.created_at`)
    .all(projectId, filePath) as unknown as CommentRow[];
  return rows.map((comment) => ({
    id: comment.id,
    authorId: comment.author_id,
    authorUsername: comment.author_username,
    authorDisplayName: comment.author_display_name,
    selectedText: comment.selected_text,
    startOffset: comment.start_offset,
    endOffset: comment.end_offset,
    startLine: offsetToLine(source, comment.start_offset),
    endLine: offsetToLine(source, comment.end_offset),
    content: comment.content,
    resolved: Boolean(comment.resolved),
    orphaned: Boolean(comment.orphaned),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    editedAt: comment.edited_at,
    replies: repliesForComment(db, comment.id)
  }));
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
  const collaboration = new CollaborationService(config, db);
  const projectGit = new ProjectGitService(config, db, options.githubFetch);
  db.prepare(`UPDATE compile_runs SET status = 'failed',
    log = CASE WHEN log = '' THEN 'Server restarted before compilation finished.' ELSE log END,
    finished_at = ? WHERE status IN ('queued', 'running')`).run(now());
  await app.register(cookie, { hook: "onRequest" });
  await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes }
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400;
    const message = error instanceof Error ? error.message : "请求格式不正确";
    void reply.code(status >= 500 ? 500 : status).send({
      error: status >= 500 ? "服务器内部错误" : message
    });
  });

  app.get("/api/config", async () => ({
    siteName: config.siteName,
    adminEmail: config.adminEmail,
    maxUploadSizeMB: Math.floor(config.maxUploadBytes / 1024 / 1024),
    allowedEngines: config.allowedEngines,
    allowProjectLatexmkrc: config.allowProjectLatexmkrc
  }));
  app.get("/api/health", async () => ({ ok: true, latexmk: config.latexmk }));
  app.get("/api/collaboration/:id", { websocket: true }, (socket, request) => {
    const user = currentUser(request, db);
    if (!user) {
      socket.close(1008, "Authentication required");
      return;
    }
    const { id } = request.params as { id: string };
    collaboration.connect(socket, id, user);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const username = text(body?.username, "用户名", 64);
    const password = typeof body?.password === "string" ? body.password : "";
    const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    const session = createSessionToken();
    const createdAt = now();
    const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(session.digest, user.id, expires.toISOString(), createdAt);
    reply.setCookie("texlite_session", session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      expires
    });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies.texlite_session;
    if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
    reply.clearCookie("texlite_session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    return { user: publicUser(user) };
  });

  app.put("/api/me/password", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return reply.code(400).send({ error: "当前密码错误" });
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(user.id, digestToken(request.cookies.texlite_session ?? ""));
    return { ok: true };
  });

  app.get("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const users = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS owned_projects
      FROM users u ORDER BY u.created_at
    `).all() as unknown as Array<UserRow & { owned_projects: number }>;
    return { users: users.map((user) => ({ ...publicUser(user), ownedProjects: user.owned_projects })) };
  });

  app.post("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const body = request.body as Record<string, unknown>;
    const username = text(body?.username, "用户名", 64);
    if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) throw new Error("用户名只能包含字母、数字、点、横线或下划线");
    const displayName = text(body?.displayName ?? username, "显示名称", 100);
    const password = typeof body?.password === "string" ? body.password : "";
    const role = body?.role === "admin" ? "admin" : "user";
    const user: UserRow = {
      id: randomUUID(), username, display_name: displayName,
      password_hash: await hashPassword(password), role, disabled: 0,
      must_change_password: 0, can_create_projects: body?.canCreateProjects === true ? 1 : 0, created_at: now()
    };
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`)
      .run(user.id, user.username, user.display_name, user.password_hash, user.role, user.can_create_projects, user.created_at);
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const admin = requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "用户不存在" });
    const body = request.body as Record<string, unknown>;
    const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : target.role;
    const disabled = typeof body.disabled === "boolean" ? Number(body.disabled) : target.disabled;
    const canCreateProjects = typeof body.canCreateProjects === "boolean"
      ? Number(body.canCreateProjects) : target.can_create_projects;
    if (target.role === "admin" && (!role || role !== "admin" || disabled) && activeAdminCount(db) <= 1) {
      return reply.code(400).send({ error: "不能禁用或降级最后一个管理员" });
    }
    const displayName = typeof body.displayName === "string" ? text(body.displayName, "显示名称", 100) : target.display_name;
    let passwordHash = target.password_hash;
    let mustChange = target.must_change_password;
    if (typeof body.password === "string" && body.password) {
      passwordHash = await hashPassword(body.password);
      mustChange = 1;
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    db.prepare(`UPDATE users SET display_name = ?, role = ?, disabled = ?, password_hash = ?, must_change_password = ?, can_create_projects = ? WHERE id = ?`)
      .run(displayName, role, disabled, passwordHash, mustChange, canCreateProjects, id);
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
    return { user: publicUser(updated) };
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const admin = requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { deleteProjects?: boolean };
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "用户不存在" });
    if (target.id === admin.id) return reply.code(400).send({ error: "不能删除当前登录的管理员" });
    if (target.role === "admin" && activeAdminCount(db) <= 1) {
      return reply.code(400).send({ error: "不能删除最后一个管理员" });
    }
    const owned = db.prepare("SELECT id FROM projects WHERE owner_id = ?").all(id) as Array<{ id: string }>;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (body.deleteProjects) {
        db.prepare("DELETE FROM projects WHERE owner_id = ?").run(id);
      } else {
        db.prepare("UPDATE project_git_settings SET token_ciphertext = NULL, github_login = NULL, updated_at = ? WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)")
          .run(now(), id);
        db.prepare("UPDATE projects SET owner_id = ?, last_modified_by = ?, updated_at = ? WHERE owner_id = ?")
          .run(admin.id, admin.id, now(), id);
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (body.deleteProjects) {
      for (const project of owned) removeProjectDirectory(config, project.id);
    }
    return { ok: true, deletedProjects: body.deleteProjects ? owned.length : 0 };
  });

  app.get("/api/users", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    const rows = db.prepare("SELECT id, username, display_name AS displayName FROM users WHERE disabled = 0 ORDER BY username").all();
    return { users: rows };
  });

  app.get("/api/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const tags = db.prepare("SELECT id, name, color FROM user_tags WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(user.id);
    return { tags };
  });

  app.post("/api/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { name?: unknown; color?: unknown };
    const name = text(body.name, "标签名称", 32);
    const color = tagColors.includes(body.color as typeof tagColors[number])
      ? body.color as typeof tagColors[number] : "gray";
    const tag: ProjectTag = { id: randomUUID(), name, color };
    const createdAt = now();
    db.prepare("INSERT INTO user_tags (id, name, color, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tag.id, tag.name, tag.color, user.id, createdAt, createdAt);
    return reply.code(201).send({ tag });
  });

  app.get("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { archived?: string; page?: string; pageSize?: string; search?: string; tag?: string; sort?: string };
    const archivedOnly = query.archived === "1" || query.archived === "true";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const requestedPageSize = Number.parseInt(query.pageSize ?? "20", 10);
    const pageSize = Math.min(100, Math.max(1, Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 20));
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    const sortColumn = query.sort === "created" ? "p.created_at" : "p.updated_at";
    const archiveCondition = archivedOnly
      ? "EXISTS (SELECT 1 FROM user_project_archives archive WHERE archive.project_id = p.id AND archive.user_id = :userId)"
      : "NOT EXISTS (SELECT 1 FROM user_project_archives archive WHERE archive.project_id = p.id AND archive.user_id = :userId)";
    const from = user.role === "admin"
      ? `FROM projects p JOIN users owner ON owner.id = p.owner_id
          LEFT JOIN users modifier ON modifier.id = p.last_modified_by`
      : `FROM projects p JOIN users owner ON owner.id = p.owner_id
          LEFT JOIN users modifier ON modifier.id = p.last_modified_by
          LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = :userId`;
    const conditions = [
      ...(user.role === "admin" ? [] : ["(p.owner_id = :userId OR pm.user_id = :userId)"]),
      archiveCondition
    ];
    const params: Record<string, string | number> = { userId: user.id };
    if (search) {
      conditions.push("(p.name LIKE :search OR owner.username LIKE :search OR owner.display_name LIKE :search)");
      params.search = `%${search}%`;
    }
    if (tagId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM user_project_tag_links tag_link
        JOIN user_tags tag ON tag.id = tag_link.tag_id
        WHERE tag_link.project_id = p.id AND tag.user_id = :userId AND tag.id = :tagId
      )`);
      params.tagId = tagId;
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const countRow = db.prepare(`SELECT COUNT(DISTINCT p.id) AS total ${from} ${where}`).get(params) as { total: number };
    const total = Number(countRow.total);
    const totalPages = Math.ceil(total / pageSize);
    const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const rowsParams = { ...params, limit: pageSize, offset: (currentPage - 1) * pageSize };
    const select = user.role === "admin"
      ? `SELECT p.*, 'owner' AS permission, owner.username AS owner_username,
          owner.display_name AS owner_display_name,
          modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name`
      : `SELECT DISTINCT p.*,
          CASE WHEN p.owner_id = :userId THEN 'owner' ELSE pm.permission END AS permission,
          owner.username AS owner_username, owner.display_name AS owner_display_name,
          modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name`;
    const rows = db.prepare(`${select} ${from} ${where}
      ORDER BY ${sortColumn} DESC, p.name COLLATE NOCASE ASC
      LIMIT :limit OFFSET :offset`).all(rowsParams);
    const projects = rows as unknown as Array<ProjectRow & { permission: string }>;
    const projectTags = tagsForProjects(db, projects.map((project) => project.id), user.id);
    return {
      projects: projects.map((project) => projectJson({ ...project, archived: archivedOnly }, projectTags.get(project.id) ?? [])),
      pagination: { page: currentPage, pageSize, total, totalPages }
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return reply.code(403).send({ error: "管理员尚未授予你创建项目的权限" });
    }
    const body = request.body as Record<string, unknown>;
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(body?.name, "项目名称", 120),
      main_file: "main.tex", latexmkrc: null, engine: config.defaultEngine, created_at: now(), updated_at: now()
    };
    createProjectFiles(config, project.id);
    try {
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.latexmkrc, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      throw error;
    }
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/import", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return reply.code(403).send({ error: "管理员尚未授予你创建项目的权限" });
    }
    const part = await request.file();
    if (!part || !part.filename.toLowerCase().endsWith(".zip")) {
      return reply.code(400).send({ error: "请选择 ZIP 压缩包" });
    }
    const query = request.query as { name?: string };
    const fallbackName = path.basename(part.filename, path.extname(part.filename));
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(query.name || fallbackName, "项目名称", 120),
      main_file: "", latexmkrc: null, engine: config.defaultEngine, created_at: now(), updated_at: now()
    };
    fs.mkdirSync(sourceRoot(config, project.id), { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputRoot(config, project.id), { recursive: true, mode: 0o700 });
    try {
      const extracted = await extractProjectZip(await part.toBuffer(), sourceRoot(config, project.id), config.maxUploadBytes);
      project.main_file = extracted.mainFile;
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`) 
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      throw error;
    }
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/:id/duplicate", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return reply.code(403).send({ error: "管理员尚未授予你创建项目的权限" });
    }
    const { id } = request.params as { id: string };
    const source = accessibleProject(db, id, user);
    if (!source) return reply.code(404).send({ error: "项目不存在" });
    const body = request.body as { name?: unknown } | undefined;
    const requestedName = typeof body?.name === "string" && body.name.trim() ? body.name : `${source.name.slice(0, 115)} (1)`;
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(requestedName, "项目名称", 120),
      main_file: source.main_file, latexmkrc: source.latexmkrc, engine: source.engine, created_at: now(), updated_at: now()
    };
    try {
      duplicateProjectFiles(config, source.id, project.id);
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.latexmkrc, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      throw error;
    }
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { project: projectJson(project, tagsForProject(db, id, user.id)) };
  });

  app.put("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    db.prepare(`INSERT OR IGNORE INTO user_project_archives (user_id, project_id, archived_at) VALUES (?, ?, ?)`)
      .run(user.id, id, now());
    return { ok: true, archived: true };
  });

  app.delete("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    db.prepare("DELETE FROM user_project_archives WHERE user_id = ? AND project_id = ?").run(user.id, id);
    return { ok: true, archived: false };
  });

  app.get("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const rows = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return { words: rows.map((row) => row.word) };
  });

  app.post("/api/projects/:id/spellcheck", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const body = request.body as { source?: unknown } | undefined;
    if (typeof body?.source !== "string") return reply.code(400).send({ error: "源码格式不正确" });
    if (body.source.length > 2_000_000) return reply.code(413).send({ error: "源码过大，无法进行拼写检查" });
    const rows = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    const issues = checkSpelling(body.source, rows.map((row) => row.word));
    return { issues, count: issues.length };
  });

  app.post("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!canEdit(project)) return reply.code(403).send({ error: "没有维护项目词典的权限" });
    const body = request.body as { word?: unknown } | undefined;
    const word = dictionaryWord(body?.word);
    db.prepare(`INSERT OR IGNORE INTO project_dictionary_words (project_id, word, created_by, created_at)
      VALUES (?, ?, ?, ?)`).run(id, word, user.id, now());
    collaboration.signalDictionary(id);
    const words = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return reply.code(201).send({ word, words: words.map((row) => row.word) });
  });

  app.delete("/api/projects/:id/dictionary/:word", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, word: rawWord } = request.params as { id: string; word: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!canEdit(project)) return reply.code(403).send({ error: "没有维护项目词典的权限" });
    const word = dictionaryWord(rawWord);
    db.prepare("DELETE FROM project_dictionary_words WHERE project_id = ? AND word = ?").run(id, word);
    collaboration.signalDictionary(id);
    const words = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return { words: words.map((row) => row.word) };
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return reply.code(403).send({ error: "只有项目所有者可以修改项目设置" });
    const body = request.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? text(body.name, "项目名称", 120) : project.name;
    const mainFile = typeof body.mainFile === "string" ? safeRelativePath(body.mainFile) : project.main_file;
    const engine = typeof body.engine === "string" && config.allowedEngines.includes(body.engine as typeof project.engine)
      ? body.engine as typeof project.engine : project.engine;
    const latexmkrc = body.latexmkrc === null || body.latexmkrc === ""
      ? null
      : typeof body.latexmkrc === "string" ? safeRelativePath(body.latexmkrc) : project.latexmkrc;
    if (!fs.existsSync(resolveSourcePath(config, id, mainFile))) return reply.code(400).send({ error: "主文件不存在" });
    if (latexmkrc && !config.allowProjectLatexmkrc) return reply.code(400).send({ error: "管理员已禁用项目级 latexmkrc" });
    if (latexmkrc && !fs.existsSync(resolveSourcePath(config, id, latexmkrc))) return reply.code(400).send({ error: "latexmkrc 文件不存在" });
    db.prepare("UPDATE projects SET name = ?, main_file = ?, latexmkrc = ?, engine = ?, updated_at = ?, last_modified_by = ? WHERE id = ?")
      .run(name, mainFile, latexmkrc, engine, now(), user.id, id);
    return { project: projectJson(accessibleProject(db, id, user)!, tagsForProject(db, id, user.id)) };
  });

  app.post("/api/projects/:id/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const body = request.body as { tagId?: unknown };
    if (typeof body.tagId !== "string" || !db.prepare("SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?").get(body.tagId, user.id)) {
      return reply.code(404).send({ error: "标签不存在" });
    }
    db.prepare("INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)")
      .run(id, body.tagId, now());
    const tags = tagsForProject(db, id, user.id);
    return reply.code(201).send({ tags, project: projectJson(accessibleProject(db, id, user)!, tags) });
  });

  app.delete("/api/projects/:id/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, tagId } = request.params as { id: string; tagId: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    db.prepare(`DELETE FROM user_project_tag_links WHERE tag_id = ? AND project_id = ?
      AND EXISTS (SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?)`)
      .run(tagId, id, tagId, user.id);
    const tags = tagsForProject(db, id, user.id);
    return { tags, project: projectJson(accessibleProject(db, id, user)!, tags) };
  });

  const requireGitOwner = (projectId: string, user: UserRow) => {
    const project = accessibleProject(db, projectId, user);
    if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
    if (project.owner_id !== user.id) throw Object.assign(new Error("只有项目创建者可以执行 Git 操作"), { statusCode: 403 });
    return project;
  };

  app.get("/api/projects/:id/git", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return { status: await projectGit.status(requireGitOwner(id, user)) };
  });

  app.put("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { token?: unknown };
    if (typeof body.token !== "string") return reply.code(400).send({ error: "请输入 GitHub token" });
    return { status: await projectGit.configureToken(requireGitOwner(id, user), body.token) };
  });

  app.delete("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return { status: await projectGit.removeToken(requireGitOwner(id, user)) };
  });

  app.post("/api/projects/:id/git/repository", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; private?: unknown };
    if (typeof body.name !== "string") return reply.code(400).send({ error: "请输入 GitHub 仓库名称" });
    return { status: await projectGit.createGitHubRepository(requireGitOwner(id, user), body.name.trim(), body.private !== false) };
  });

  app.post("/api/projects/:id/git/commit", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = requireGitOwner(id, user);
    const body = request.body as { message?: unknown };
    collaboration.flushProject(id);
    const commit = await projectGit.commit(project, user, typeof body.message === "string" ? body.message : "");
    return reply.code(201).send({ commit, status: await projectGit.status(project) });
  });

  app.post("/api/projects/:id/git/push", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = requireGitOwner(id, user);
    collaboration.flushProject(id);
    return { status: await projectGit.push(project) };
  });

  app.get("/api/projects/:id/git/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return { commits: await projectGit.history(requireGitOwner(id, user)) };
  });

  app.get("/api/projects/:id/git/diff", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { revision } = request.query as { revision?: string };
    const project = requireGitOwner(id, user);
    collaboration.flushProject(id);
    return projectGit.diff(project, revision);
  });

  app.post("/api/projects/:id/git/checkout", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = requireGitOwner(id, user);
    const body = request.body as { revision?: unknown; force?: unknown };
    if (body.revision !== null && typeof body.revision !== "string") return reply.code(400).send({ error: "请选择要 checkout 的 Git 版本" });
    collaboration.flushProject(id);
    const before = projectTextSnapshot(config, id);
    const revision = await projectGit.checkout(project, body.revision, body.force === true);
    reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
    touchProject(db, id, user.id);
    collaboration.resetProject(id);
    return { revision, status: await projectGit.status(project) };
  });

  app.post("/api/projects/:id/git/discard", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = requireGitOwner(id, user);
    collaboration.flushProject(id);
    const before = projectTextSnapshot(config, id);
    await projectGit.discardChanges(project);
    reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
    touchProject(db, id, user.id);
    collaboration.resetProject(id);
    return { status: await projectGit.status(project) };
  });

  app.get("/api/projects/:id/download", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    collaboration.flushProject(id);
    const archive = createProjectArchive(config, id);
    const filename = `${project.name}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition(filename, "attachment"));
    return reply.send(archive.outputStream);
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return reply.code(403).send({ error: "只有项目所有者可以删除项目" });
    collaboration.closeProject(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    removeProjectDirectory(config, id);
    return { ok: true };
  });

  app.get("/api/projects/:id/files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    return { files: listProjectFiles(config, id) };
  });

  app.get("/api/projects/:id/completions", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    collaboration.flushProject(id);
    return { index: buildLatexCompletionIndex(config, id) };
  });

  app.post("/api/projects/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编辑权限" });
    const body = request.body as { path?: unknown };
    const folderPath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    const absolute = resolveSourcePath(config, id, folderPath);
    if (fs.existsSync(absolute)) return reply.code(409).send({ error: "同名文件或目录已存在" });
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    touchProject(db, id, user.id);
    return reply.code(201).send({ ok: true, path: folderPath });
  });

  app.patch("/api/projects/:id/path", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编辑权限" });
    const body = request.body as { source?: unknown; destinationDirectory?: unknown };
    const source = safeRelativePath(typeof body.source === "string" ? body.source : "");
    const destinationDirectory = body.destinationDirectory === "" ? ""
      : safeRelativePath(typeof body.destinationDirectory === "string" ? body.destinationDirectory : "");
    const sourceAbsolute = resolveSourcePath(config, id, source);
    if (!fs.existsSync(sourceAbsolute)) return reply.code(404).send({ error: "要移动的文件或目录不存在" });
    const sourceStat = fs.statSync(sourceAbsolute);
    if (sourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
      return reply.code(400).send({ error: "不能把目录移动到自身内部" });
    }
    const destinationRoot = destinationDirectory
      ? resolveSourcePath(config, id, destinationDirectory)
      : sourceRoot(config, id);
    if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
      return reply.code(404).send({ error: "目标目录不存在" });
    }
    const destination = destinationDirectory
      ? `${destinationDirectory}/${path.posix.basename(source)}`
      : path.posix.basename(source);
    if (destination === source) return { ok: true, path: source };
    const destinationAbsolute = resolveSourcePath(config, id, destination);
    if (fs.existsSync(destinationAbsolute)) return reply.code(409).send({ error: "目标目录中存在同名文件或目录" });

    collaboration.flushProject(id);
    fs.renameSync(sourceAbsolute, destinationAbsolute);
    db.exec("BEGIN IMMEDIATE");
    try {
      const mainFile = movedProjectPath(project.main_file, source, destination)!;
      const latexmkrc = movedProjectPath(project.latexmkrc, source, destination);
      const changedAt = now();
      db.prepare(`UPDATE projects SET main_file = ?, latexmkrc = ?, updated_at = ?, last_modified_by = ? WHERE id = ?`)
        .run(mainFile, latexmkrc, changedAt, user.id, id);
      const comments = db.prepare("SELECT id, file_path FROM comments WHERE project_id = ?").all(id) as Array<{ id: string; file_path: string }>;
      const updateComment = db.prepare("UPDATE comments SET file_path = ?, updated_at = ? WHERE id = ?");
      for (const comment of comments) {
        const nextPath = movedProjectPath(comment.file_path, source, destination);
        if (nextPath !== comment.file_path) updateComment.run(nextPath, changedAt, comment.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      fs.renameSync(destinationAbsolute, sourceAbsolute);
      throw error;
    }
    collaboration.movePath(id, source, destination, user.id);
    return { ok: true, path: destination };
  });

  app.get("/api/projects/:id/file/raw", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const query = request.query as { path?: string; download?: string };
    const filePath = safeRelativePath(query.path ?? "");
    const absolute = resolveSourcePath(config, id, filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return reply.code(404).send({ error: "文件不存在" });
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
    reply.header("Content-Length", fs.statSync(absolute).size);
    return reply.send(fs.createReadStream(absolute));
  });

  app.get("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const absolute = resolveSourcePath(config, id, filePath ?? "");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return reply.code(404).send({ error: "文件不存在" });
    if (fs.statSync(absolute).size > 5 * 1024 * 1024) return reply.code(413).send({ error: "文件过大，不能作为文本打开" });
    return { path: safeRelativePath(filePath ?? ""), content: fs.readFileSync(absolute, "utf8") };
  });

  app.put("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编辑权限" });
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") throw new Error("文件内容格式不正确");
    if (Buffer.byteLength(body.content, "utf8") > config.maxUploadBytes) {
      return reply.code(413).send({ error: `单个文件不能超过 ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB` });
    }
    const absolute = resolveSourcePath(config, id, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const previousContent = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
    reanchorFileComments(db, id, filePath, previousContent, body.content);
    fs.writeFileSync(absolute, body.content, { encoding: "utf8", mode: 0o600 });
    touchProject(db, id, user.id);
    collaboration.updateFile(id, filePath, body.content, user.id);
    return { ok: true, comments: commentsForFile(db, config, id, filePath) };
  });

  app.delete("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编辑权限" });
    const relative = safeRelativePath(filePath ?? "");
    if (relative === project.main_file) return reply.code(400).send({ error: "不能删除当前主文件" });
    fs.rmSync(resolveSourcePath(config, id, relative), { recursive: true, force: true });
    touchProject(db, id, user.id);
    collaboration.removePath(id, relative);
    return { ok: true };
  });

  app.post("/api/projects/:id/upload", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编辑权限" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "没有收到上传文件" });
    const { directory } = request.query as { directory?: string };
    const relative = safeRelativePath(directory ? `${safeRelativePath(directory)}/${part.filename}` : part.filename);
    const absolute = resolveSourcePath(config, id, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const uploaded = await part.toBuffer();
    fs.writeFileSync(absolute, uploaded, { mode: 0o600 });
    touchProject(db, id, user.id);
    collaboration.updateFile(id, relative, uploaded.toString("utf8"), user.id);
    return reply.code(201).send({ ok: true, path: relative });
  });

  app.get("/api/projects/:id/members", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const members = db.prepare(`SELECT pm.user_id AS id, u.username, u.display_name AS displayName, pm.permission
      FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.username`).all(id);
    return { members };
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return reply.code(403).send({ error: "只有项目所有者可以管理成员" });
    if (userId === project.owner_id) return reply.code(400).send({ error: "项目所有者不能作为成员添加" });
    const body = request.body as { permission?: unknown };
    const permission = body.permission === "edit" ? "edit" : "read";
    db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`)
      .run(id, userId, permission, now());
    touchProject(db, id, user.id);
    return { ok: true };
  });

  app.delete("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return reply.code(403).send({ error: "只有项目所有者可以管理成员" });
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId);
    touchProject(db, id, user.id);
    return { ok: true };
  });

  app.get("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const relative = safeRelativePath(filePath ?? "");
    return { comments: commentsForFile(db, config, id, relative) };
  });

  app.post("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const body = request.body as Record<string, unknown>;
    const createdAt = now();
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    collaboration.flushProject(id);
    const absolute = resolveSourcePath(config, id, filePath);
    if (!fs.existsSync(absolute)) return reply.code(404).send({ error: "批注文件不存在" });
    const source = fs.readFileSync(absolute, "utf8");
    if (!Number.isInteger(body.startOffset) || !Number.isInteger(body.endOffset)) {
      return reply.code(400).send({ error: "批注缺少有效的源码区间" });
    }
    const anchor = createSourceAnchor(source, Number(body.startOffset), Number(body.endOffset));
    const comment = {
      id: randomUUID(), filePath,
      content: text(body.content, "批注", 5000)
    };
    db.prepare(`INSERT INTO comments
      (id, project_id, file_path, author_id, selected_text, start_offset, end_offset,
       context_before, context_after, orphaned, start_line, end_line, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(
        comment.id, id, comment.filePath, user.id, anchor.selectedText, anchor.startOffset, anchor.endOffset,
        anchor.contextBefore, anchor.contextAfter, offsetToLine(source, anchor.startOffset),
        offsetToLine(source, anchor.endOffset), comment.content, createdAt, createdAt
      );
    const created = commentsForFile(db, config, id, filePath).find((item) => item.id === comment.id);
    collaboration.signalComments(id);
    return reply.code(201).send({ comment: created });
  });

  app.post("/api/projects/:id/comments/:commentId/replies", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    if (!db.prepare("SELECT 1 FROM comments WHERE id = ? AND project_id = ?").get(commentId, id)) {
      return reply.code(404).send({ error: "批注不存在" });
    }
    const body = request.body as { content?: unknown };
    const createdAt = now();
    const replyId = randomUUID();
    db.prepare(`INSERT INTO comment_replies (id, comment_id, author_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(replyId, commentId, user.id, text(body.content, "回复", 5000), createdAt, createdAt);
    const created = repliesForComment(db, commentId).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return reply.code(201).send({ reply: created });
  });

  app.patch("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return reply.code(404).send({ error: "批注不存在" });
    const body = request.body as { resolved?: unknown; content?: unknown };
    const changedAt = now();
    let changed = false;
    if (typeof body.content === "string") {
      if (comment.author_id !== user.id) return reply.code(403).send({ error: "只能编辑自己的批注" });
      db.prepare("UPDATE comments SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?")
        .run(text(body.content, "批注", 5000), changedAt, changedAt, commentId);
      changed = true;
    }
    if (typeof body.resolved === "boolean") {
      db.prepare("UPDATE comments SET resolved = ?, updated_at = ? WHERE id = ?")
        .run(body.resolved ? 1 : 0, changedAt, commentId);
      changed = true;
    }
    if (!changed) return reply.code(400).send({ error: "没有可更新的批注内容" });
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.delete("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return reply.code(404).send({ error: "批注不存在" });
    if (comment.author_id !== user.id) return reply.code(403).send({ error: "只能删除自己的批注" });
    db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.patch("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return reply.code(404).send({ error: "回复不存在" });
    if (commentReply.author_id !== user.id) return reply.code(403).send({ error: "只能编辑自己的回复" });
    const body = request.body as { content?: unknown };
    const changedAt = now();
    db.prepare("UPDATE comment_replies SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?")
      .run(text(body.content, "回复", 5000), changedAt, changedAt, replyId);
    const updated = repliesForComment(db, commentId).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return { reply: updated };
  });

  app.delete("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    if (!accessibleProject(db, id, user)) return reply.code(404).send({ error: "项目不存在" });
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return reply.code(404).send({ error: "回复不存在" });
    if (commentReply.author_id !== user.id) return reply.code(403).send({ error: "只能删除自己的回复" });
    db.prepare("DELETE FROM comment_replies WHERE id = ?").run(replyId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.get("/api/projects/:id/compile/latest", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const latest = db.prepare(`SELECT run.id, run.status, run.log, run.created_at, run.finished_at,
      run.requested_by, user.username AS requested_by_username, user.display_name AS requested_by_name
      FROM compile_runs run LEFT JOIN users user ON user.id = run.requested_by
      WHERE run.project_id = ?
      ORDER BY CASE run.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, run.created_at DESC LIMIT 1`).get(id) as {
        id: string; status: string; log: string; created_at: string; finished_at: string | null;
        requested_by: string | null; requested_by_username: string | null; requested_by_name: string | null;
      } | undefined;
    const latestSuccess = db.prepare(`SELECT id, finished_at FROM compile_runs
      WHERE project_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`).get(id) as {
        id: string; finished_at: string | null;
      } | undefined;
    const pdf = availablePdf(config, id, project.main_file);
    const published = publishedCompileArtifacts(config, id);
    const publishedRun = published ? db.prepare(`SELECT id, finished_at FROM compile_runs
      WHERE id = ? AND project_id = ? AND status = 'succeeded'`).get(published.runId, id) as {
        id: string; finished_at: string | null;
      } | undefined : undefined;
    const pdfVersion = published?.runId ?? latestSuccess?.id ?? pdf?.version;
    return {
      latestRun: latest ? {
        id: latest.id, status: latest.status, log: latest.log,
        createdAt: latest.created_at, finishedAt: latest.finished_at,
        requestedBy: latest.requested_by ? {
          id: latest.requested_by,
          username: latest.requested_by_username ?? "deleted-user",
          name: latest.requested_by_name ?? "Deleted User"
        } : null
      } : null,
      hasPdf: Boolean(pdf),
      pdfUrl: pdf ? `/api/projects/${id}/pdf?run=${encodeURIComponent(pdfVersion ?? pdf.version)}` : null,
      pdfCompiledAt: publishedRun?.finished_at ?? latestSuccess?.finished_at ?? null
    };
  });

  app.get("/api/projects/:id/compile/artifacts", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const published = publishedCompileArtifacts(config, id);
    const query = request.query as { path?: string; download?: string };
    if (!query.path) return { runId: published?.runId ?? null, artifacts: published ? listCompileArtifacts(published.output) : [] };
    if (!published) return reply.code(404).send({ error: "尚无可用的编译产物" });
    const relative = safeRelativePath(query.path);
    const absolute = path.join(published.output, relative);
    const outputDirectory = path.resolve(published.output);
    const resolved = path.resolve(absolute);
    if (!resolved.startsWith(`${outputDirectory}${path.sep}`)
      || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return reply.code(404).send({ error: "编译产物不存在" });
    }
    const stat = fs.statSync(resolved);
    if (query.download === "1") {
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", contentDisposition(path.basename(relative), "attachment"));
      reply.header("Content-Length", stat.size);
      return reply.send(fs.createReadStream(resolved));
    }
    if (stat.size > 2 * 1024 * 1024 || !isTextCompileArtifact(relative)) {
      return reply.code(415).send({ error: "该产物不能作为文本预览，请下载后查看" });
    }
    return { path: relative, content: fs.readFileSync(resolved, "utf8") };
  });

  app.get("/api/projects/:id/sync/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const query = request.query as { path?: string; line?: string; column?: string };
    const sourcePath = safeRelativePath(query.path ?? "");
    const line = Number(query.line);
    const column = Number(query.column ?? 1);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      return reply.code(400).send({ error: "源码位置无效" });
    }
    if (!fs.existsSync(resolveSourcePath(config, id, sourcePath))) {
      return reply.code(404).send({ error: "源码文件不存在" });
    }
    const artifacts = syncArtifacts(config, id, project.main_file);
    if (!artifacts) return reply.code(409).send({ error: "项目尚无可用的 SyncTeX 数据，请重新编译" });
    return await sourceToPdf(artifacts.source, artifacts.pdf, sourcePath, line, column);
  });

  app.get("/api/projects/:id/sync/source", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const query = request.query as { page?: string; x?: string; y?: string };
    const page = Number(query.page);
    const x = Number(query.x);
    const y = Number(query.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
      return reply.code(400).send({ error: "PDF 位置无效" });
    }
    const artifacts = syncArtifacts(config, id, project.main_file);
    if (!artifacts) return reply.code(409).send({ error: "项目尚无可用的 SyncTeX 数据，请重新编译" });
    const location = await pdfToSource(artifacts.source, artifacts.pdf, page, x, y);
    const sourceDirectory = path.resolve(artifacts.source);
    const relative = path.relative(sourceDirectory, path.resolve(location.input));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return reply.code(400).send({ error: "SyncTeX 返回了项目外部的源码路径" });
    }
    return { path: safeRelativePath(relative.replaceAll(path.sep, "/")), line: location.line, column: location.column };
  });

  app.post("/api/projects/:id/compile", async (request, reply) => {
    const requestStartedAt = performance.now();
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return reply.code(403).send({ error: "没有编译权限" });
    collaboration.flushProject(id);

    const runId = randomUUID();
    const snapshotStartedAt = performance.now();
    const snapshot = captureCompileSnapshot(config, id, runId, {
      mainFile: project.main_file,
      engine: project.engine,
      latexmkrc: project.latexmkrc,
      extraArgs: config.extraArgs
    });
    const snapshotMs = performance.now() - snapshotStartedAt;

    // Reuse the last published PDF only when the complete source and compiler
    // settings revision is identical. A failed/newer run, or an active run,
    // deliberately prevents this fast path so users can retry a build.
    const published = publishedCompileArtifacts(config, id);
    const publishedRun = published ? db.prepare(`SELECT id, status, log, finished_at
      FROM compile_runs WHERE id = ? AND project_id = ?`).get(published.runId, id) as {
        id: string; status: string; log: string; finished_at: string | null;
      } | undefined : undefined;
    const latestRun = db.prepare(`SELECT id, status FROM compile_runs
      WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(id) as {
        id: string; status: string;
      } | undefined;
    const activeRun = db.prepare(`SELECT 1 AS active FROM compile_runs
      WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(id);
    if (!activeRun && published && publishedRun?.status === "succeeded"
      && latestRun?.id === publishedRun.id && snapshot.revision === published.revision) {
      discardCompileSnapshot(snapshot);
      const requestMs = performance.now() - requestStartedAt;
      reply.header("Server-Timing", `snapshot;dur=${timingDuration(snapshotMs)}, total;dur=${timingDuration(requestMs)}`);
      return {
        runId: published.runId,
        ok: true,
        skipped: true,
        log: publishedRun.log ?? "",
        pdfUrl: `/api/projects/${id}/pdf?run=${encodeURIComponent(published.runId)}`,
        pdfCompiledAt: publishedRun.finished_at,
        timings: { snapshotMs, requestMs }
      };
    }

    db.prepare("INSERT INTO compile_runs (id, project_id, requested_by, status, created_at) VALUES (?, ?, ?, 'queued', ?)")
      .run(runId, id, user.id, now());
    const requestedBy = { id: user.id, username: user.username, name: user.display_name };
    let phase: "queued" | "running" | "succeeded" | "failed" = "queued";
    const broadcast = () => collaboration.signalCompileState(id, { runId, status: phase, requestedBy, updatedAt: now() });
    const result = await compileCoordinator.request({
      projectId: id,
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
          compiled = await compileProject(config, snapshot, project.main_file, project.engine, project.latexmkrc);
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
      runId: result.runId, ok: result.ok, skipped: false, log: result.log,
      pdfUrl: result.ok ? `/api/projects/${id}/pdf?run=${result.runId}` : null,
      pdfCompiledAt: result.ok ? completed?.finished_at ?? null : null,
      timings
    };
  });

  app.get("/api/projects/:id/pdf", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const query = request.query as { download?: string };
    const downloading = query.download === "1";
    const artifact = availablePdf(config, id, project.main_file);
    if (!artifact) return reply.code(404).send({ error: "尚未生成 PDF" });
    const pdf = artifact.path;
    const stat = fs.statSync(pdf);
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    reply.header("Content-Type", "application/pdf");
    const filename = downloading ? `${project.name}-${pdfDownloadTimestamp()}.pdf` : `${project.name}.pdf`;
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

  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/") && request.url !== "/api/auth/login" && request.url !== "/api/health" && request.url !== "/api/config") {
      const token = request.cookies.texlite_session;
      if (token && !currentUser(request, db)) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
      }
    }
  });

  app.addHook("onClose", async () => collaboration.destroy());

  if (fs.existsSync(config.clientDir)) {
    await app.register(staticPlugin, { root: config.clientDir, wildcard: false });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "接口不存在" });
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html");
    });
  }

  return app;
}
