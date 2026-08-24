import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { DatabaseConnection } from "../db.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject } from "../projects.js";
import {
  commentsSummaryForProject,
  now,
  projectJson,
  requireActualProjectOwner,
  tagsForProject,
  touchProject
} from "./projectShared.js";

interface ProjectMemberRouteContext {
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
}

/** Register project sharing, member permission, and ownership-transfer routes. */
export function registerProjectMemberRoutes(app: FastifyInstance, context: ProjectMemberRouteContext): void {
  const { db, collaboration, projectMutations } = context;

  app.get("/api/projects/:id/members", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
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
      return apiError(reply, 403, "PROJECT_TRANSFER_FORBIDDEN");
    }
    const body = (request.body ?? {}) as { userId?: unknown };
    if (typeof body.userId !== "string" || !body.userId) {
      return apiError(reply, 400, "PROJECT_TRANSFER_TARGET_INVALID");
    }
    if (body.userId === user.id) {
      return apiError(reply, 400, "PROJECT_TRANSFER_SELF");
    }
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");

    return await projectMutations.runExclusive(id, "project transfer", () => {
      const currentTarget = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
      // The synchronous preflight immediately precedes maintenance, so this
      // lookup cannot change before the operation starts.
      if (!currentTarget) throw httpError(404, "USER_NOT_FOUND");
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
        throw httpError(404, "USER_NOT_FOUND");
      }
    } });
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(userId)) {
      return apiError(reply, 404, "USER_NOT_FOUND");
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
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId);
    touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, "revoked");
    return { ok: true };
  });
}
