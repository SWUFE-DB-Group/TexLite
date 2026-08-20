import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseConnection, UserRow } from "./db.js";
import { digestToken } from "./security.js";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  disabled: boolean;
  mustChangePassword: boolean;
  canCreateProjects: boolean;
  createdAt: string;
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    disabled: Boolean(user.disabled),
    mustChangePassword: Boolean(user.must_change_password),
    canCreateProjects: Boolean(user.can_create_projects) || user.role === "admin",
    createdAt: user.created_at
  };
}

const requestUserCache = new WeakMap<FastifyRequest, UserRow | null>();

export function clearCurrentUserCache(request: FastifyRequest): void {
  requestUserCache.delete(request);
}

export function currentUser(request: FastifyRequest, db: DatabaseConnection): UserRow | null {
  if (requestUserCache.has(request)) {
    return requestUserCache.get(request) ?? null;
  }
  const token = request.cookies.texlite_session;
  if (!token) {
    requestUserCache.set(request, null);
    return null;
  }
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0
  `).get(digestToken(token), new Date().toISOString()) as UserRow | undefined;
  const user = row ?? null;
  requestUserCache.set(request, user);
  return user;
}

export function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabaseConnection
): UserRow | null {
  const user = currentUser(request, db);
  if (!user) {
    void reply.code(401).send({ code: "AUTH_REQUIRED", error: "请先登录" });
    return null;
  }
  return user;
}

export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabaseConnection
): UserRow | null {
  const user = requireUser(request, reply, db);
  if (!user) return null;
  if (user.role !== "admin") {
    void reply.code(403).send({ code: "ADMIN_REQUIRED", error: "需要管理员权限" });
    return null;
  }
  return user;
}
