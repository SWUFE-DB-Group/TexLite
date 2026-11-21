import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { currentUser, publicUser, requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import {
  createSessionToken,
  digestToken,
  hashPassword,
  LoginRateLimiter,
  verifyPassword
} from "../security.js";
import { apiError, httpError, ValidationError } from "../http.js";
import { basePathHref } from "../../shared/basePath.js";

interface AuthRouteContext {
  config: Config;
  db: DatabaseConnection;
  loginLimiter: LoginRateLimiter;
  collaboration: CollaborationService;
}

const now = (): string => new Date().toISOString();

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

/** Register login, logout, session introspection, and password routes. */
export function registerAuthRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  const { config, db, loginLimiter, collaboration } = context;

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const username = text(body?.username, 64);
    const ip = request.ip || "127.0.0.1";
    const rateLimitKey = `${ip}:${username.toLowerCase()}`;
    if (loginLimiter.isLocked(rateLimitKey)) {
      return apiError(reply, 429, "AUTH_RATE_LIMITED");
    }
    const password = typeof body?.password === "string" ? body.password : "";
    const candidate = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
    const verified = candidate && !candidate.disabled && await verifyPassword(password, candidate.password_hash);
    const user = verified ? db.prepare("SELECT * FROM users WHERE id = ? AND disabled = 0 AND password_hash = ?")
      .get(candidate.id, candidate.password_hash) as UserRow | undefined : undefined;
    if (!user) {
      const result = loginLimiter.recordFailure(rateLimitKey);
      if (result.locked) {
        return apiError(reply, 429, "AUTH_RATE_LIMITED");
      }
      return apiError(reply, 401, "AUTH_INVALID");
    }
    loginLimiter.reset(rateLimitKey);
    const session = createSessionToken();
    const createdAt = now();
    const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(session.digest, user.id, expires.toISOString(), createdAt);
    const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    const cookiePath = basePathHref(config.basePath);
    reply.setCookie("texlite_session", session.token, {
      path: cookiePath,
      httpOnly: true,
      sameSite: "strict",
      secure: isSecure,
      expires
    });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies.texlite_session;
    if (token) {
      const sessionId = digestToken(token);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      collaboration.disconnectSession(sessionId);
    }
    const cookiePath = basePathHref(config.basePath);
    reply.clearCookie("texlite_session", { path: cookiePath });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    return { user: publicUser(user) };
  });

  app.put("/api/me/password", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return apiError(reply, 400, "CURRENT_PASSWORD_INVALID");
    }
    if (user.must_change_password && newPassword === currentPassword) {
      return apiError(reply, 400, "PASSWORD_UNCHANGED");
    }
    const passwordHash = await hashPassword(newPassword);
    const sessionId = digestToken(request.cookies.texlite_session!);
    db.transaction(() => {
      if (!currentUser(request, db, true)) throw httpError(401, "AUTH_REQUIRED");
      const updated = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND password_hash = ?")
        .run(passwordHash, user.id, user.password_hash);
      if (updated.changes !== 1) throw httpError(400, "CURRENT_PASSWORD_INVALID");
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, sessionId);
    })();
    collaboration.disconnectOtherSessions(user.id, sessionId);
    return { ok: true };
  });
}
