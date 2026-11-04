import fs from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { accessibleProject, canEdit } from "../projects.js";
import { apiError, httpError } from "../http.js";
import { resolveSourcePath } from "../files.js";
import { isCollaborativeTextFile } from "../collaboration.js";
import { attachSuggestion, clearSuggestionReview, requestSuggestionReview, suggestionReviewers, suggestionRow, validateSuggestionReplacement } from "../commentSuggestions.js";
import { commentsForFile, commentsSummaryForProject, now } from "./projectShared.js";
import type { CommentRouteContext } from "./comments.js";
import type { CommentMutationResult } from "../../shared/comments.js";

export function registerSuggestionRoutes(app: FastifyInstance, context: CommentRouteContext): void {
  const { db, config, collaboration, projectMutations } = context;
  const result = (projectId: string, commentId: string, filePath: string): CommentMutationResult => {
    const comment = commentsForFile(db, config, projectId, filePath).find((item) => item.id === commentId)!;
    collaboration.signalComments(projectId);
    return { change: { kind: "suggestion", commentId, filePath, suggestion: comment.suggestion! }, summary: commentsSummaryForProject(db, projectId) };
  };
  app.get("/api/projects/:id/suggestion-reviewers", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const { commentId } = request.query as { commentId?: string };
    let authorId: string | null = user.id;
    if (commentId !== undefined) {
      const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?").get(commentId, id) as { author_id: string | null } | undefined;
      if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND");
      authorId = comment.author_id;
    }
    return { users: suggestionReviewers(db, id, authorId), ownerId: project.owner_id };
  });

  app.post("/api/projects/:id/comments/:commentId/suggestion", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return apiError(reply, 400, "REQUEST_INVALID");
    const body = request.body as { sourceHash?: unknown; replacementText?: unknown; reviewerId?: unknown };
    return projectMutations.runWrite(id, () => {
      const comment = db.prepare("SELECT * FROM comments WHERE id = ? AND project_id = ?").get(commentId, id) as {
        author_id: string | null; resolved: number; file_path: string; orphaned: number; start_offset: number; end_offset: number; selected_text: string;
      } | undefined;
      if (!comment) throw httpError(404, "COMMENT_NOT_FOUND");
      if (comment.author_id !== user.id) throw httpError(403, "COMMENT_EDIT_FORBIDDEN");
      const absolute = resolveSourcePath(config, id, comment.file_path);
      if (comment.resolved || comment.orphaned || !isCollaborativeTextFile(comment.file_path) || !fs.existsSync(absolute)) throw httpError(409, "SUGGESTION_SOURCE_CHANGED");
      const source = fs.readFileSync(absolute, "utf8");
      if (comment.orphaned || createHash("sha256").update(source, "utf8").digest("hex") !== body.sourceHash
        || source.slice(comment.start_offset, comment.end_offset) !== comment.selected_text) throw httpError(409, "SUGGESTION_SOURCE_CHANGED");
      db.transaction(() => attachSuggestion(db, id, commentId, user.id, comment.selected_text, body))();
      return result(id, commentId, comment.file_path);
    }, { preflight: () => { if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND"); } });
  });

  app.post("/api/projects/:id/comments/:commentId/suggestion/review", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    const { action, expectedReplacementText } = (request.body ?? {}) as { action?: unknown; expectedReplacementText?: unknown };
    if (action !== "accept" && action !== "reject") return apiError(reply, 400, "REQUEST_INVALID");
    const validate = () => {
      const project = accessibleProject(db, id, user);
      const row = suggestionRow(db, id, commentId);
      if (!project || !canEdit(project) || row?.reviewer_id !== user.id || !suggestionReviewers(db, id).some((candidate) => candidate.id === user.id)) {
        throw httpError(403, "SUGGESTION_REVIEW_FORBIDDEN");
      }
      if (row.author_id === user.id) throw httpError(403, "SUGGESTION_SELF_REVIEW");
      // Bind the decision to the replacement actually displayed by the reviewer.
      // Repeat inside the project write queue after room preparation and flushing.
      if (typeof expectedReplacementText !== "string" || row.replacement_text !== expectedReplacementText) throw httpError(409, "SUGGESTION_UPDATED");
      return row;
    };
    validate();
    if (action === "accept") await collaboration.prepareSourceEditRoom(id);
    return projectMutations.runWrite(id, () => {
      const row = validate();
      const expected = action === "accept" ? "accepted" : "rejected";
      if (row.status === expected) return result(id, commentId, row.file_path);
      if (row.status !== "pending") throw httpError(409, "SUGGESTION_DECIDED");
      if (action === "accept") {
        if (!fs.existsSync(resolveSourcePath(config, id, row.file_path))) throw httpError(409, "SUGGESTION_SOURCE_CHANGED");
        collaboration.applyCommentSuggestion(id, row.file_path, commentId, user.id);
      }
      else {
        if (row.apply_update) throw httpError(409, "SUGGESTION_APPLYING");
        db.transaction(() => {
          const at = now();
          db.prepare("UPDATE comment_suggestions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE comment_id = ?").run(user.id, at, commentId);
          clearSuggestionReview(db, commentId, at);
        })();
      }
      return result(id, commentId, row.file_path);
    }, { preflight: () => { validate(); } });
  });

  app.patch("/api/projects/:id/comments/:commentId/suggestion", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return apiError(reply, 400, "REQUEST_INVALID");
    const body = request.body as { replacementText?: unknown; expectedReplacementText?: unknown; reviewerId?: unknown };
    // Assignment is fixed when a suggestion is created; this endpoint only edits its text.
    if (body.reviewerId !== undefined || typeof body.expectedReplacementText !== "string") return apiError(reply, 400, "REQUEST_INVALID");
    const validate = () => {
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
      const row = suggestionRow(db, id, commentId);
      if (!row) throw httpError(404, "COMMENT_NOT_FOUND");
      if (row.author_id !== user.id) throw httpError(403, "COMMENT_EDIT_FORBIDDEN");
      if (row.status !== "pending") throw httpError(409, "SUGGESTION_DECIDED");
      if (row.apply_update) throw httpError(409, "SUGGESTION_APPLYING");
      return row;
    };
    return projectMutations.runWrite(id, () => {
      const row = validate();
      validateSuggestionReplacement(row.original_text, body.replacementText);
      // A retried save with identical text is a no-op, not another review request.
      if (row.replacement_text === body.replacementText) return result(id, commentId, row.file_path);
      if (row.replacement_text !== body.expectedReplacementText) throw httpError(409, "SUGGESTION_UPDATED");
      db.transaction(() => {
        const at = now();
        db.prepare("UPDATE comment_suggestions SET replacement_text = ? WHERE comment_id = ?").run(body.replacementText, commentId);
        clearSuggestionReview(db, commentId, at);
        if (row.reviewer_id && suggestionReviewers(db, id, row.author_id).some((candidate) => candidate.id === row.reviewer_id)) {
          requestSuggestionReview(db, id, commentId, row.reviewer_id, user.id, at);
        }
      })();
      return result(id, commentId, row.file_path);
    }, { preflight: () => { validate(); } });
  });
}
