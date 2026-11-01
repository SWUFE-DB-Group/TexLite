import * as Y from "yjs";
import type { DatabaseConnection } from "./db.js";
import { createSourceAnchor, offsetToLine } from "./anchors.js";
import { httpError } from "./http.js";
import type { CommentSuggestion, MentionableUser } from "../shared/comments.js";
import { MAX_SUGGESTION_LENGTH } from "../shared/comments.js";
import { randomUUID } from "node:crypto";

export function attachSuggestion(db: DatabaseConnection, projectId: string, commentId: string, authorId: string, original: string, input: unknown): void {
  if (!input || typeof input !== "object") throw httpError(400, "SUGGESTION_INVALID");
  const { replacementText, reviewerId } = input as Record<string, unknown>;
  validateSuggestionReplacement(original, replacementText);
  if (reviewerId === authorId) throw httpError(400, "SUGGESTION_SELF_REVIEW");
  if (typeof reviewerId !== "string" || !suggestionReviewers(db, projectId, authorId).some((user) => user.id === reviewerId)) throw httpError(400, "SUGGESTION_REVIEWER_INVALID");
  if (suggestionRow(db, projectId, commentId)) throw httpError(409, "SUGGESTION_EXISTS");
  db.prepare("INSERT INTO comment_suggestions (comment_id, original_text, replacement_text, reviewer_id) VALUES (?, ?, ?, ?)")
    .run(commentId, original, replacementText, reviewerId);
  requestSuggestionReview(db, projectId, commentId, reviewerId, authorId, new Date().toISOString());
}

export function validateSuggestionReplacement(original: string, replacement: unknown): asserts replacement is string {
  if (!original || original.length > MAX_SUGGESTION_LENGTH || typeof replacement !== "string"
    || replacement.length > MAX_SUGGESTION_LENGTH || replacement === original || replacement.includes("\0")) throw httpError(400, "SUGGESTION_INVALID");
}

export function suggestionReviewers(db: DatabaseConnection, projectId: string, authorId?: string | null): MentionableUser[] {
  return db.prepare(`SELECT u.id, u.username, u.display_name AS displayName FROM users u
    JOIN projects p ON p.id = ? LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = u.id
    WHERE u.disabled = 0 AND (u.id = p.owner_id OR m.permission = 'edit') AND (? IS NULL OR u.id <> ?)
    ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE`).all(projectId, authorId ?? null, authorId ?? null) as MentionableUser[];
}

export function requestSuggestionReview(db: DatabaseConnection, projectId: string, commentId: string, reviewerId: string, authorId: string, at: string): void {
  if (reviewerId === authorId) return;
  db.prepare(`INSERT INTO comment_mentions (id, project_id, comment_id, mentioned_user_id, mentioned_by_user_id, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, 'review') ON CONFLICT DO UPDATE SET kind = 'review', read_at = NULL,
    read_reason = NULL, created_at = excluded.created_at, mentioned_by_user_id = excluded.mentioned_by_user_id`)
    .run(randomUUID(), projectId, commentId, reviewerId, authorId, at);
}

export function clearSuggestionReview(db: DatabaseConnection, commentId: string, at: string): void {
  db.prepare("UPDATE comment_mentions SET read_at = ?, read_reason = 'manual' WHERE comment_id = ? AND kind = 'review' AND read_at IS NULL").run(at, commentId);
}

interface SuggestionRow {
  comment_id: string; author_id: string | null; file_path: string; original_text: string; replacement_text: string;
  reviewer_id: string | null; status: CommentSuggestion["status"]; decided_by: string | null; decided_at: string | null;
  apply_update: Buffer | null; apply_range: string | null; start_offset: number; end_offset: number; orphaned: number;
}

export function suggestionRow(db: DatabaseConnection, projectId: string, commentId: string): SuggestionRow | undefined {
  return db.prepare(`SELECT s.*, c.author_id, c.file_path, c.start_offset, c.end_offset, c.orphaned FROM comment_suggestions s
    JOIN comments c ON c.id = s.comment_id WHERE c.project_id = ? AND c.id = ?`).get(projectId, commentId) as SuggestionRow | undefined;
}

export function hasPendingSuggestionApplication(db: DatabaseConnection, projectId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM comment_suggestions s JOIN comments c ON c.id = s.comment_id
    WHERE c.project_id = ? AND s.apply_update IS NOT NULL LIMIT 1`).get(projectId);
}

/** One query per discussion list, not one query per thread. */
export function suggestionsForProject(db: DatabaseConnection, projectId: string, sources: ReadonlyMap<string, string>): Map<string, CommentSuggestion> {
  const reviewers = new Set(suggestionReviewers(db, projectId).map((user) => user.id));
  const rows = db.prepare(`SELECT s.*, c.author_id, c.file_path, c.start_offset, c.end_offset, c.orphaned,
    reviewer.username AS reviewerUsername, reviewer.display_name AS reviewerDisplayName,
    decider.username AS decidedByUsername, decider.display_name AS decidedByDisplayName
    FROM comment_suggestions s JOIN comments c ON c.id = s.comment_id
    LEFT JOIN users reviewer ON reviewer.id = s.reviewer_id LEFT JOIN users decider ON decider.id = s.decided_by
    WHERE c.project_id = ?`).all(projectId) as Array<SuggestionRow & {
      reviewerUsername: string | null; reviewerDisplayName: string | null; decidedByUsername: string | null; decidedByDisplayName: string | null;
    }>;
  return new Map(rows.map((row) => [row.comment_id, {
    originalText: row.original_text, replacementText: row.replacement_text, reviewerId: row.reviewer_id,
    reviewerUsername: row.reviewerUsername, reviewerDisplayName: row.reviewerDisplayName,
    reviewerAvailable: row.reviewer_id !== null && row.reviewer_id !== row.author_id && reviewers.has(row.reviewer_id), status: row.status,
    applicable: !row.orphaned && sources.get(row.file_path)?.slice(row.start_offset, row.end_offset) === row.original_text,
    applying: row.apply_update !== null, decidedById: row.decided_by, decidedAt: row.decided_at,
    decidedByUsername: row.decidedByUsername, decidedByDisplayName: row.decidedByDisplayName
  }]));
}

/** Journal a CRDT update BEFORE applying it. Its item IDs make every replay idempotent. */
export function prepareSuggestionApplication(db: DatabaseConnection, projectId: string, commentId: string, doc: Y.Doc, userId: string, maxBytes: number): Uint8Array {
  const row = suggestionRow(db, projectId, commentId);
  if (!row) throw httpError(404, "COMMENT_NOT_FOUND");
  if (row.apply_update) return row.apply_update;
  if (row.status !== "pending") throw httpError(409, "SUGGESTION_DECIDED");
  const name = `source:${row.file_path}`;
  const text = doc.getText(name);
  if (row.orphaned || row.end_offset <= row.start_offset || text.toString().slice(row.start_offset, row.end_offset) !== row.original_text) {
    throw httpError(409, "SUGGESTION_SOURCE_CHANGED");
  }
  const source = text.toString();
  if (Buffer.byteLength(source.slice(0, row.start_offset) + row.replacement_text + source.slice(row.end_offset), "utf8") > maxBytes) {
    throw httpError(413, "FILE_TOO_LARGE", { path: row.file_path, size: Math.floor(maxBytes / 1024 / 1024) });
  }
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(copy);
    const target = copy.getText(name);
    copy.transact(() => {
      target.delete(row.start_offset, row.end_offset - row.start_offset);
      target.insert(row.start_offset, row.replacement_text);
    });
    const update = Y.encodeStateAsUpdate(copy, vector);
    const range = JSON.stringify([
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(target, row.start_offset, 0)),
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(target, row.start_offset + row.replacement_text.length, -1))
    ]);
    db.prepare("UPDATE comment_suggestions SET apply_update = ?, apply_range = ?, decided_by = ?, decided_at = ? WHERE comment_id = ?")
      .run(Buffer.from(update), range, userId, new Date().toISOString(), commentId);
    return update;
  } finally { copy.destroy(); }
}

/** Called while hydrating a room, before accepting any client edits. */
export function recoverSuggestionApplications(db: DatabaseConnection, projectId: string, doc: Y.Doc, recoveredState: boolean): boolean {
  const rows = db.prepare(`SELECT s.apply_update FROM comment_suggestions s JOIN comments c ON c.id = s.comment_id
    WHERE c.project_id = ? AND s.apply_update IS NOT NULL`).all(projectId) as Array<{ apply_update: Buffer }>;
  if (rows.length && !recoveredState) throw httpError(409, "SUGGESTION_RECOVERY_FAILED");
  for (const row of rows) Y.applyUpdate(doc, row.apply_update);
  return rows.length > 0;
}

/** Source, Yjs state and anchors must be durable before marking an application accepted. */
export function finishSuggestionApplications(db: DatabaseConnection, projectId: string, doc: Y.Doc): boolean {
  const rows = db.prepare(`SELECT s.*, c.file_path FROM comment_suggestions s JOIN comments c ON c.id = s.comment_id
    WHERE c.project_id = ? AND s.apply_update IS NOT NULL`).all(projectId) as SuggestionRow[];
  if (!rows.length) return false;
  db.transaction(() => {
    for (const row of rows) {
      const positions = JSON.parse(row.apply_range!) as Record<string, unknown>[];
      const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(positions[0]), doc);
      const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(positions[1]), doc);
      const text = doc.getText(`source:${row.file_path}`);
      if (start?.type === text && end?.type === text) {
        const source = text.toString();
        const anchor = createSourceAnchor(source, start.index, end.index);
        db.prepare(`UPDATE comments SET selected_text = ?, start_offset = ?, end_offset = ?, context_before = ?, context_after = ?,
          orphaned = 0, start_line = ?, end_line = ?, updated_at = ? WHERE id = ?`)
          .run(anchor.selectedText, anchor.startOffset, anchor.endOffset, anchor.contextBefore, anchor.contextAfter,
            offsetToLine(source, anchor.startOffset), offsetToLine(source, anchor.endOffset), row.decided_at, row.comment_id);
      }
      db.prepare("UPDATE comment_suggestions SET status = 'accepted', apply_update = NULL, apply_range = NULL WHERE comment_id = ?").run(row.comment_id);
      clearSuggestionReview(db, row.comment_id, row.decided_at!);
    }
  })();
  return true;
}
