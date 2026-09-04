import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "./db.js";

/** A project participant available to complete an `@username` mention. */
export interface MentionableUser {
  id: string;
  username: string;
  displayName: string;
}

export interface CommentMention {
  id: string;
  projectId: string;
  commentId: string;
  replyId: string | null;
  filePath: string;
  content: string;
  resolved: boolean;
  createdAt: string;
  readAt: string | null;
  readReason: "opened" | "resolved" | "manual" | null;
}

interface MentionRow {
  id: string;
  project_id: string;
  comment_id: string;
  reply_id: string | null;
  file_path: string;
  comment_content: string;
  reply_content: string | null;
  resolved: number;
  created_at: string;
  read_at: string | null;
  read_reason: "opened" | "resolved" | "manual" | null;
}

/**
 * List active users who can access a project.  The owner is included even
 * though they have no project_members row.  Callers can exclude the author
 * when presenting a mention picker.
 */
export function mentionableUsersForProject(db: DatabaseConnection, projectId: string, excludeUserId?: string): MentionableUser[] {
  const exclusion = excludeUserId ? "AND user.id <> ?" : "";
  const parameters = excludeUserId ? [projectId, excludeUserId] : [projectId];
  const rows = db.prepare(`SELECT DISTINCT user.id, user.username, user.display_name
    FROM users user
    JOIN projects project ON project.id = ?
    LEFT JOIN project_members member ON member.project_id = project.id AND member.user_id = user.id
    WHERE user.disabled = 0
      AND (user.id = project.owner_id OR member.user_id IS NOT NULL)
      ${exclusion}
    ORDER BY user.display_name COLLATE NOCASE, user.username COLLATE NOCASE`)
    .all(...parameters) as Array<{ id: string; username: string; display_name: string }>;
  return rows.map((user) => ({ id: user.id, username: user.username, displayName: user.display_name }));
}

/**
 * Extract mention tokens without taking ownership of ordinary `@` text.
 * The surrounding-character rule intentionally excludes e-mail addresses;
 * the candidate lookup below then makes a token a mention only when it is an
 * exact, currently accessible username.
 */
export function mentionedUsernames(content: string, candidates: readonly MentionableUser[]): string[] {
  const available = new Map(candidates.map((candidate) => [candidate.username.toLocaleLowerCase(), candidate.username]));
  const usernames = new Set<string>();
  const pattern = /(^|[^\p{L}\p{N}_.-])@([\p{L}\p{N}_.-]+)/gu;
  for (const match of content.matchAll(pattern)) {
    let token = match[2];
    let username = available.get(token.toLocaleLowerCase());
    // A sentence-ending period or comma is not part of the mention, even
    // though a username itself is allowed to contain dots and hyphens.
    while (!username && /[.,;:!?)}\]\u201d\u2019]$/u.test(token)) {
      token = token.slice(0, -1);
      username = available.get(token.toLocaleLowerCase());
    }
    if (username) usernames.add(username);
  }
  return [...usernames];
}

/** Persist first-class notifications for exact mentions in one comment item. */
export function createCommentMentions(db: DatabaseConnection, input: {
  projectId: string;
  commentId: string;
  replyId?: string | null;
  authorId: string;
  content: string;
  /** On edits, only newly added @users should generate a fresh notification. */
  previousContent?: string;
  createdAt: string;
}): void {
  const candidates = mentionableUsersForProject(db, input.projectId);
  const previousUsernames = new Set(input.previousContent ? mentionedUsernames(input.previousContent, candidates) : []);
  const recipients = mentionedUsernames(input.content, candidates)
    .map((username) => candidates.find((candidate) => candidate.username === username))
    .filter((candidate): candidate is MentionableUser => Boolean(candidate && candidate.id !== input.authorId && !previousUsernames.has(candidate.username)));
  if (!recipients.length) return;

  const insert = db.prepare(`INSERT INTO comment_mentions
    (id, project_id, comment_id, reply_id, mentioned_user_id, mentioned_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      mentioned_by_user_id = excluded.mentioned_by_user_id,
      created_at = excluded.created_at,
      read_at = NULL,
      read_reason = NULL`);
  for (const recipient of recipients) {
    insert.run(randomUUID(), input.projectId, input.commentId, input.replyId ?? null, recipient.id, input.authorId, input.createdAt);
  }
}

/** Return unread mention counts scoped to one receiving user. */
export function unreadMentionCountsForProjects(db: DatabaseConnection, projectIds: readonly string[], userId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let offset = 0; offset < projectIds.length; offset += 200) {
    const chunk = projectIds.slice(offset, offset + 200);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT project_id, COUNT(*) AS count
      FROM comment_mentions
      WHERE mentioned_user_id = ? AND read_at IS NULL AND project_id IN (${placeholders})
      GROUP BY project_id`).all(userId, ...chunk) as Array<{ project_id: string; count: number }>;
    for (const row of rows) counts.set(row.project_id, Number(row.count) || 0);
  }
  return counts;
}

function mentionFromRow(row: MentionRow): CommentMention {
  return {
    id: row.id,
    projectId: row.project_id,
    commentId: row.comment_id,
    replyId: row.reply_id,
    filePath: row.file_path,
    content: row.reply_id ? row.reply_content ?? "" : row.comment_content,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    readAt: row.read_at,
    readReason: row.read_reason
  };
}

const mentionSelect = `SELECT mention.id, mention.project_id, mention.comment_id, mention.reply_id,
  comment.file_path, comment.content AS comment_content, reply.content AS reply_content,
  comment.resolved, mention.created_at, mention.read_at, mention.read_reason
  FROM comment_mentions mention
  JOIN comments comment ON comment.id = mention.comment_id
  LEFT JOIN comment_replies reply ON reply.id = mention.reply_id`;

export function listCommentMentions(db: DatabaseConnection, projectId: string, userId: string, options: { unreadOnly?: boolean; limit?: number; filePath?: string } = {}): CommentMention[] {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const unreadClause = options.unreadOnly ? "AND mention.read_at IS NULL" : "";
  const fileClause = options.filePath ? "AND comment.file_path = ?" : "";
  const parameters = options.filePath
    ? [projectId, userId, options.filePath, limit]
    : [projectId, userId, limit];
  const rows = db.prepare(`${mentionSelect}
    WHERE mention.project_id = ? AND mention.mentioned_user_id = ? ${unreadClause} ${fileClause}
    ORDER BY mention.created_at DESC LIMIT ?`).all(...parameters) as MentionRow[];
  return rows.map(mentionFromRow);
}

export function commentMentionForUser(db: DatabaseConnection, mentionId: string, projectId: string, userId: string): CommentMention | null {
  const row = db.prepare(`${mentionSelect}
    WHERE mention.id = ? AND mention.project_id = ? AND mention.mentioned_user_id = ?`)
    .get(mentionId, projectId, userId) as MentionRow | undefined;
  return row ? mentionFromRow(row) : null;
}

/** Mark an item read after the UI has opened and located its target thread. */
export function markCommentMentionRead(db: DatabaseConnection, mentionId: string, userId: string, readAt: string, reason: "opened" | "manual" = "opened"): boolean {
  return db.prepare(`UPDATE comment_mentions
    SET read_at = ?, read_reason = ?
    WHERE id = ? AND mentioned_user_id = ? AND read_at IS NULL`)
    .run(readAt, reason, mentionId, userId).changes > 0;
}

/** Explicitly clear every unread notification in a project for one recipient. */
export function markAllCommentMentionsRead(db: DatabaseConnection, projectId: string, userId: string, readAt: string): number {
  return db.prepare(`UPDATE comment_mentions
    SET read_at = ?, read_reason = 'manual'
    WHERE project_id = ? AND mentioned_user_id = ? AND read_at IS NULL`)
    .run(readAt, projectId, userId).changes;
}

/** Resolving a thread makes all existing unread mentions in it non-actionable. */
export function markCommentMentionsResolved(db: DatabaseConnection, commentId: string, resolvedAt: string): number {
  return db.prepare(`UPDATE comment_mentions
    SET read_at = ?, read_reason = 'resolved'
    WHERE comment_id = ? AND read_at IS NULL`)
    .run(resolvedAt, commentId).changes;
}
