import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { currentUser, publicUser, requireAdmin, requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import { activeAdminCount, type DatabaseConnection, type UserRow } from "../db.js";
import { apiError, httpError, ValidationError } from "../http.js";
import type { ProjectDeletionCleanup } from "../projectDeletionCleanup.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { hashPassword } from "../security.js";
import type { UserManagementSummary } from "../../shared/userManagement.js";

interface UserManagementRouteContext {
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  projectDeletionCleanup: ProjectDeletionCleanup;
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
  const { db, collaboration, projectMutations, projectDeletionCleanup } = context;
  const refreshAdministrator = (request: FastifyRequest): UserRow => {
    const actor = currentUser(request, db, true);
    if (!actor) throw httpError(401, "AUTH_REQUIRED");
    if (actor.must_change_password) throw httpError(403, "PASSWORD_CHANGE_REQUIRED");
    if (actor.role !== "admin") throw httpError(403, "ADMIN_REQUIRED");
    return actor;
  };

  app.get("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const query = request.query as { q?: string; page?: string };
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const requestedPage = Number(query.page ?? "1");
    const pageSize = 20;
    const where = search ? "WHERE (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')" : "";
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const params = search ? [pattern, pattern] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...params) as { count: number }).count;
    const totalPages = Math.ceil(total / pageSize);
    const page = Math.min(
      Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
      Math.max(1, totalPages)
    );
    const users = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS owned_projects
      FROM users u ${where}
      ORDER BY u.created_at, u.username COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as unknown as Array<UserRow & { owned_projects: number }>;
    const summary = db.prepare(`SELECT COUNT(*) AS totalUsers,
      COUNT(CASE WHEN role = 'admin' THEN 1 END) AS administrators,
      COUNT(CASE WHEN role = 'admin' OR can_create_projects = 1 THEN 1 END) AS projectCreators,
      (SELECT COUNT(*) FROM projects) AS totalProjects,
      (SELECT COUNT(DISTINCT owner_id) FROM projects) AS projectOwners FROM users`).get() as UserManagementSummary;
    return {
      users: users.map((user) => ({ ...publicUser(user), ownedProjects: user.owned_projects })),
      pagination: { page, pageSize, total, totalPages },
      summary
    };
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
      must_change_password: 1, can_create_projects: body?.canCreateProjects === true ? 1 : 0, created_at: now()
    };
    refreshAdministrator(request);
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`)
      .run(user.id, user.username, user.display_name, user.password_hash, user.role, user.can_create_projects, user.created_at);
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const role = body.role === "admin" || body.role === "user" ? body.role : null;
    const disabled = typeof body.disabled === "boolean" ? Number(body.disabled) : null;
    const canCreateProjects = typeof body.canCreateProjects === "boolean" ? Number(body.canCreateProjects) : null;
    const displayName = typeof body.displayName === "string" ? text(body.displayName, 100) : null;
    const passwordHash = typeof body.password === "string" && body.password ? await hashPassword(body.password) : null;
    const { updated, revoke } = db.transaction(() => {
      const admin = refreshAdministrator(request);
      const target = db.prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
      if (!target) throw httpError(404, "USER_NOT_FOUND");
      const removesAdminAccess = (disabled ?? target.disabled) !== 0 || (role ?? target.role) !== "admin";
      if (target.id === admin.id && removesAdminAccess) throw httpError(400, "SELF_RESTRICT_FORBIDDEN");
      if (!target.disabled && target.role === "admin" && removesAdminAccess && activeAdminCount(db) <= 1) {
        throw httpError(400, "LAST_ADMIN");
      }
      const updated = db.prepare<unknown[], UserRow>(`UPDATE users SET
        display_name = COALESCE(?, display_name), role = COALESCE(?, role), disabled = COALESCE(?, disabled),
        password_hash = COALESCE(?, password_hash), must_change_password = COALESCE(?, must_change_password),
        can_create_projects = COALESCE(?, can_create_projects) WHERE id = ? RETURNING *`)
        .get(displayName, role, disabled, passwordHash, passwordHash ? 1 : null, canCreateProjects, id)!;
      const revoke = Boolean(updated.disabled || passwordHash);
      if (revoke) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      return { updated, revoke };
    })();
    if (revoke) collaboration.disconnectUser(id, "user-disabled-or-reset");
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
      owned = db.prepare("SELECT id FROM projects WHERE owner_id = ? ORDER BY created_at, rowid").all(id) as Array<{ id: string }>;
      if (!body.deleteProjects) {
        // Persist any active drafts while the old owner row still exists. This
        // is synchronous, so no edit can arrive between this flush and the
        // ownership update below, and last_modified_by remains FK-safe.
        for (const project of owned) projectMutations.flushProject(project.id);
      }
      if (body.deleteProjects) {
        for (const project of owned) projectDeletionCleanup.enqueue(project.id);
        db.prepare("DELETE FROM projects WHERE owner_id = ?").run(id);
      } else {
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
    collaboration.disconnectUser(id, "user-deleted");
    for (const project of owned) {
      if (body.deleteProjects) await projectDeletionCleanup.clean(project.id);
      else await projectMutations.runExclusive(project.id, "admin ownership transfer", () => {
        collaboration.resetProject(project.id);
      }, { flush: false });
    }
    return { ok: true, deletedProjects: body.deleteProjects ? owned.length : 0 };
  });

  app.get("/api/users", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    const rows = db.prepare("SELECT id, username, display_name AS displayName FROM users WHERE disabled = 0 ORDER BY username").all();
    return { users: rows };
  });
}
