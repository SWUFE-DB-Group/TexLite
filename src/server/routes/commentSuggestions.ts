import fs from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { accessibleProject, canEdit } from "../projects.js";
import { apiError, httpError } from "../http.js";
import { resolveSourcePath } from "../files.js";
import { isCollaborativeTextFile } from "../collaboration.js";
import { attachSuggestion, clearSuggestionReview, requestSuggestionReview, suggestionReviewers, suggestionRow } from "../commentSuggestions.js";
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
    const action = (request.body as { action?: unknown })?.action;
    if (action !== "accept" && action !== "reject") return apiError(reply, 400, "REQUEST_INVALID");
    const validate = () => {
      const project = accessibleProject(db, id, user);
      const row = suggestionRow(db, id, commentId);
      if (!project || !canEdit(project) || row?.reviewer_id !== user.id || !suggestionReviewers(db, id).some((candidate) => candidate.id === user.id)) {
        throw httpError(403, "SUGGESTION_REVIEW_FORBIDDEN");
      }
      if (row.author_id === user.id) throw httpError(403, "SUGGESTION_SELF_REVIEW");
      return row;
    };
    validate();
    if (action === "accept") await collaboration.prepareSuggestionRoom(id);
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
    const reviewerId = (request.body as { reviewerId?: unknown })?.reviewerId;
    return projectMutations.runWrite(id, () => {
      const row = suggestionRow(db, id, commentId);
      if (!row) throw httpError(404, "COMMENT_NOT_FOUND");
      if (row.status !== "pending") throw httpError(409, "SUGGESTION_DECIDED");
      if (row.apply_update) throw httpError(409, "SUGGESTION_APPLYING");
      if (reviewerId === row.author_id) throw httpError(400, "SUGGESTION_SELF_REVIEW");
      if (typeof reviewerId !== "string" || !suggestionReviewers(db, id, row.author_id).some((candidate) => candidate.id === reviewerId)) throw httpError(400, "SUGGESTION_REVIEWER_INVALID");
      if (row.reviewer_id !== reviewerId) db.transaction(() => {
        clearSuggestionReview(db, commentId, now());
        db.prepare("UPDATE comment_suggestions SET reviewer_id = ? WHERE comment_id = ?").run(reviewerId, commentId);
        requestSuggestionReview(db, id, commentId, reviewerId, user.id, now());
      })();
      return result(id, commentId, row.file_path);
    }, { preflight: () => {
      if (accessibleProject(db, id, user)?.permission !== "owner") throw httpError(403, "MEMBERS_MANAGE_FORBIDDEN");
    } });
  });
}
