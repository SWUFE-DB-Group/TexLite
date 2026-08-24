import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { publicUser, requireUser } from "../auth.js";
import {
  createSessionToken,
  digestToken,
  hashPassword,
  LoginRateLimiter,
  verifyPassword
} from "../security.js";
import { apiError, ValidationError } from "../http.js";

interface AuthRouteContext {
  config: Config;
  db: DatabaseConnection;
  loginLimiter: LoginRateLimiter;
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
  const { config, db, loginLimiter } = context;

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const username = text(body?.username, 64);
    const ip = request.ip || "127.0.0.1";
    const rateLimitKey = `${ip}:${username.toLowerCase()}`;
    if (loginLimiter.isLocked(rateLimitKey)) {
      return apiError(reply, 429, "AUTH_RATE_LIMITED");
    }
    const password = typeof body?.password === "string" ? body.password : "";
    const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
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
    reply.setCookie("texlite_session", session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: isSecure,
      expires
    });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies.texlite_session;
    if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
    reply.clearCookie("texlite_session", { path: "/" });
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
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(user.id, digestToken(request.cookies.texlite_session ?? ""));
    return { ok: true };
  });
}
