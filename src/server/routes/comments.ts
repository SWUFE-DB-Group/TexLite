import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { createSourceAnchor, offsetToLine } from "../anchors.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { resolveSourcePath, safeRelativePath } from "../files.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject } from "../projects.js";
import { commentsForFile, now, repliesForComment, text } from "./projectShared.js";

interface CommentRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
}

/** Register source-anchored comments and reply routes. */
export function registerCommentRoutes(app: FastifyInstance, context: CommentRouteContext): void {
  const { config, db, collaboration, projectMutations } = context;

  app.get("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { path: filePath } = request.query as { path?: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const relative = safeRelativePath(filePath ?? "");
    return {
      comments: await projectMutations.runConsistentRead(id, () => commentsForFile(db, config, id, relative), {
        preflight: () => {
          if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
        }
      })
    };
  });

  app.post("/api/projects/:id/comments", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as Record<string, unknown>;
    const createdAt = now();
    const filePath = safeRelativePath(typeof body.path === "string" ? body.path : "");
    return await projectMutations.runWrite(id, () => {
      const absolute = resolveSourcePath(config, id, filePath);
      if (!fs.existsSync(absolute)) return apiError(reply, 404, "COMMENT_FILE_NOT_FOUND");
      const source = fs.readFileSync(absolute, "utf8");
      if (!Number.isInteger(body.startOffset) || !Number.isInteger(body.endOffset)) {
        return apiError(reply, 400, "COMMENT_RANGE_INVALID");
      }
      const anchor = createSourceAnchor(source, Number(body.startOffset), Number(body.endOffset));
      const comment = {
        id: randomUUID(), filePath,
        content: text(body.content, 5000)
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
      if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
    } });
  });

  app.post("/api/projects/:id/comments/:commentId/replies", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM comments WHERE id = ? AND project_id = ?").get(commentId, id)) {
      return apiError(reply, 404, "COMMENT_NOT_FOUND");
    }
    const body = request.body as { content?: unknown };
    const createdAt = now();
    const replyId = randomUUID();
    db.prepare(`INSERT INTO comment_replies (id, comment_id, author_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(replyId, commentId, user.id, text(body.content, 5000), createdAt, createdAt);
    const created = repliesForComment(db, commentId).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return reply.code(201).send({ reply: created });
  });

  app.patch("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND");
    const body = request.body as { resolved?: unknown; content?: unknown };
    const changedAt = now();
    let changed = false;
    if (typeof body.content === "string") {
      if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_EDIT_FORBIDDEN");
      db.prepare("UPDATE comments SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?")
        .run(text(body.content, 5000), changedAt, changedAt, commentId);
      changed = true;
    }
    if (typeof body.resolved === "boolean") {
      db.prepare("UPDATE comments SET resolved = ?, updated_at = ? WHERE id = ?")
        .run(body.resolved ? 1 : 0, changedAt, commentId);
      changed = true;
    }
    if (!changed) return apiError(reply, 400, "COMMENT_UPDATE_EMPTY");
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.delete("/api/projects/:id/comments/:commentId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId } = request.params as { id: string; commentId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const comment = db.prepare("SELECT author_id FROM comments WHERE id = ? AND project_id = ?")
      .get(commentId, id) as { author_id: string | null } | undefined;
    if (!comment) return apiError(reply, 404, "COMMENT_NOT_FOUND");
    if (comment.author_id !== user.id) return apiError(reply, 403, "COMMENT_DELETE_FORBIDDEN");
    db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
    collaboration.signalComments(id);
    return { ok: true };
  });

  app.patch("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_EDIT_FORBIDDEN");
    const body = request.body as { content?: unknown };
    const changedAt = now();
    db.prepare("UPDATE comment_replies SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?")
      .run(text(body.content, 5000), changedAt, changedAt, replyId);
    const updated = repliesForComment(db, commentId).find((item) => item.id === replyId);
    collaboration.signalComments(id);
    return { reply: updated };
  });

  app.delete("/api/projects/:id/comments/:commentId/replies/:replyId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, commentId, replyId } = request.params as { id: string; commentId: string; replyId: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const commentReply = db.prepare(`SELECT reply.author_id FROM comment_replies reply
      JOIN comments comment ON comment.id = reply.comment_id
      WHERE reply.id = ? AND reply.comment_id = ? AND comment.project_id = ?`)
      .get(replyId, commentId, id) as { author_id: string | null } | undefined;
    if (!commentReply) return apiError(reply, 404, "REPLY_NOT_FOUND");
    if (commentReply.author_id !== user.id) return apiError(reply, 403, "REPLY_DELETE_FORBIDDEN");
    db.prepare("DELETE FROM comment_replies WHERE id = ?").run(replyId);
    collaboration.signalComments(id);
    return { ok: true };
  });
}
