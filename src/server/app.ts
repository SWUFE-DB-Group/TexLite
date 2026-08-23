import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Config } from "./config.js";
import { activeAdminCount, pruneExpiredSessions, type DatabaseConnection, type ProjectRow, type UserRow } from "./db.js";
import { hashPassword, digestToken, LoginRateLimiter } from "./security.js";
import { currentUser, publicUser, requireAdmin, requireUser } from "./auth.js";
import { accessibleProject, canEdit } from "./projects.js";
import {
  createProjectFiles,
  duplicateProjectFiles,
  assertNoSourceSymlinks,
  listProjectFiles,
  listProjectFilesAsync,
  outputRoot,
  pruneTrashDirectory,
  removeProjectDirectory,
  resolveSourcePath,
  safePathSegment,
  safeRelativePath,
  sourceRoot
} from "./files.js";
import {
  CompileQueue,
  ProjectCompileCoordinator,
  listPublishedCompileArtifacts,
  pruneOrphanedCompileRuns,
  reconcilePublishedCompileRuns
} from "./compiler.js";
import { createSourceAnchor, offsetToLine, reanchorFileComments } from "./anchors.js";
import { extractProjectZip } from "./zip.js";
import { writeProjectArchive } from "./archive.js";
import { CollaborationService, isCollaborativeTextFile, maxCollaborativeFileBytes } from "./collaboration.js";
import { ProjectMutationCoordinator } from "./projectMutations.js";
import { ProjectGitService } from "./git.js";
import { LatexCompletionService } from "./latexCompletion.js";
import { ProjectHistoryService, type HistoryReason } from "./history.js";
import { ProjectOutlineService } from "./projectOutline.js";
import { replaceProject, searchProject } from "./projectSearch.js";
import { MetricRegistry } from "./metrics.js";
import { compileMainFile } from "./compileArtifacts.js";
import { apiError, contentDisposition, ValidationError } from "./http.js";
import { registerCompileRoutes } from "./routes/compile.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSystemRoutes } from "./routes/system.js";
import { HarperService } from "./harper.js";
import { isMainDocumentCandidate, mainDocumentCandidates } from "./latexRoot.js";

const now = (): string => new Date().toISOString();
const MAX_CITATION_BIBTEX_BYTES = 512 * 1024;
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60_000;
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function escapeGlobPattern(value: string): string {
  return value.replace(/[*?[]/g, "[$&]");
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError(`${name}格式不正确`);
  }
  return value.trim();
}

function dictionaryWord(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("自定义词格式不正确");
  const word = value.trim();
  if (!word || word.length > 64 || /[\s\\{}$%]/u.test(word)) throw new ValidationError("自定义词格式不正确");
  return word;
}

interface CitationLibraryRow {
  id: string;
  user_id: string;
  citation_key: string;
  entry_type: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  owner_username?: string;
  owner_display_name?: string;
}

interface CitationLibraryTagRow {
  id: string;
  name: string;
  color: typeof tagColors[number];
  user_id: string;
}

function citationJson(row: CitationLibraryRow, tags: CitationLibraryTagRow[] = []) {
  return {
    id: row.id,
    citationKey: row.citation_key,
    entryType: row.entry_type,
    bibtex: row.bibtex,
    title: row.title,
    authors: row.authors,
    year: row.year,
    revision: row.revision,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.user_id })),
    ownerId: row.user_id,
    ownerUsername: row.owner_username ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function citationTagsForEntries(db: DatabaseConnection, entryIds: string[]): Map<string, CitationLibraryTagRow[]> {
  const result = new Map(entryIds.map((entryId) => [entryId, [] as CitationLibraryTagRow[]]));
  if (!entryIds.length) return result;
  const placeholders = entryIds.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT link.entry_id, tag.id, tag.name, tag.color, tag.user_id
    FROM citation_library_entry_tags link JOIN citation_library_tags tag ON tag.id = link.tag_id
    JOIN citation_library_entries entry ON entry.id = link.entry_id AND entry.user_id = tag.user_id
    WHERE link.entry_id IN (${placeholders})
    ORDER BY tag.name COLLATE NOCASE`).all(...entryIds) as Array<CitationLibraryTagRow & { entry_id: string }>;
  for (const row of rows) result.get(row.entry_id)?.push({ id: row.id, name: row.name, color: row.color, user_id: row.user_id });
  return result;
}

function citationTagIds(db: DatabaseConnection, userId: string, value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ValidationError("引用标签格式不正确");
  const ids = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 100) throw new ValidationError("单个引用最多只能设置 100 个标签");
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT id FROM citation_library_tags WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as Array<{ id: string }>;
  if (rows.length !== ids.length) throw Object.assign(new Error("引用标签不存在"), { statusCode: 404, code: "CITATION_TAG_NOT_FOUND" });
  return ids;
}

function citationTagName(value: unknown): string {
  return text(value, "引用标签名称", 32);
}

function citationExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ValidationError("引用版本格式不正确");
  }
  return Number(value);
}

interface CitationInput {
  bibtex: string;
  citationKey: string;
  entryType: string;
  title: string | null;
  authors: string | null;
  year: string | null;
}

function citationNullableText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new ValidationError(`${name}格式不正确`);
  const trimmed = value.trim();
  return trimmed || null;
}

function citationInput(value: unknown): CitationInput {
  if (typeof value !== "object" || value === null) throw new ValidationError("引用条目格式不正确");
  const body = value as Record<string, unknown>;
  if (typeof body.bibtex !== "string" || !body.bibtex.trim()) {
    throw new ValidationError("引用条目不能为空");
  }
  if (Buffer.byteLength(body.bibtex, "utf8") > MAX_CITATION_BIBTEX_BYTES) {
    throw Object.assign(new Error("引用条目过大"), { statusCode: 413, code: "CITATION_TOO_LARGE" });
  }
  if (typeof body.citationKey !== "string" || !body.citationKey.trim() || body.citationKey.length > 512) {
    throw new ValidationError("引用 key 格式不正确");
  }
  if (typeof body.entryType !== "string" || !body.entryType.trim() || body.entryType.length > 128) {
    throw new ValidationError("引用类型格式不正确");
  }
  return {
    bibtex: body.bibtex.trim(),
    citationKey: body.citationKey.trim(),
    entryType: body.entryType.trim(),
    title: citationNullableText(body.title, "引用标题", 2048),
    authors: citationNullableText(body.authors, "引用作者", 2048),
    year: citationNullableText(body.year, "引用年份", 128)
  };
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

function commentsSummaryForProjects(db: DatabaseConnection, projectIds: string[]): Map<string, { totalCount: number; unresolvedCount: number }> {
  const result = new Map<string, { totalCount: number; unresolvedCount: number }>();
  if (!projectIds.length) return result;
  for (let index = 0; index < projectIds.length; index += 100) {
    const chunk = projectIds.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT project_id,
        COUNT(*) AS total_count,
        SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS unresolved_count
      FROM comments
      WHERE project_id IN (${placeholders})
      GROUP BY project_id
    `).all(...chunk) as Array<{ project_id: string; total_count: number; unresolved_count: number }>;
    for (const row of rows) {
      result.set(row.project_id, {
        totalCount: Number(row.total_count) || 0,
        unresolvedCount: Number(row.unresolved_count) || 0
      });
    }
  }
  return result;
}

function commentsSummaryForProject(db: DatabaseConnection, projectId: string): { totalCount: number; unresolvedCount: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS unresolved_count
    FROM comments
    WHERE project_id = ?
  `).get(projectId) as { total_count: number; unresolved_count: number } | undefined;
  return {
    totalCount: Number(row?.total_count) || 0,
    unresolvedCount: Number(row?.unresolved_count) || 0
  };
}

function projectJson(project: ProjectRow & {
  permission?: string;
  owner_username?: string;
  owner_display_name?: string;
  last_modified_username?: string | null;
  last_modified_display_name?: string | null;
  archived?: boolean | number;
}, tags: ProjectTag[] = [], commentsSummary?: { totalCount: number; unresolvedCount: number }) {
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
    unresolvedCommentCount: commentsSummary?.unresolvedCount ?? 0,
    commentCount: commentsSummary?.totalCount ?? 0,
    archived: Boolean(project.archived),
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

function touchProject(db: DatabaseConnection, projectId: string, userId: string): void {
  db.prepare("UPDATE projects SET updated_at = ?, last_modified_by = ? WHERE id = ?")
    .run(now(), userId, projectId);
}

function requireActiveUser(db: DatabaseConnection, user: UserRow): void {
  const current = db.prepare("SELECT disabled FROM users WHERE id = ?").get(user.id) as { disabled: number } | undefined;
  if (!current || current.disabled) {
    throw Object.assign(new Error("用户已被禁用或删除"), { statusCode: 401, code: "AUTH_REQUIRED" });
  }
}

/**
 * Authorization must be checked again after a queued mutation acquires its
 * project lock.  A member can be revoked, or ownership can be transferred,
 * while the request is waiting behind another filesystem operation.
 */
function requireEditableProject(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
  if (!canEdit(project)) throw Object.assign(new Error("没有编辑权限"), { statusCode: 403, code: "PROJECT_EDIT_FORBIDDEN" });
  return project;
}

/** Owner permission includes an administrator's effective owner access. */
function requireProjectOwnerPermission(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
  if (project.permission !== "owner") {
    throw Object.assign(new Error("只有项目所有者可以执行此操作"), { statusCode: 403, code: "PROJECT_OWNER_ONLY" });
  }
  return project;
}

/** Operations such as ownership transfer require the actual stored owner. */
function requireActualProjectOwner(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
  if (project.owner_id !== user.id) {
    throw Object.assign(new Error("只有当前项目所有者可以执行此操作"), { statusCode: 403, code: "PROJECT_OWNER_ONLY" });
  }
  return project;
}

function projectTextSnapshot(config: Config, projectId: string): Map<string, string> {
  const versionedText = (filePath: string) => /(?:\.tex|\.bib|\.sty|\.cls|\.txt|\.md|latexmkrc)$/i.test(filePath);
  return new Map(listProjectFiles(config, projectId).filter((entry) => entry.type === "file" && versionedText(entry.path)).map((entry) => {
    const absolute = resolveSourcePath(config, projectId, entry.path);
    return [entry.path, fs.statSync(absolute).size <= maxCollaborativeFileBytes(config) ? fs.readFileSync(absolute, "utf8") : ""] as const;
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
  if (!rows.length) return [];

  const replies = db.prepare(`SELECT reply.*, user.username AS author_username, user.display_name AS author_display_name
    FROM comment_replies reply
    JOIN comments c ON c.id = reply.comment_id
    LEFT JOIN users user ON user.id = reply.author_id
    WHERE c.project_id = ? AND c.file_path = ?
    ORDER BY reply.created_at`)
    .all(projectId, filePath) as unknown as Array<CommentReplyRow & { comment_id: string }>;

  const replyMap = new Map<string, Array<{
    id: string;
    authorId: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    content: string;
    createdAt: string;
    updatedAt: string;
    editedAt: string | null;
  }>>();

  for (const reply of replies) {
    const list = replyMap.get(reply.comment_id) ?? [];
    list.push({
      id: reply.id,
      authorId: reply.author_id,
      authorUsername: reply.author_username,
      authorDisplayName: reply.author_display_name,
      content: reply.content,
      createdAt: reply.created_at,
      updatedAt: reply.updated_at,
      editedAt: reply.edited_at
    });
    replyMap.set(reply.comment_id, list);
  }

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
    replies: replyMap.get(comment.id) ?? []
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
  const projectOutlines = new ProjectOutlineService(config);
  const harper = new HarperService();
  // Warm the single server-side runtime without delaying startup. The first
  // request shares this promise if initialization is still in progress.
  void harper.preload().catch((error) => app.log.warn({ err: error }, "Harper could not be initialized"));
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
  const projectMutations = new ProjectMutationCoordinator(collaboration);
  const projectGit = new ProjectGitService(config, db, options.githubFetch);
  const loginLimiter = new LoginRateLimiter();
  for (const row of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    reconcilePublishedCompileRuns(config, db, row.id);
  }
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
    db.transaction(() => {
      for (const run of completed) if (!keep.has(run.id)) remove.run(run.id);
    })();
  };
  // No second TexLite instance can mutate the data directory while the
  // instance lock is held. Finish cleanup before accepting requests so a
  // freshly started server never races a stale trash/tmp removal.
  await pruneTrashDirectory(config);
  for (const row of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    history.enforceRetention(row.id);
    pruneCompileRuns(row.id);
    pruneOrphanedCompileRuns(config, row.id);
  }
  app.addHook("onClose", async () => {
    eventLoopDelay.disable();
    await harper.dispose();
  });
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
    const rawStatus = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    const isClientError = rawStatus !== undefined && rawStatus >= 400 && rawStatus < 500;
    const status = isClientError ? rawStatus : 500;

    if (isClientError) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "REQUEST_INVALID";
      const message = error instanceof Error ? error.message : "请求格式不正确";
      const failedPaths = typeof error === "object" && error !== null && "failedPaths" in error
        && Array.isArray(error.failedPaths)
        && error.failedPaths.every((path): path is string => typeof path === "string")
        ? error.failedPaths.slice(0, 100)
        : undefined;
      void reply.code(status).send({
        code,
        error: message,
        ...(failedPaths ? { failedPaths } : {})
      });
    } else {
      void reply.code(500).send({
        code: "SERVER_ERROR",
        error: "服务器内部错误"
      });
    }
  });

  registerSystemRoutes(app, {
    config,
    db,
    queue,
    collaboration,
    latexCompletions,
    projectOutlines,
    metrics,
    eventLoopDelay
  });
  registerAuthRoutes(app, { config, db, loginLimiter });

  app.get("/api/citations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { q?: string; tag?: string; page?: string; pageSize?: string; limit?: string };
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const requestedPageSize = Number.parseInt(query.pageSize ?? query.limit ?? "60", 10);
    const pageSize = Math.min(200, Math.max(1, Number.isFinite(requestedPageSize) ? requestedPageSize : 60));
    const where = ["entry.user_id = ?"];
    const params: Array<string | number> = [user.id];
    if (search) {
      where.push(`(
            citation_key LIKE ? ESCAPE '\\' OR entry_type LIKE ? ESCAPE '\\'
            OR COALESCE(title, '') LIKE ? ESCAPE '\\'
            OR COALESCE(authors, '') LIKE ? ESCAPE '\\'
            OR COALESCE(year, '') LIKE ? ESCAPE '\\'
          )`);
      params.push(...Array.from({ length: 5 }, () => `%${escapeLikePattern(search)}%`));
    }
    if (tagId) {
      where.push(`EXISTS (SELECT 1 FROM citation_library_entry_tags filter_link
        JOIN citation_library_tags filter_tag ON filter_tag.id = filter_link.tag_id
        WHERE filter_link.entry_id = entry.id AND filter_link.tag_id = ? AND filter_tag.user_id = ?)`);
      params.push(tagId, user.id);
    }
    const countRow = db.prepare(`SELECT COUNT(*) AS count
      FROM citation_library_entries entry
      WHERE ${where.join(" AND ")}`).get(...params) as { count: number };
    const total = Number(countRow.count) || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
    const page = totalPages > 0 ? Math.min(Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1), totalPages) : 1;
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const rows = db.prepare(`SELECT entry.*, owner.username AS owner_username, owner.display_name AS owner_display_name
      FROM citation_library_entries entry
      JOIN users owner ON owner.id = entry.user_id
      WHERE ${where.join(" AND ")} ORDER BY entry.updated_at DESC, entry.citation_key COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params) as CitationLibraryRow[];
    const tags = citationTagsForEntries(db, rows.map((row) => row.id));
    return {
      entries: rows.map((row) => citationJson(row, tags.get(row.id) ?? [])),
      pagination: { page, pageSize, total, totalPages }
    };
  });

  app.get("/api/citations/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const tags = db.prepare(`SELECT tag.id, tag.name, tag.color, tag.user_id AS owner_id
      FROM citation_library_tags tag
      WHERE tag.user_id = ?
      ORDER BY tag.name COLLATE NOCASE`).all(user.id) as Array<{ id: string; name: string; color: typeof tagColors[number]; owner_id: string }>;
    return { tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.owner_id })) };
  });

  app.post("/api/citations/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { name?: unknown; color?: unknown } | undefined;
    const name = citationTagName(body?.name);
    const color = tagColors.includes(body?.color as typeof tagColors[number]) ? body?.color as typeof tagColors[number] : "gray";
    const existing = db.prepare("SELECT id, name, color, user_id FROM citation_library_tags WHERE user_id = ? AND name = ? COLLATE NOCASE").get(user.id, name) as CitationLibraryTagRow | undefined;
    if (existing) return { tag: { id: existing.id, name: existing.name, color: existing.color, ownerId: existing.user_id }, created: false };
    const tag = { id: randomUUID(), name, color, ownerId: user.id };
    db.prepare("INSERT INTO citation_library_tags (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tag.id, user.id, tag.name, tag.color, now());
    return reply.code(201).send({ tag, created: true });
  });

  app.delete("/api/citations/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const result = db.prepare("DELETE FROM citation_library_tags WHERE id = ? AND user_id = ?").run(tagId, user.id);
    if (!result.changes) return apiError(reply, 404, "CITATION_TAG_NOT_FOUND", "引用标签不存在");
    return { ok: true };
  });

  // Keep the old settings endpoint explicit so stale clients cannot accidentally
  // reinterpret "settings" as a citation id. Citation libraries are always private.
  app.patch("/api/citations/settings", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    return apiError(reply, 403, "CITATION_LIBRARY_PRIVATE", "引用库始终为私有，仅当前用户可访问");
  });

  app.post("/api/citations/lookup", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { keys?: unknown } | undefined;
    if (!Array.isArray(body?.keys) || body.keys.length > 5000
      || body.keys.some((key) => typeof key !== "string" || !key.trim() || key.length > 512)) {
      throw new ValidationError("引用 key 列表格式不正确");
    }
    const keys = [...new Map(body.keys.map((key) => [key.trim().toLowerCase(), key.trim()] as const)).values()];
    const matches: Array<{ id: string; citation_key: string; revision: number }> = [];
    for (let offset = 0; offset < keys.length; offset += 500) {
      const chunk = keys.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      matches.push(...db.prepare(`SELECT id, citation_key, revision FROM citation_library_entries
        WHERE user_id = ? AND citation_key COLLATE NOCASE IN (${placeholders})`)
        .all(user.id, ...chunk) as Array<{ id: string; citation_key: string; revision: number }>);
    }
    return { matches: matches.map((match) => ({ id: match.id, citationKey: match.citation_key, revision: match.revision })) };
  });

  app.post("/api/citations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; tagIds?: unknown; overwrite?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const tagIds = citationTagIds(db, user.id, body?.tagIds);
    const overwrite = body?.overwrite === true;
    const existing = db.prepare("SELECT id, revision FROM citation_library_entries WHERE user_id = ? AND citation_key = ? COLLATE NOCASE")
      .get(user.id, citation.citationKey) as { id: string; revision: number } | undefined;
    if (existing && !overwrite) return apiError(reply, 409, "CITATION_KEY_EXISTS", "引用 key 已经存在");
    const expectedRevision = existing ? citationExpectedRevision(body?.expectedRevision) : null;
    if (existing && existing.revision !== expectedRevision) {
      return apiError(reply, 409, "CITATION_CONFLICT", "引用已在其他位置发生修改，请刷新后重试");
    }
    const id = existing?.id ?? randomUUID();
    const timestamp = now();
    db.transaction(() => {
      if (existing) {
        const result = db.prepare(`UPDATE citation_library_entries SET citation_key = ?, entry_type = ?, bibtex = ?,
          title = ?, authors = ?, year = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND user_id = ? AND revision = ?`)
          .run(citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year,
            timestamp, id, user.id, expectedRevision);
        if (!result.changes) throw Object.assign(new Error("引用已在其他位置发生修改，请刷新后重试"), { statusCode: 409, code: "CITATION_CONFLICT" });
      } else {
        db.prepare(`INSERT INTO citation_library_entries
          (id, user_id, citation_key, entry_type, bibtex, title, authors, year, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(id, user.id, citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year, timestamp, timestamp);
      }
      if (tagIds !== null) {
        db.prepare("DELETE FROM citation_library_entry_tags WHERE entry_id = ?").run(id);
        for (const tagId of tagIds) db.prepare("INSERT INTO citation_library_entry_tags (entry_id, tag_id, created_at) VALUES (?, ?, ?)").run(id, tagId, timestamp);
      }
    })();
    const row = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(id, user.id) as CitationLibraryRow;
    const tags = citationTagsForEntries(db, [id]);
    return reply.code(existing ? 200 : 201).send({ entry: citationJson(row, tags.get(id) ?? []), updated: Boolean(existing) });
  });

  app.patch("/api/citations/:citationId/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as { id: string } | undefined;
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND", "引用条目不存在");
    const body = request.body as { tagIds?: unknown; expectedRevision?: unknown } | undefined;
    const tagIds = citationTagIds(db, user.id, body?.tagIds);
    if (tagIds === null) throw new ValidationError("引用标签格式不正确");
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const timestamp = now();
    db.transaction(() => {
      const result = db.prepare(`UPDATE citation_library_entries SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND revision = ?`).run(timestamp, citationId, user.id, expectedRevision);
      if (!result.changes) {
        const exists = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?").get(citationId, user.id);
        if (!exists) throw Object.assign(new Error("引用条目不存在"), { statusCode: 404, code: "CITATION_NOT_FOUND" });
        throw Object.assign(new Error("引用已在其他位置发生修改，请刷新后重试"), { statusCode: 409, code: "CITATION_CONFLICT" });
      }
      db.prepare("DELETE FROM citation_library_entry_tags WHERE entry_id = ?").run(citationId);
      for (const tagId of tagIds) db.prepare("INSERT INTO citation_library_entry_tags (entry_id, tag_id, created_at) VALUES (?, ?, ?)").run(citationId, tagId, timestamp);
    })();
    const row = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as CitationLibraryRow;
    const tags = citationTagsForEntries(db, [citationId]);
    return { entry: citationJson(row, tags.get(citationId) ?? []) };
  });

  app.patch("/api/citations/:citationId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as { id: string } | undefined;
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND", "引用条目不存在");
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const duplicate = db.prepare("SELECT id FROM citation_library_entries WHERE user_id = ? AND citation_key = ? COLLATE NOCASE AND id != ?")
      .get(user.id, citation.citationKey, citationId) as { id: string } | undefined;
    if (duplicate) return apiError(reply, 409, "CITATION_KEY_EXISTS", "引用 key 已经存在");
    const result = db.prepare(`UPDATE citation_library_entries SET citation_key = ?, entry_type = ?, bibtex = ?,
      title = ?, authors = ?, year = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND revision = ?`)
      .run(citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year,
        now(), citationId, user.id, expectedRevision);
    if (!result.changes) return apiError(reply, 409, "CITATION_CONFLICT", "引用已在其他位置发生修改，请刷新后重试");
    const updated = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as CitationLibraryRow;
    const tags = citationTagsForEntries(db, [citationId]);
    return { entry: citationJson(updated, tags.get(citationId) ?? []) };
  });

  app.delete("/api/citations/:citationId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const result = db.prepare("DELETE FROM citation_library_entries WHERE id = ? AND user_id = ?").run(citationId, user.id);
    if (!result.changes) return apiError(reply, 404, "CITATION_NOT_FOUND", "引用条目不存在");
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
    if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) return apiError(reply, 400, "USERNAME_INVALID", "用户名只能包含字母、数字、点、横线或下划线");
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
    // A disabled account must not regain access by being re-enabled while an
    // old cookie is still within its normal lifetime. Password resets already
    // revoke sessions above; disabling does the same for every active token.
    if (disabled === 1) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    if (disabled === 1 || (typeof body.password === "string" && body.password)) {
      collaboration.disconnectUser(id, "用户已被禁用或密码已重置");
    }
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
    let owned: Array<{ id: string }> = [];
    // Capture and mutate the complete owned-project set in the same synchronous
    // transaction. There is deliberately no await before COMMIT: another
    // request cannot transfer or create a project for this user between the
    // snapshot and the owner/delete statements.
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentTarget = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
      if (!currentTarget) throw Object.assign(new Error("用户不存在"), { statusCode: 404, code: "USER_NOT_FOUND" });
      if (currentTarget.role === "admin" && activeAdminCount(db) <= 1) {
        throw Object.assign(new Error("不能删除最后一个管理员"), { statusCode: 400, code: "LAST_ADMIN" });
      }
      owned = db.prepare("SELECT id FROM projects WHERE owner_id = ?").all(id) as Array<{ id: string }>;
      if (!body.deleteProjects) {
        // Persist any active drafts while the old owner row still exists. This
        // is synchronous, so no edit can arrive between this flush and the
        // ownership update below, and last_modified_by remains FK-safe.
        for (const project of owned) projectMutations.flushProject(project.id);
      }
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
    // Requests already queued for the removed user fail their lock-time
    // preflight. Cleanup is then serialized after them and invalidates any
    // room initialization that started before the transaction committed.
    for (const project of owned) {
      await projectMutations.runExclusive(project.id, "admin user deletion cleanup", () => {
        if (body.deleteProjects) {
          collaboration.resetProject(project.id);
          removeProjectDirectory(config, project.id);
          latexCompletions.invalidate(project.id);
          projectOutlines.invalidate(project.id);
        } else {
          collaboration.resetProject(project.id);
        }
      }, { flush: false });
    }
    collaboration.disconnectUser(id, "用户已被删除");
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
      conditions.push("(p.name LIKE :search ESCAPE '\\' OR owner.username LIKE :search ESCAPE '\\' OR owner.display_name LIKE :search ESCAPE '\\')");
      params.search = `%${escapeLikePattern(search)}%`;
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
    const projectIds = projects.map((project) => project.id);
    const projectTags = tagsForProjects(db, projectIds, user.id);
    const commentsSummaries = commentsSummaryForProjects(db, projectIds);
    return {
      projects: projects.map((project) => projectJson(
        { ...project, archived: archivedOnly },
        projectTags.get(project.id) ?? [],
        commentsSummaries.get(project.id)
      )),
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
      return apiError(reply, 400, "ZIP_INVALID", error instanceof Error ? error.message : "无法解压 ZIP 文件");
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
      // Duplicate the source tree only after flushing the live Yjs room and
      // while a short source barrier prevents autosave from changing files
      // between directory entries. The copy is asynchronous, so a large
      // project does not block the Node.js event loop for its entire duration.
      await projectMutations.runConsistentRead(source.id, () => duplicateProjectFiles(config, source.id, project.id), {
        preflight: () => {
          if (!accessibleProject(db, source.id, user)) {
            throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
          }
        }
      });
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
    return {
      project: projectJson(
        project,
        tagsForProject(db, id, user.id),
        commentsSummaryForProject(db, id)
      )
    };
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
    return await projectMutations.runConsistentRead(id, () => {
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
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
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
    return await projectMutations.runWrite(id, () => {
      if (!history.deleteVersion(id, versionId)) return apiError(reply, 404, "HISTORY_VERSION_NOT_FOUND", "历史版本不存在");
      return { ok: true, stats: history.stats(id) };
    }, { preflight: () => {
      requireProjectOwnerPermission(db, id, user);
      if (!history.version(versionId, id)) {
        throw Object.assign(new Error("历史版本不存在"), { statusCode: 404, code: "HISTORY_VERSION_NOT_FOUND" });
      }
    } });
  });

  app.delete("/api/projects/:id/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以清空历史版本");
    return await projectMutations.runWrite(id, () => {
      history.clear(id);
      return { ok: true, stats: history.stats(id) };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });

  app.post("/api/projects/:id/history/:versionId/restore", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown } | undefined;
    const filePath = typeof body?.path === "string" ? safeRelativePath(body.path) : undefined;
    return await projectMutations.runExclusive(id, "history restore", () => {
      const currentProject = requireEditableProject(db, id, user);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      const restored = history.restore(id, versionId, filePath);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "restore", filePath ? [filePath] : undefined);
      return {
        ok: true,
        restoredPaths: restored.restoredPaths,
        project: projectJson(
          accessibleProject(db, id, user) ?? currentProject,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => {
      requireEditableProject(db, id, user);
      if (!history.version(versionId, id)) {
        throw Object.assign(new Error("历史版本不存在"), { statusCode: 404, code: "HISTORY_VERSION_NOT_FOUND" });
      }
      history.validateRestoreTarget(id, versionId, filePath);
    } });
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

  app.post("/api/projects/:id/spellcheck", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const body = request.body as { source?: unknown } | undefined;
    if (typeof body?.source !== "string") return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID", "待检查源码格式不正确");
    if (Buffer.byteLength(body.source, "utf8") > maxCollaborativeFileBytes(config)) {
      return apiError(reply, 413, "SPELLCHECK_SOURCE_TOO_LARGE", "待检查源码过大");
    }
    try {
      return { lints: await harper.lint(body.source) };
    } catch (error) {
      request.log.error({ err: error, projectId: id }, "Harper writing check failed");
      return apiError(reply, 503, "HARPER_UNAVAILABLE", "Harper 拼写与语法检查暂不可用");
    }
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
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以修改项目设置");
    const body = request.body as Record<string, unknown>;
    return await projectMutations.runWrite(id, async () => {
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject || currentProject.permission !== "owner") {
        return apiError(reply, 403, "PROJECT_OWNER_ONLY", "只有项目所有者可以修改项目设置");
      }
      const name = typeof body.name === "string" ? text(body.name, "项目名称", 120) : currentProject.name;
      let mainFile = currentProject.main_file;
      if (body.mainFile !== undefined) {
        if (typeof body.mainFile !== "string" || !body.mainFile.trim()) {
          return apiError(reply, 400, "MAIN_FILE_INVALID", "主文件必须是存在的 .tex 文件");
        }
        mainFile = safeRelativePath(body.mainFile);
      }
      const engine = typeof body.engine === "string" && config.allowedEngines.includes(body.engine as typeof currentProject.engine)
        ? body.engine as typeof currentProject.engine : currentProject.engine;
      const latexmkrc = body.latexmkrc === null || body.latexmkrc === ""
        ? null
        : typeof body.latexmkrc === "string" ? safeRelativePath(body.latexmkrc) : currentProject.latexmkrc;
      if (!mainFile.toLocaleLowerCase().endsWith(".tex")) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", "主文件必须是 .tex 文件", { path: mainFile });
      }
      const mainFileAbsolute = resolveSourcePath(config, id, mainFile);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(mainFileAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return apiError(reply, 400, "MAIN_FILE_NOT_FOUND", "主文件不存在", { path: mainFile });
        }
        throw error;
      }
      if (!stat.isFile()) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", "主文件必须是常规文件，不能是目录", { path: mainFile });
      }
      if (body.mainFile !== undefined && !await isMainDocumentCandidate(config, id, mainFile)) {
        return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", "所选文件不是有效的 LaTeX 主文档", { path: mainFile });
      }
      if (latexmkrc && !config.allowProjectLatexmkrc) return apiError(reply, 400, "LATEXMKRC_DISABLED", "管理员已禁用项目级 latexmkrc");
      if (latexmkrc) {
        const rcAbsolute = resolveSourcePath(config, id, latexmkrc);
        let rcStat: fs.Stats | null = null;
        try {
          rcStat = fs.statSync(rcAbsolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return apiError(reply, 400, "LATEXMKRC_NOT_FOUND", "latexmkrc 文件不存在", { path: latexmkrc });
          }
          throw error;
        }
        if (!rcStat.isFile()) {
          return apiError(reply, 400, "LATEXMKRC_INVALID", "latexmkrc 必须是常规文件，不能是目录", { path: latexmkrc });
        }
      }
      db.prepare("UPDATE projects SET name = ?, main_file = ?, latexmkrc = ?, engine = ?, updated_at = ?, last_modified_by = ? WHERE id = ?")
        .run(name, mainFile, latexmkrc, engine, now(), user.id, id);
      recordHistory(id, user.id, "settings", []);
      return {
        project: projectJson(
          accessibleProject(db, id, user)!,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
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
    return reply.code(201).send({
      tags,
      project: projectJson(
        accessibleProject(db, id, user)!,
        tags,
        commentsSummaryForProject(db, id)
      )
    });
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
    return {
      tags,
      project: projectJson(
        accessibleProject(db, id, user)!,
        tags,
        commentsSummaryForProject(db, id)
      )
    };
  });

  const requireGitOwner = (projectId: string, user: UserRow) => {
    requireActiveUser(db, user);
    const project = accessibleProject(db, projectId, user);
    if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    if (project.owner_id !== user.id) throw Object.assign(new Error("只有项目创建者可以执行 Git 操作"), { statusCode: 403, code: "PROJECT_OWNER_ONLY" });
    return project;
  };

  app.get("/api/projects/:id/git", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runConsistentRead(id, async () => {
      return { status: await projectGit.status(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.put("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { token?: unknown };
    if (typeof body.token !== "string") return apiError(reply, 400, "GIT_TOKEN_INVALID", "请输入 GitHub token");
    const token = body.token;
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.configureToken(requireGitOwner(id, user), token) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.delete("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.removeToken(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/repository", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; private?: unknown };
    if (typeof body.name !== "string") return apiError(reply, 400, "GIT_REPOSITORY_NAME_INVALID", "请输入 GitHub 仓库名称");
    const repositoryName = body.name.trim();
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.createGitHubRepository(requireGitOwner(id, user), repositoryName, body.private !== false) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/commit", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const body = request.body as { message?: unknown };
    return await projectMutations.runExclusive(id, "Git commit", async () => {
      const project = requireGitOwner(id, user);
      const commit = await projectGit.commit(project, user, typeof body.message === "string" ? body.message : "");
      return reply.code(201).send({ commit, status: await projectGit.status(project) });
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/push", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    return await projectMutations.runSerialized(id, async () => {
      const project = requireGitOwner(id, user);
      return { status: await projectGit.push(project) };
    }, { flush: false, preflight: () => { requireGitOwner(id, user); } });
  });

  app.get("/api/projects/:id/git/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runConsistentRead(id, async () => {
      return { commits: await projectGit.history(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.get("/api/projects/:id/git/diff", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { revision } = request.query as { revision?: string };
    return await projectMutations.runConsistentRead(id, async () => {
      const project = requireGitOwner(id, user);
      return projectGit.diff(project, revision);
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/checkout", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    requireGitOwner(id, user);
    const body = request.body as { revision?: unknown; force?: unknown };
    if (body.revision !== null && typeof body.revision !== "string") return apiError(reply, 400, "GIT_REVISION_INVALID", "请选择要 checkout 的 Git 版本");
    const revisionInput = body.revision === null ? null : body.revision as string;
    return await projectMutations.runExclusive(id, "Git checkout", async () => {
      const currentProject = requireGitOwner(id, user);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      const revision = await projectGit.checkout(currentProject, revisionInput, body.force === true);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "git");
      return { revision, status: await projectGit.status(currentProject) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/discard", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    requireGitOwner(id, user);
    return await projectMutations.runExclusive(id, "Git restore", async () => {
      const currentProject = requireGitOwner(id, user);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      await projectGit.discardChanges(currentProject);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "git");
      return { status: await projectGit.status(currentProject) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.get("/api/projects/:id/download", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const temporaryDirectory = path.join(config.dataDir, "tmp");
    const temporaryArchive = path.join(temporaryDirectory, `project-${id}-${randomUUID()}.zip`);
    try {
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await projectMutations.runConsistentRead(id, () => writeProjectArchive(config, id, temporaryArchive), {
        preflight: () => {
          const current = accessibleProject(db, id, user);
          if (!current) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      });
    } catch (error) {
      await fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined);
      throw error;
    }
    const filename = `${project.name}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition(filename, "attachment"));
    const stream = fs.createReadStream(temporaryArchive);
    const cleanup = () => { void fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined); };
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return reply.send(stream);
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_DELETE_FORBIDDEN", "只有项目所有者可以删除项目");
    return await projectMutations.runExclusive(id, "project deletion", () => {
      collaboration.resetProject(id);
      removeProjectDirectory(config, id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      latexCompletions.invalidate(id);
      projectOutlines.invalidate(id);
      return { ok: true };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });

  app.get("/api/projects/:id/files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    // Directory walks can be slow on external/project-mounted storage. Keep
    // this request off the event loop and unblocked by Yjs room initialization
    // so the file tree and retained-PDF stream can be served concurrently, but
    // still serialize it with source-tree mutations and collaborative flushes.
    return await projectMutations.runFilesystemRead(id, async () => ({
      files: await listProjectFilesAsync(config, id)
    }), {
      preflight: () => {
        if (!accessibleProject(db, id, user)) {
          throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      }
    });
  });

  app.get("/api/projects/:id/main-files", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    return await projectMutations.runFilesystemRead(id, async () => {
      const files = await listProjectFilesAsync(config, id);
      return await mainDocumentCandidates(config, id, files);
    }, {
      preflight: () => {
        if (!accessibleProject(db, id, user)) {
          throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      }
    });
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
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, async () => ({
        outline: await projectOutlines.build(id, mainFile), mainFile
      }), {
        preflight: () => {
          const current = accessibleProject(db, id, user);
          if (!current) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
          const selected = compileMainFile(config, id, current.main_file, query.mainFile);
          if (!selected || selected !== mainFile) throw Object.assign(new Error("所选文件不是有效的 LaTeX 主文档"), { statusCode: 400, code: "MAIN_DOCUMENT_INVALID" });
        }
      });
    }
    finally { metrics.record("outline.build", performance.now() - startedAt); }
  });

  app.get("/api/projects/:id/search", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { q?: string; caseSensitive?: string; wholeWord?: string };
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, () => searchProject(config, id, {
          query: query.q ?? "",
          caseSensitive: query.caseSensitive === "1",
          wholeWord: query.wholeWord === "1"
        }), {
          preflight: () => {
            if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
          }
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const startedAt = performance.now();
    try {
      return await projectMutations.runConsistentRead(id, async () => ({ index: await latexCompletions.build(id) }), {
        preflight: () => {
          if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      });
    }
    finally { metrics.record("completions.build", performance.now() - startedAt); }
  });

  app.post("/api/projects/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown };
    const folderPath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    return await projectMutations.runWrite(id, () => {
      const absolute = resolveSourcePath(config, id, folderPath);
      if (fs.existsSync(absolute)) return apiError(reply, 409, "PATH_EXISTS", "同名文件或目录已存在", { path: folderPath });
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
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { source?: unknown; destinationDirectory?: unknown; destinationName?: unknown };
    const source = safeRelativePath(typeof body.source === "string" ? body.source : "");
    const destinationDirectory = body.destinationDirectory === "" ? ""
      : safeRelativePath(typeof body.destinationDirectory === "string" ? body.destinationDirectory : "");
    const destinationName = body.destinationName === undefined
      ? path.posix.basename(source)
      : safePathSegment(typeof body.destinationName === "string" ? body.destinationName : "");
    const destination = destinationDirectory ? `${destinationDirectory}/${destinationName}` : destinationName;

    const sourceAbsolute = resolveSourcePath(config, id, source);
    if (!fs.existsSync(sourceAbsolute)) return apiError(reply, 404, "PATH_NOT_FOUND", "要移动的文件或目录不存在", { path: source });
    if (destination === source) return { ok: true, path: source };
    const initialSourceStat = fs.statSync(sourceAbsolute);
    if (initialSourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
      return apiError(reply, 400, "MOVE_INTO_SELF", "不能把目录移动到自身内部", { path: source });
    }
    const destinationRoot = destinationDirectory
      ? resolveSourcePath(config, id, destinationDirectory)
      : sourceRoot(config, id);
    if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
      return apiError(reply, 404, "DIRECTORY_NOT_FOUND", "目标目录不存在", { path: destinationDirectory });
    }
    const destinationAbsolute = resolveSourcePath(config, id, destination);
    if (fs.existsSync(destinationAbsolute)) return apiError(reply, 409, "PATH_EXISTS", "目标目录中存在同名文件或目录", { path: destination });
    let currentProject = project;
    const validateMove = (): void => {
      currentProject = requireEditableProject(db, id, user);
      assertNoSourceSymlinks(config, id);
      if (!fs.existsSync(sourceAbsolute)) {
        throw Object.assign(new Error("要移动的文件或目录不存在"), { statusCode: 404, code: "PATH_NOT_FOUND" });
      }
      const sourceStat = fs.statSync(sourceAbsolute);
      if (sourceStat.isDirectory() && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
        throw Object.assign(new Error("不能把目录移动到自身内部"), { statusCode: 400, code: "MOVE_INTO_SELF" });
      }
      if (!fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
        throw Object.assign(new Error("目标目录不存在"), { statusCode: 404, code: "DIRECTORY_NOT_FOUND" });
      }
      if (fs.existsSync(destinationAbsolute)) {
        throw Object.assign(new Error("目标目录中存在同名文件或目录"), { statusCode: 409, code: "PATH_EXISTS" });
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const query = request.query as { path?: string; download?: string };
    const filePath = safeRelativePath(query.path ?? "");
    const temporaryDirectory = path.join(config.dataDir, "tmp");
    const temporaryFile = path.join(temporaryDirectory, `file-${id}-${randomUUID()}`);
    try {
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await projectMutations.runConsistentRead(id, async () => {
        const absolute = resolveSourcePath(config, id, filePath);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          throw Object.assign(new Error("文件不存在"), { statusCode: 404, code: "FILE_NOT_FOUND" });
        }
        await fs.promises.copyFile(absolute, temporaryFile);
      }, { preflight: () => {
        if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
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
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const relative = safeRelativePath(filePath ?? "");
    return await projectMutations.runConsistentRead(id, () => {
      const absolute = resolveSourcePath(config, id, relative);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return apiError(reply, 404, "FILE_NOT_FOUND", "文件不存在", { path: relative });
      if (isCollaborativeTextFile(relative) && fs.statSync(absolute).size > maxCollaborativeFileBytes(config)) {
        return apiError(reply, 413, "FILE_TOO_LARGE", "协作文本文件过大，不能作为编辑器内容打开", { path: relative });
      }
      return { path: relative, content: fs.readFileSync(absolute, "utf8") };
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
  });

  // Creating a file is intentionally separate from updating one.  The editor
  // uses PUT for autosaves, but a user action such as "New file" must never
  // silently replace an existing file.
  app.post("/api/projects/:id/file", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") return apiError(reply, 400, "FILE_CONTENT_INVALID", "文件内容格式不正确");
    const content = body.content;
    const byteLength = Buffer.byteLength(content, "utf8");
    const limit = isCollaborativeTextFile(filePath) ? maxCollaborativeFileBytes(config) : config.maxUploadBytes;
    if (byteLength > limit) {
      return apiError(reply, 413, "FILE_TOO_LARGE", `该文件不能超过 ${Math.floor(limit / 1024 / 1024)} MB`, { path: filePath, size: Math.floor(limit / 1024 / 1024) });
    }
    return await projectMutations.runWrite(id, () => {
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
        fs.writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return apiError(reply, 409, "FILE_EXISTS", "同名文件或目录已存在", { path: filePath });
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
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const body = request.body as { path?: unknown; content?: unknown };
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    if (typeof body.content !== "string") return apiError(reply, 400, "FILE_CONTENT_INVALID", "文件内容格式不正确");
    const content = body.content;
    const byteLength = Buffer.byteLength(content, "utf8");
    const limit = isCollaborativeTextFile(filePath) ? maxCollaborativeFileBytes(config) : config.maxUploadBytes;
    if (byteLength > limit) {
      return apiError(reply, 413, "FILE_TOO_LARGE", `该文件不能超过 ${Math.floor(limit / 1024 / 1024)} MB`, { path: filePath, size: Math.floor(limit / 1024 / 1024) });
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
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const { path: filePath } = request.query as { path?: string };
    const relative = safeRelativePath(filePath ?? "");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    return await projectMutations.runWrite(id, () => {
      const currentProject = requireEditableProject(db, id, user);
      if (relative === currentProject.main_file || currentProject.main_file.startsWith(`${relative}/`)) {
        return apiError(reply, 400, "MAIN_FILE_DELETE_FORBIDDEN", "不能删除当前主文件或包含主文件的目录", { path: relative });
      }
      const absolute = resolveSourcePath(config, id, relative, { allowFinalSymlink: true });
      try { fs.lstatSync(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return apiError(reply, 404, "PATH_NOT_FOUND", "文件或目录不存在", { path: relative });
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
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY", "项目正在执行源文件操作，请稍后重试");
    const project = accessibleProject(db, id, user);
    if (!project || !canEdit(project)) return apiError(reply, 403, "PROJECT_EDIT_FORBIDDEN", "没有编辑权限");
    const part = await request.file();
    if (!part) return apiError(reply, 400, "UPLOAD_EMPTY", "没有收到上传文件");
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
        return apiError(reply, 413, "FILE_TOO_LARGE", `该文件不能超过 ${Math.floor(uploadLimit / 1024 / 1024)} MB`, { path: relative, size: Math.floor(uploadLimit / 1024 / 1024) });
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
            return apiError(reply, 409, "PATH_EXISTS", "目标路径中的目录部分已被文件占用", { path: relative });
          }
          throw error;
        }
        const replacing = overwrite === "1";
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
          return apiError(reply, 409, "PATH_EXISTS", "目标路径是一个目录", { path: relative });
        }
        if (!replacing && fs.existsSync(absolute)) {
          return apiError(reply, 409, "FILE_EXISTS", "同名文件已存在", { path: relative });
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

    return await projectMutations.runExclusive(id, "project transfer", () => {
      const currentTarget = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
      // The synchronous preflight immediately precedes maintenance, so this
      // lookup cannot change before the operation starts.
      if (!currentTarget) throw Object.assign(new Error("用户不存在或已被禁用"), { statusCode: 404, code: "USER_NOT_FOUND" });
      const changedAt = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        // The new owner may already be a shared member. The previous owner keeps
        // edit access so a transfer does not unexpectedly lock them out.
        db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, currentTarget.id);
        db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at)
          VALUES (?, ?, 'edit', ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET permission = 'edit'`)
          .run(id, user.id, changedAt);
        db.prepare("UPDATE projects SET owner_id = ?, last_modified_by = ?, updated_at = ? WHERE id = ?")
          .run(currentTarget.id, user.id, changedAt, id);
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
      return {
        project: projectJson(
          accessibleProject(db, id, user)!,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => {
      requireActualProjectOwner(db, id, user);
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(body.userId)) {
        throw Object.assign(new Error("用户不存在或已被禁用"), { statusCode: 404, code: "USER_NOT_FOUND" });
      }
    } });
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN", "只有项目所有者可以管理成员");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN", "项目所有者不能作为成员添加");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(userId)) {
      return apiError(reply, 404, "USER_NOT_FOUND", "用户不存在或已被禁用");
    }
    const body = request.body as { permission?: unknown };
    const permission = body.permission === "edit" ? "edit" : "read";
    db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`)
      .run(id, userId, permission, now());
    touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, permission);
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
    collaboration.notifyPermissionChanged(id, userId, "revoked");
    return { ok: true };
  });

  app.get("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const relative = safeRelativePath(filePath ?? "");
    return {
      comments: await projectMutations.runConsistentRead(id, () => commentsForFile(db, config, id, relative), {
        preflight: () => {
          if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      })
    };
  });

  app.post("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND", "项目不存在");
    const body = request.body as Record<string, unknown>;
    const createdAt = now();
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    return await projectMutations.runWrite(id, () => {
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
    }, { preflight: () => {
      if (!accessibleProject(db, id, user)) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
    } });
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

  registerCompileRoutes(app, { config, db, collaboration, projectMutations, compileCoordinator, metrics, pruneCompileRuns });

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
    await app.register(staticPlugin, {
      root: config.clientDir,
      wildcard: false,
      // Vite fingerprints everything under assets/. These large JS/WASM files
      // are safe to cache indefinitely; a new build produces a new URL. Keep
      // index.html fresh so it always points at the current fingerprints.
      cacheControl: false,
      setHeaders(reply, filePath) {
        const relativePath = path.relative(config.clientDir, filePath).split(path.sep).join("/");
        if (relativePath === "index.html") {
          reply.header("Cache-Control", "no-store");
        } else if (relativePath.startsWith("assets/")) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          reply.header("Cache-Control", "public, max-age=3600");
        }
      }
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) return apiError(reply, 404, "API_NOT_FOUND", "接口不存在");
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html");
    });
  }

  const cleanupExpiredSessions = (): void => {
    try {
      pruneExpiredSessions(db, now());
      loginLimiter.prune();
    } catch (error) {
      app.log.error({ err: error }, "Failed to prune expired sessions");
    }
  };
  // Clean up at startup as well as periodically so long-running deployments do
  // not retain one row per historical login indefinitely.
  cleanupExpiredSessions();
  const sessionCleanupTimer = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();
  app.addHook("onClose", async () => { clearInterval(sessionCleanupTimer); });

  return app;
}
