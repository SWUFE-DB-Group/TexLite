import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { publicUser, requireAdmin, requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import { activeAdminCount, type DatabaseConnection, type UserRow } from "../db.js";
import { removeProjectDirectory } from "../files.js";
import { apiError, httpError, ValidationError } from "../http.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { hashPassword } from "../security.js";

interface UserManagementRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
}

const now = (): string => new Date().toISOString();

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

/** Register administrator-facing user management and the active-user directory. */
export function registerUserManagementRoutes(app: FastifyInstance, context: UserManagementRouteContext): void {
  const { config, db, collaboration, projectMutations, latexCompletions, projectOutlines } = context;

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
    const username = text(body?.username, 64);
    if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) return apiError(reply, 400, "USERNAME_INVALID");
    const displayName = text(body?.displayName ?? username, 100);
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
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");
    const body = request.body as Record<string, unknown>;
    const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : target.role;
    const disabled = typeof body.disabled === "boolean" ? Number(body.disabled) : target.disabled;
    const canCreateProjects = typeof body.canCreateProjects === "boolean"
      ? Number(body.canCreateProjects) : target.can_create_projects;
    if (target.role === "admin" && (!role || role !== "admin" || disabled) && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN");
    }
    const displayName = typeof body.displayName === "string" ? text(body.displayName, 100) : target.display_name;
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
      collaboration.disconnectUser(id, "user-disabled-or-reset");
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
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");
    if (target.id === admin.id) return apiError(reply, 400, "SELF_DELETE_FORBIDDEN");
    if (target.role === "admin" && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN");
    }
    let owned: Array<{ id: string }> = [];
    // Capture and mutate the complete owned-project set in the same synchronous
    // transaction. There is deliberately no await before COMMIT: another
    // request cannot transfer or create a project for this user between the
    // snapshot and the owner/delete statements.
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentTarget = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
      if (!currentTarget) throw httpError(404, "USER_NOT_FOUND");
      if (currentTarget.role === "admin" && activeAdminCount(db) <= 1) {
        throw httpError(400, "LAST_ADMIN");
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
    collaboration.disconnectUser(id, "user-deleted");
    return { ok: true, deletedProjects: body.deleteProjects ? owned.length : 0 };
  });

  app.get("/api/users", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    const rows = db.prepare("SELECT id, username, display_name AS displayName FROM users WHERE disabled = 0 ORDER BY username").all();
    return { users: rows };
  });
}
