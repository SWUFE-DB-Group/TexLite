import type { FastifyInstance, FastifyRequest } from "fastify";
import { currentUser, requireAdmin, requireUser } from "../auth.js";
import type { DatabaseConnection } from "../db.js";
import type { AgentService } from "../agents/sessions.js";
import { apiError, httpError } from "../http.js";
import { isAgentId } from "../../shared/agentProtocol.js";
import { digestToken } from "../security.js";

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw httpError(400, "REQUEST_INVALID");
  return value.trim();
}

function terminalOriginAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const forwarded = request.headers["x-forwarded-proto"];
    const protocol = forwarded === "https" || forwarded === "http" ? forwarded : request.protocol;
    return parsed.host === request.headers.host && parsed.protocol === `${protocol}:` && parsed.origin === origin;
  } catch { return false; }
}

/** Task owners get terminal access; administrators get separate metadata/cleanup routes. */
export function registerAgentRoutes(app: FastifyInstance, { db, agents }: { db: DatabaseConnection; agents: AgentService }): void {
  app.get("/api/agents/access", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { allowed } = agents.policy();
    const hasTasks = agents.list(user, false, {}).total > 0;
    return { visible: allowed.length > 0 || hasTasks };
  });
  app.get("/api/agents", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    return agents.catalog();
  });
  app.get("/api/admin/agents", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    return agents.catalog();
  });
  app.post("/api/admin/agents/refresh", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    return agents.catalog(true);
  });
  app.patch("/api/admin/agents", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const body = request.body as { allowed?: unknown } | null;
    if (!Array.isArray(body?.allowed) || !body.allowed.every(isAgentId)) return apiError(reply, 400, "REQUEST_INVALID");
    await agents.setPolicy({ allowed: body.allowed });
    return agents.catalog();
  });
  for (const administration of [false, true]) {
    const prefix = administration ? "/api/admin/agent-tasks" : "/api/agent-tasks";
    app.get(prefix, async (request, reply) => {
      const user = administration ? requireAdmin(request, reply, db) : requireUser(request, reply, db);
      if (!user) return;
      const raw = request.query as Record<string, unknown>;
      const query: Record<string, string> = {};
      for (const key of ["project", "user", "agent", "state", "page"]) if (typeof raw[key] === "string") query[key] = raw[key];
      return agents.list(user, administration, query);
    });
    app.post(`${prefix}/:taskId/stop`, async (request, reply) => {
      const user = administration ? requireAdmin(request, reply, db) : requireUser(request, reply, db);
      if (!user) return;
      return { task: await agents.stop((request.params as { taskId: string }).taskId, user, administration) };
    });
    app.delete(`${prefix}/:taskId`, async (request, reply) => {
      const user = administration ? requireAdmin(request, reply, db) : requireUser(request, reply, db);
      if (!user) return;
      await agents.remove((request.params as { taskId: string }).taskId, user, administration);
      return { ok: true };
    });
  }
  app.post("/api/projects/:id/agent-tasks", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { agentId?: unknown; title?: unknown } | null;
    if (!isAgentId(body?.agentId)) return apiError(reply, 400, "REQUEST_INVALID");
    const task = await agents.create((request.params as { id: string }).id, user, body.agentId, title(body.title));
    return reply.code(201).send({ task });
  });
  app.get("/api/agent-tasks/:taskId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    return { task: agents.task((request.params as { taskId: string }).taskId, user) };
  });
  app.patch("/api/agent-tasks/:taskId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { title?: unknown } | null;
    return { task: agents.update((request.params as { taskId: string }).taskId, user, { title: title(body?.title) }) };
  });
  app.post("/api/agent-tasks/:taskId/start", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { resume?: unknown } | undefined;
    if (body?.resume !== undefined && typeof body.resume !== "boolean") return apiError(reply, 400, "REQUEST_INVALID");
    return { task: await agents.start((request.params as { taskId: string }).taskId, user, body?.resume === true) };
  });
  app.get("/api/agent-tasks/:taskId/terminal", { websocket: true }, (socket, request) => {
    const user = currentUser(request, db);
    if (!user || !terminalOriginAllowed(request)) { socket.close(1008, "Access denied"); return; }
    const token = digestToken(request.cookies.texlite_session!);
    // currentUser intentionally caches one HTTP request. A WebSocket outlives
    // that request, so recheck its actual session row instead of that cache.
    const session = db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.disabled = 0 AND u.must_change_password = 0`);
    try {
      agents.attach((request.params as { taskId: string }).taskId, user, socket,
        () => Boolean(session.get(token, user.id, new Date().toISOString())));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "AGENT_SESSION_BUSY";
      socket.send(JSON.stringify({ type: "error", code }));
      socket.close(1008, "Terminal unavailable");
    }
  });
}
