import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { currentUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { DatabaseConnection } from "../db.js";
import type { MetricRegistry } from "../metrics.js";
import { digestToken } from "../security.js";

interface CollaborationRouteContext {
  db: DatabaseConnection;
  collaboration: CollaborationService;
  metrics: MetricRegistry;
}

/** Register the project-scoped WebSocket endpoint used for live editing. */
export function registerCollaborationRoutes(app: FastifyInstance, context: CollaborationRouteContext): void {
  const { db, collaboration, metrics } = context;

  app.get("/api/collaboration/:id", { websocket: true }, (socket, request) => {
    const user = currentUser(request, db);
    const token = request.cookies.texlite_session;
    if (!user || !token || user.must_change_password) {
      socket.close(1008, "Authentication required");
      return;
    }
    const { id } = request.params as { id: string };
    const startedAt = performance.now();
    void collaboration.connect(socket, id, user, digestToken(token))
      .finally(() => metrics.record("collaboration.connect", performance.now() - startedAt));
  });
}
