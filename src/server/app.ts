import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
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
  listPublishedCompileArtifacts,
  pruneOrphanedCompileRuns
} from "./compiler.js";
import { createSourceAnchor, offsetToLine, reanchorFileComments } from "./anchors.js";
import { extractProjectZip } from "./zip.js";
import { createProjectArchive } from "./archive.js";
import { CollaborationService } from "./collaboration.js";
import { ProjectGitService } from "./git.js";
import { LatexCompletionService } from "./latexCompletion.js";
import { ProjectHistoryService, type HistoryReason } from "./history.js";
import { buildProjectOutline } from "./projectOutline.js";
import { replaceProject, searchProject } from "./projectSearch.js";
import { MetricRegistry } from "./metrics.js";
import { compileMainFile } from "./compileArtifacts.js";
import { apiError, contentDisposition } from "./http.js";
import { registerCompileRoutes } from "./routes/compile.js";

const now = (): string => new Date().toISOString();
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
  const metrics = new MetricRegistry(200);
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const history = new ProjectHistoryService(config, db);
  const latexCompletions = new LatexCompletionService(config);
  const recordHistory = (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => {
    try { return history.record(projectId, userId, reason, paths); }
    catch (error) {
      app.log.error({ err: error, projectId }, "Failed to record project history");
      return null;
    }
  };
  const collaboration = new CollaborationService(config, db, ({ projectId, userId, paths, durationMs }) => {
    metrics.record("collaboration.persist", durationMs);
    recordHistory(projectId, userId, "autosave", paths);
  });
  const projectGit = new ProjectGitService(config, db, options.githubFetch);
  db.prepare(`UPDATE compile_runs SET status = 'failed',
    log = CASE WHEN log = '' THEN 'Server restarted before compilation finished.' ELSE log END,
    finished_at = ? WHERE status IN ('queued', 'running')`).run(now());
  const pruneCompileRuns = (projectId: string): void => {
    const keep = new Set(listPublishedCompileArtifacts(config, projectId).map((artifact) => artifact.runId));
    const completed = db.prepare(`SELECT id, main_file FROM compile_runs
      WHERE project_id = ? AND status NOT IN ('queued', 'running')
      ORDER BY created_at DESC, rowid DESC`).all(projectId) as Array<{ id: string; main_file: string }>;
    const latestTargets = new Set<string>();
    for (const run of completed) {
      if (!latestTargets.has(run.main_file)) {
        latestTargets.add(run.main_file);
        keep.add(run.id);
      }
    }
    const remove = db.prepare("DELETE FROM compile_runs WHERE id = ?");
    for (const run of completed) if (!keep.has(run.id)) remove.run(run.id);
  };
  for (const row of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    history.enforceRetention(row.id);
    pruneCompileRuns(row.id);
    pruneOrphanedCompileRuns(config, row.id);
  }
  app.addHook("onClose", async () => { eventLoopDelay.disable(); });
  await app.register(cookie, { hook: "onRequest" });
  await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes }
  });
  const requestStarts = new WeakMap<object, number>();
  app.addHook("onRequest", async (request) => { requestStarts.set(request, performance.now()); });
  app.addHook("onResponse", async (request) => {
    const startedAt = requestStarts.get(request);
    if (startedAt === undefined) return;
    const route = request.routeOptions.url;
    if (!route) return;
    const metric = ({
      "/api/projects/:id": "workspace.project",
      "/api/projects/:id/files": "workspace.files",
      "/api/projects/:id/compile/latest": "workspace.compileState"
    } as Record<string, string>)[route];
    if (metric) metrics.record(metric, performance.now() - startedAt);
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400;
    const message = error instanceof Error ? error.message : "请求格式不正确";
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code : status >= 500 ? "SERVER_ERROR" : "REQUEST_INVALID";
    void reply.code(status >= 500 ? 500 : status).send({
      code, error: status >= 500 ? "服务器内部错误" : message
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
    try { collaboration.connect(socket, id, user); }
    finally { metrics.record("collaboration.connect", performance.now() - startedAt); }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const username = text(body?.username, "用户名", 64);
    const password = typeof body?.password === "string" ? body.password : "";
    const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      return apiError(reply, 401, "AUTH_INVALID", "用户名或密码错误");
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
      return apiError(reply, 400, "CURRENT_PASSWORD_INVALID", "当前密码错误");
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
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND", "用户不存在");
    const body = request.body as Record<string, unknown>;
    const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : target.role;
    const disabled = typeof body.disabled === "boolean" ? Number(body.disabled) : target.disabled;
    const canCreateProjects = typeof body.canCreateProjects === "boolean"
      ? Number(body.canCreateProjects) : target.can_create_projects;
    if (target.role === "admin" && (!role || role !== "admin" || disabled) && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN", "不能禁用或降级最后一个管理员");
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
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND", "用户不存在");
    if (target.id === admin.id) return apiError(reply, 400, "SELF_DELETE_FORBIDDEN", "不能删除当前登录的管理员");
    if (target.role === "admin" && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN", "不能删除最后一个管理员");
    }
    const owned = db.prepare("SELECT id FROM projects WHERE owner_id = ?").all(id) as Array<{ id: string }>;
    for (const project of owned) {
      if (body.deleteProjects) collaboration.closeProject(project.id);
      else collaboration.flushProject(project.id);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (body.deleteProjects) {
        db.prepare("DELETE FROM projects WHERE owner_id = ?").run(id);
      } else {
        db.prepare("UPDATE project_git_settings SET token_ciphertext = NULL, github_login = NULL, updated_at = ? WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)")
          .run(now(), id);
        db.prepare("DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)")
          .run(admin.id, id);
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
    } else {
      for (const project of owned) collaboration.resetProject(project.id);
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
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN", "管理员尚未授予你创建项目的权限");
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
    recordHistory(project.id, user.id, "initial");
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/import", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN", "管理员尚未授予你创建项目的权限");
    }
    const part = await request.file();
    if (!part || !part.filename.toLowerCase().endsWith(".zip")) {
      return apiError(reply, 400, "ZIP_ONLY", "请选择 ZIP 压缩包");
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
    recordHistory(project.id, user.id, "initial");
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/:id/duplicate", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN", "管理员尚未授予你创建项目的权限");
    }
    const { id } = request.params as { id: string };
    const source = accessibleProject(db, id, user);
    if (!source) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
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
    recordHistory(project.id, user.id, "initial");
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
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    return { project: projectJson(project, tagsForProject(db, id, user.id)) };
  });

  app.get("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const { limit: limitInput } = request.query as { limit?: string };
    const limit = Number.parseInt(limitInput ?? "100", 10);
    return {
      versions: history.list(id, Number.isFinite(limit) ? limit : 100),
      stats: project.permission === "owner" ? history.stats(id) : null
    };
  });

  app.get("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const version = history.version(versionId, id);
    const manifest = history.manifest(id, versionId);
    if (!version || !manifest) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND", "历史版本不存在");
    return {
      version,
      settings: manifest.settings,
      files: Object.entries(manifest.files).map(([filePath, file]) => ({ path: filePath, size: file.size })).sort((left, right) => left.path.localeCompare(right.path))
    };
  });

  app.get("/api/projects/:id/history/:versionId/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { path?: string; against?: string };
    const filePath = safeRelativePath(query.path ?? "");
    const historical = history.readTextFile(id, versionId, filePath);
    if (historical === null) return apiError(reply, 415, "HISTORY_FILE_PREVIEW_UNSUPPORTED", "该历史文件不存在或不能作为文本比较", { path: filePath });
    let comparison = "";
    if (query.against) {
      comparison = history.readTextFile(id, query.against, filePath) ?? "";
    } else {
      const current = resolveSourcePath(config, id, filePath);
      if (fs.existsSync(current) && fs.statSync(current).isFile() && fs.statSync(current).size <= 2 * 1024 * 1024) {
        comparison = fs.readFileSync(current, "utf8");
      }
    }
    return { path: filePath, historical, comparison, against: query.against ?? "current" };
  });

  app.patch("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { label?: unknown };
    const label = body.label === null || body.label === "" ? null : text(body.label, "版本标签", 80);
    const version = history.setLabel(id, versionId, label);
    if (!version) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND", "历史版本不存在");
    return { version, stats: project.permission === "owner" ? history.stats(id) : null };
  });

  app.delete("/api/projects/:id/history/:versionId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以删除历史版本");
    collaboration.flushProject(id);
    if (!history.deleteVersion(id, versionId)) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND", "历史版本不存在");
    return { ok: true, stats: history.stats(id) };
  });

  app.delete("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以清空历史版本");
    collaboration.flushProject(id);
    history.clear(id);
    return { ok: true, stats: history.stats(id) };
  });

  app.post("/api/projects/:id/history/:versionId/restore", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown } | undefined;
    const filePath = typeof body?.path === "string" ? safeRelativePath(body.path) : undefined;
    collaboration.flushProject(id);
    recordHistory(id, user.id, "checkpoint");
    const before = projectTextSnapshot(config, id);
    const restored = history.restore(id, versionId, filePath);
    reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
    touchProject(db, id, user.id);
    recordHistory(id, user.id, "restore", filePath ? [filePath] : undefined);
    collaboration.resetProject(id);
    return { ok: true, restoredPaths: restored.restoredPaths, project: projectJson(accessibleProject(db, id, user)!, tagsForProject(db, id, user.id)) };
  });

  app.put("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    db.prepare(`INSERT OR IGNORE INTO user_project_archives (user_id, project_id, archived_at) VALUES (?, ?, ?)`)
      .run(user.id, id, now());
    return { ok: true, archived: true };
  });

  app.delete("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    db.prepare("DELETE FROM user_project_archives WHERE user_id = ? AND project_id = ?").run(user.id, id);
    return { ok: true, archived: false };
  });

  app.get("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const rows = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return { words: rows.map((row) => row.word) };
  });

  app.post("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN", "没有维护项目词典的权限");
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
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN", "没有维护项目词典的权限");
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
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以修改项目设置");
    const body = request.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? text(body.name, "项目名称", 120) : project.name;
    const mainFile = typeof body.mainFile === "string" ? safeRelativePath(body.mainFile) : project.main_file;
    const engine = typeof body.engine === "string" && config.allowedEngines.includes(body.engine as typeof project.engine)
      ? body.engine as typeof project.engine : project.engine;
    const latexmkrc = body.latexmkrc === null || body.latexmkrc === ""
      ? null
      : typeof body.latexmkrc === "string" ? safeRelativePath(body.latexmkrc) : project.latexmkrc;
    if (!fs.existsSync(resolveSourcePath(config, id, mainFile))) return apiError(reply, 400, "MAIN_FILE_NOT_FOUND", "主文件不存在", { path: mainFile });
    if (latexmkrc && !config.allowProjectLatexmkrc) return apiError(reply, 400, "LATEXMKRC_DISABLED", "管理员已禁用项目级 latexmkrc");
    if (latexmkrc && !fs.existsSync(resolveSourcePath(config, id, latexmkrc))) return apiError(reply, 400, "LATEXMKRC_NOT_FOUND", "latexmkrc 文件不存在", { path: latexmkrc });
    db.prepare("UPDATE projects SET name = ?, main_file = ?, latexmkrc = ?, engine = ?, updated_at = ?, last_modified_by = ? WHERE id = ?")
      .run(name, mainFile, latexmkrc, engine, now(), user.id, id);
    recordHistory(id, user.id, "settings", []);
    return { project: projectJson(accessibleProject(db, id, user)!, tagsForProject(db, id, user.id)) };
  });

  app.post("/api/projects/:id/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const body = request.body as { tagId?: unknown };
    if (typeof body.tagId !== "string" || !db.prepare("SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?").get(body.tagId, user.id)) {
      return apiError(reply, 404, "TAG_NOT_FOUND", "标签不存在");
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
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    db.prepare(`DELETE FROM user_project_tag_links WHERE tag_id = ? AND project_id = ?
      AND EXISTS (SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?)`)
      .run(tagId, id, tagId, user.id);
    const tags = tagsForProject(db, id, user.id);
    return { tags, project: projectJson(accessibleProject(db, id, user)!, tags) };
  });

  const requireGitOwner = (projectId: string, user: UserRow) => {
    const project = accessibleProject(db, projectId, user);
    if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    if (project.owner_id !== user.id) throw Object.assign(new Error("只有项目创建者可以执行 Git 操作"), { statusCode: 403, code: "PROJECT_OWNER_ONLY" });
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
    if (typeof body.token !== "string") return apiError(reply, 400, "GIT_TOKEN_INVALID", "请输入 GitHub token");
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
    if (typeof body.name !== "string") return apiError(reply, 400, "GIT_REPOSITORY_NAME_INVALID", "请输入 GitHub 仓库名称");
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
    if (body.revision !== null && typeof body.revision !== "string") return apiError(reply, 400, "GIT_REVISION_INVALID", "请选择要 checkout 的 Git 版本");
    collaboration.flushProject(id);
    recordHistory(id, user.id, "checkpoint");
    const before = projectTextSnapshot(config, id);
    const revision = await projectGit.checkout(project, body.revision, body.force === true);
    reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
    touchProject(db, id, user.id);
    recordHistory(id, user.id, "git");
    collaboration.resetProject(id);
    return { revision, status: await projectGit.status(project) };
  });

  app.post("/api/projects/:id/git/discard", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = requireGitOwner(id, user);
    collaboration.flushProject(id);
    recordHistory(id, user.id, "checkpoint");
    const before = projectTextSnapshot(config, id);
    await projectGit.discardChanges(project);
    reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
    touchProject(db, id, user.id);
    recordHistory(id, user.id, "git");
    collaboration.resetProject(id);
    return { status: await projectGit.status(project) };
  });

  app.get("/api/projects/:id/download", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
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
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_DELETE_FORBIDDEN", "只有项目所有者可以删除项目");
    collaboration.closeProject(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    removeProjectDirectory(config, id);
    return { ok: true };
  });

  app.get("/api/projects/:id/files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    return { files: listProjectFiles(config, id) };
  });

  app.get("/api/projects/:id/outline", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { mainFile?: string };
    const mainFile = compileMainFile(config, id, project.main_file, query.mainFile);
    if (!mainFile) return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档");
    collaboration.flushProject(id);
    const startedAt = performance.now();
    try { return { outline: buildProjectOutline(config, id, mainFile), mainFile }; }
    finally { metrics.record("outline.build", performance.now() - startedAt); }
  });

  app.get("/api/projects/:id/search", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { q?: string; caseSensitive?: string; wholeWord?: string };
    collaboration.flushProject(id);
    const startedAt = performance.now();
    try {
      return await searchProject(config, id, {
        query: query.q ?? "",
        caseSensitive: query.caseSensitive === "1",
        wholeWord: query.wholeWord === "1"
      });
    } finally { metrics.record("search.project", performance.now() - startedAt); }
  });

  app.post("/api/projects/:id/search/replace", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { query?: unknown; replacement?: unknown; caseSensitive?: unknown; wholeWord?: unknown };
    if (typeof body.query !== "string" || typeof body.replacement !== "string" || body.replacement.length > 100_000) {
      return apiError(reply, 400, "SEARCH_QUERY_INVALID", "搜索或替换内容格式不正确");
    }
    collaboration.flushProject(id);
    const changed = await replaceProject(config, id, {
      query: body.query,
      caseSensitive: body.caseSensitive === true,
      wholeWord: body.wholeWord === true
    }, body.replacement);
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
  });

  app.get("/api/projects/:id/completions", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    collaboration.flushProject(id);
    const startedAt = performance.now();
    try { return { index: await latexCompletions.build(id) }; }
    finally { metrics.record("completions.build", performance.now() - startedAt); }
  });

  app.post("/api/projects/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown };
    const folderPath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    const absolute = resolveSourcePath(config, id, folderPath);
    if (fs.existsSync(absolute)) return apiError(reply, 409, "PATH_EXISTS", "同名文件或目录已存在", { path: folderPath });
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    touchProject(db, id, user.id);
    return reply.code(201).send({ ok: true, path: folderPath });
  });

  app.patch("/api/projects/:id/path", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { source?: unknown; destinationDirectory?: unknown };
    const source = safeRelativePath(typeof body.source === "string" ? body.source : "");
    const destinationDirectory = body.destinationDirectory === "" ? ""
      : safeRelativePath(typeof body.destinationDirectory === "string" ? body.destinationDirectory : "");
    const sourceAbsolute = resolveSourcePath(config, id, source);
    if (!fs.existsSync(sourceAbsolute)) return apiError(reply, 404, "PATH_NOT_FOUND", "要移动的文件或目录不存在", { path: source });
    const sourceStat = fs.statSync(sourceAbsolute);
    if (sourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
      return apiError(reply, 400, "MOVE_INTO_SELF", "不能把目录移动到自身内部", { path: source });
    }
    const destinationRoot = destinationDirectory
      ? resolveSourcePath(config, id, destinationDirectory)
      : sourceRoot(config, id);
    if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
      return apiError(reply, 404, "DIRECTORY_NOT_FOUND", "目标目录不存在", { path: destinationDirectory });
    }
    const destination = destinationDirectory
      ? `${destinationDirectory}/${path.posix.basename(source)}`
      : path.posix.basename(source);
    if (destination === source) return { ok: true, path: source };
    const destinationAbsolute = resolveSourcePath(config, id, destination);
    if (fs.existsSync(destinationAbsolute)) return apiError(reply, 409, "PATH_EXISTS", "目标目录中存在同名文件或目录", { path: destination });

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
    recordHistory(id, user.id, "file", [source, destination]);
    return { ok: true, path: destination };
  });

  app.get("/api/projects/:id/file/raw", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { path?: string; download?: string };
    const filePath = safeRelativePath(query.path ?? "");
    const absolute = resolveSourcePath(config, id, filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return apiError(reply, 404, "FILE_NOT_FOUND", "文件不存在", { path: filePath });
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const absolute = resolveSourcePath(config, id, filePath ?? "");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return apiError(reply, 404, "FILE_NOT_FOUND", "文件不存在", { path: filePath });
    if (fs.statSync(absolute).size > 5 * 1024 * 1024) return apiError(reply, 413, "FILE_TOO_LARGE", "文件过大，不能作为文本打开", { path: filePath });
    return { path: safeRelativePath(filePath ?? ""), content: fs.readFileSync(absolute, "utf8") };
  });

  // Creating a file is intentionally separate from updating one.  The editor
  // uses PUT for autosaves, but a user action such as "New file" must never
  // silently replace an existing file.
  app.post("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") throw new Error("文件内容格式不正确");
    if (Buffer.byteLength(body.content, "utf8") > config.maxUploadBytes) {
      return apiError(reply, 413, "FILE_TOO_LARGE", `单个文件不能超过 ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB`, { path: filePath, size: Math.floor(config.maxUploadBytes / 1024 / 1024) });
    }
    const absolute = resolveSourcePath(config, id, filePath);
    try {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    } catch (error) {
      if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return apiError(reply, 409, "PATH_EXISTS", "目标路径中的目录部分已被文件占用", { path: filePath });
      }
      throw error;
    }
    try {
      fs.writeFileSync(absolute, body.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return apiError(reply, 409, "FILE_EXISTS", "同名文件或目录已存在", { path: filePath });
      }
      throw error;
    }
    touchProject(db, id, user.id);
    collaboration.updateFile(id, filePath, body.content, user.id);
    recordHistory(id, user.id, "file", [filePath]);
    return reply.code(201).send({ ok: true, path: filePath, comments: commentsForFile(db, config, id, filePath) });
  });

  app.put("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") throw new Error("文件内容格式不正确");
    if (Buffer.byteLength(body.content, "utf8") > config.maxUploadBytes) {
      return apiError(reply, 413, "FILE_TOO_LARGE", `单个文件不能超过 ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB`, { path: filePath, size: Math.floor(config.maxUploadBytes / 1024 / 1024) });
    }
    const absolute = resolveSourcePath(config, id, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const previousContent = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
    reanchorFileComments(db, id, filePath, previousContent, body.content);
    fs.writeFileSync(absolute, body.content, { encoding: "utf8", mode: 0o600 });
    touchProject(db, id, user.id);
    collaboration.updateFile(id, filePath, body.content, user.id);
    recordHistory(id, user.id, "file", [filePath]);
    return { ok: true, comments: commentsForFile(db, config, id, filePath) };
  });

  app.delete("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const relative = safeRelativePath(filePath ?? "");
    if (relative === project.main_file || project.main_file.startsWith(`${relative}/`)) {
      return apiError(reply, 400, "MAIN_FILE_DELETE_FORBIDDEN", "不能删除当前主文件或包含主文件的目录", { path: relative });
    }
    if (!fs.existsSync(resolveSourcePath(config, id, relative))) return apiError(reply, 404, "PATH_NOT_FOUND", "文件或目录不存在", { path: relative });
    fs.rmSync(resolveSourcePath(config, id, relative), { recursive: true, force: true });
    touchProject(db, id, user.id);
    collaboration.removePath(id, relative);
    recordHistory(id, user.id, "file", [relative]);
    return { ok: true };
  });

  app.post("/api/projects/:id/upload", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const part = await request.file();
    if (!part) return apiError(reply, 400, "UPLOAD_EMPTY", "没有收到上传文件");
    const { directory, overwrite } = request.query as { directory?: string; overwrite?: string };
    const relative = safeRelativePath(directory ? `${safeRelativePath(directory)}/${part.filename}` : part.filename);
    const absolute = resolveSourcePath(config, id, relative);
    try {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    } catch (error) {
      if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return apiError(reply, 409, "PATH_EXISTS", "目标路径中的目录部分已被文件占用", { path: relative });
      }
      throw error;
    }
    const uploaded = await part.toBuffer();
    const replacing = overwrite === "1";
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      return apiError(reply, 409, "PATH_EXISTS", "目标路径是一个目录", { path: relative });
    }
    try {
      fs.writeFileSync(absolute, uploaded, { mode: 0o600, flag: replacing ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return apiError(reply, 409, "FILE_EXISTS", "同名文件已存在", { path: relative });
      }
      throw error;
    }
    touchProject(db, id, user.id);
    collaboration.updateFile(id, relative, uploaded.toString("utf8"), user.id);
    recordHistory(id, user.id, "file", [relative]);
    return reply.code(201).send({ ok: true, path: relative });
  });

  app.get("/api/projects/:id/members", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const members = db.prepare(`SELECT pm.user_id AS id, u.username, u.display_name AS displayName, pm.permission
      FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.username`).all(id);
    return { members };
  });

  app.put("/api/projects/:id/owner", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.owner_id !== user.id) {
      return apiError(reply, 403, "PROJECT_TRANSFER_FORBIDDEN", "只有当前项目所有者可以转让项目");
    }
    const body = (request.body ?? {}) as { userId?: unknown };
    if (typeof body.userId !== "string" || !body.userId) {
      return apiError(reply, 400, "PROJECT_TRANSFER_TARGET_INVALID", "请选择新的项目所有者");
    }
    if (body.userId === user.id) {
      return apiError(reply, 400, "PROJECT_TRANSFER_SELF", "当前用户已经是项目所有者");
    }
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND", "用户不存在或已被禁用");

    collaboration.flushProject(id);
    const changedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      // The new owner may already be a shared member. The previous owner keeps
      // edit access so a transfer does not unexpectedly lock them out.
      db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, target.id);
      db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at)
        VALUES (?, ?, 'edit', ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET permission = 'edit'`)
        .run(id, user.id, changedAt);
      db.prepare("UPDATE projects SET owner_id = ?, last_modified_by = ?, updated_at = ? WHERE id = ?")
        .run(target.id, user.id, changedAt, id);
      // A project token belongs to the account that supplied it. Preserve the
      // local repository/remote metadata, but require the new owner to add
      // their own credential before the next GitHub operation.
      db.prepare("UPDATE project_git_settings SET token_ciphertext = NULL, github_login = NULL, updated_at = ? WHERE project_id = ?")
        .run(changedAt, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    collaboration.resetProject(id);
    return {
      project: projectJson(accessibleProject(db, id, user)!, tagsForProject(db, id, user.id))
    };
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN", "只有项目所有者可以管理成员");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN", "项目所有者不能作为成员添加");
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
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN", "只有项目所有者可以管理成员");
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId);
    touchProject(db, id, user.id);
    return { ok: true };
  });

  app.get("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const relative = safeRelativePath(filePath ?? "");
    return { comments: commentsForFile(db, config, id, relative) };
  });

  app.post("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const body = request.body as Record<string, unknown>;
    const createdAt = now();
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    collaboration.flushProject(id);
    const absolute = resolveSourcePath(config, id, filePath);
    if (!fs.existsSync(absolute)) return apiError(reply, 404, "COMMENT_FILE_NOT_FOUND", "批注文件不存在");
    const source = fs.readFileSync(absolute, "utf8");
    if (!Number.isInteger(body.startOffset) || !Number.isInteger(body.endOffset)) {
      return apiError(reply, 400, "COMMENT_RANGE_INVALID", "批注缺少有效的源码区间");
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    if (!db.prepare("SELECT 1 FROM comments WHERE id = ? AND project_id = ?").get(commentId, id)) {
      return apiError(reply, 404, "COMMENT_NOT_FOUND", "批注不存在");
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND", "批注不存在");
    const body = request.body as { resolved?: unknown; content?: unknown };
    const changedAt = now();
    let changed = false;
    if (typeof body.content === "string") {
      if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_EDIT_FORBIDDEN", "只能编辑自己的批注");
      db.prepare("UPDATE comments SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?")
        .run(text(body.content, "批注", 5000), changedAt, changedAt, commentId);
      changed = true;
    }
    if (typeof body.resolved === "boolean") {
      db.prepare("UPDATE comments SET resolved = ?, updated_at = ? WHERE id = ?")
        .run(body.resolved ? 1 : 0, changedAt, commentId);
      changed = true;
    }
    if (!changed) return apiError(reply, 400, "COMMENT_UPDATE_EMPTY", "没有可更新的批注内容");
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.delete("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND", "批注不存在");
    if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_DELETE_FORBIDDEN", "只能删除自己的批注");
    db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.patch("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND", "回复不存在");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_EDIT_FORBIDDEN", "只能编辑自己的回复");
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND", "回复不存在");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_DELETE_FORBIDDEN", "只能删除自己的回复");
    db.prepare("DELETE FROM comment_replies WHERE id = ?").run(replyId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  registerCompileRoutes(app, { config, db, collaboration, compileCoordinator, metrics, pruneCompileRuns });

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
      if (request.url.startsWith("/api/")) return apiError(reply, 404, "API_NOT_FOUND", "接口不存在");
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html");
    });
  }

  return app;
}
