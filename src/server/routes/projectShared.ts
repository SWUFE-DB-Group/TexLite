import fs from "node:fs";
import type { Config } from "../config.js";
import type { DatabaseConnection, ProjectRow, UserRow } from "../db.js";
import { reanchorFileComments, offsetToLine } from "../anchors.js";
import { maxCollaborativeFileBytes } from "../collaboration.js";
import { listProjectFiles, resolveSourcePath } from "../files.js";
import { httpError, ValidationError } from "../http.js";
import { accessibleProject, canEdit } from "../projects.js";

export const now = (): string => new Date().toISOString();
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function escapeGlobPattern(value: string): string {
  return value.replace(/[*?[]/g, "[$&]");
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

export function dictionaryWord(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError();
  const word = value.trim();
  if (!word || word.length > 64 || /[\s\\{}$%]/u.test(word)) throw new ValidationError();
  return word;
}

export interface ProjectTag {
  id: string;
  name: string;
  color: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
}

export const tagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;

export function tagsForProject(db: DatabaseConnection, projectId: string, userId: string): ProjectTag[] {
  return db.prepare(`SELECT tag.id, tag.name, tag.color
    FROM user_tags tag JOIN user_project_tag_links link ON link.tag_id = tag.id
    WHERE link.project_id = ? AND tag.user_id = ? ORDER BY tag.name COLLATE NOCASE`)
    .all(projectId, userId) as unknown as ProjectTag[];
}

export function tagsForProjects(db: DatabaseConnection, projectIds: string[], userId: string): Map<string, ProjectTag[]> {
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

export function commentsSummaryForProjects(db: DatabaseConnection, projectIds: string[]): Map<string, { totalCount: number; unresolvedCount: number }> {
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

export function commentsSummaryForProject(db: DatabaseConnection, projectId: string): { totalCount: number; unresolvedCount: number } {
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

export function projectJson(project: ProjectRow & {
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

export function touchProject(db: DatabaseConnection, projectId: string, userId: string): void {
  db.prepare("UPDATE projects SET updated_at = ?, last_modified_by = ? WHERE id = ?")
    .run(now(), userId, projectId);
}

export function requireActiveUser(db: DatabaseConnection, user: UserRow): void {
  const current = db.prepare("SELECT disabled FROM users WHERE id = ?").get(user.id) as { disabled: number } | undefined;
  if (!current || current.disabled) {
    throw httpError(401, "AUTH_REQUIRED");
  }
}

/**
 * Authorization must be checked again after a queued mutation acquires its
 * project lock.  A member can be revoked, or ownership can be transferred,
 * while the request is waiting behind another filesystem operation.
 */
export function requireEditableProject(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (!canEdit(project)) throw httpError(403, "PROJECT_EDIT_FORBIDDEN");
  return project;
}

/** Owner permission includes an administrator's effective owner access. */
export function requireProjectOwnerPermission(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (project.permission !== "owner") {
    throw httpError(403, "PROJECT_OWNER_ONLY");
  }
  return project;
}

/** Operations such as ownership transfer require the actual stored owner. */
export function requireActualProjectOwner(db: DatabaseConnection, projectId: string, user: UserRow) {
  requireActiveUser(db, user);
  const project = accessibleProject(db, projectId, user);
  if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
  if (project.owner_id !== user.id) {
    throw httpError(403, "PROJECT_OWNER_ONLY");
  }
  return project;
}

export function projectTextSnapshot(config: Config, projectId: string): Map<string, string> {
  const versionedText = (filePath: string) => /(?:\.tex|\.bib|\.sty|\.cls|\.txt|\.md|latexmkrc)$/i.test(filePath);
  return new Map(listProjectFiles(config, projectId).filter((entry) => entry.type === "file" && versionedText(entry.path)).map((entry) => {
    const absolute = resolveSourcePath(config, projectId, entry.path);
    return [entry.path, fs.statSync(absolute).size <= maxCollaborativeFileBytes(config) ? fs.readFileSync(absolute, "utf8") : ""] as const;
  }));
}

export function reanchorProjectSnapshot(db: DatabaseConnection, projectId: string, before: Map<string, string>, after: Map<string, string>): void {
  for (const filePath of new Set([...before.keys(), ...after.keys()])) {
    reanchorFileComments(db, projectId, filePath, before.get(filePath) ?? "", after.get(filePath) ?? "");
  }
}

export function movedProjectPath(value: string | null, source: string, destination: string): string | null {
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

export function repliesForComment(db: DatabaseConnection, commentId: string) {
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

export function commentsForFile(db: DatabaseConnection, config: Config, projectId: string, filePath: string) {
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
