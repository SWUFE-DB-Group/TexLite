import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { safeRelativePath } from "../files.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { resolveProjectReference, validReferenceKey } from "../projectReferences.js";
import { accessibleProject } from "../projects.js";
import type { LatexReferenceKind } from "../../shared/latexReferences.js";

interface ProjectReferenceRouteContext {
  config: Config;
  db: DatabaseConnection;
  projectMutations: ProjectMutationCoordinator;
}

/** Register Ctrl/Cmd-click source-reference navigation routes. */
export function registerProjectReferenceRoutes(app: FastifyInstance, context: ProjectReferenceRouteContext): void {
  const { config, db, projectMutations } = context;

  app.get("/api/projects/:id/references/resolve", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const query = request.query as { kind?: unknown; key?: unknown; path?: unknown; mainFile?: unknown };
    const kind = query.kind === "citation" || query.kind === "label" ? query.kind as LatexReferenceKind : null;
    if (!kind || !validReferenceKey(query.key)) return apiError(reply, 400, "REQUEST_INVALID");
    const key = query.key;
    const preferredPath = typeof query.path === "string" && query.path ? safeRelativePath(query.path) : "";
    const requestedMainFile = typeof query.mainFile === "string" && query.mainFile
      ? safeRelativePath(query.mainFile)
      : "";
    const mainFile = /\.tex$/i.test(requestedMainFile) ? requestedMainFile : project.main_file;
    return await projectMutations.runConsistentRead(id, async () => ({
      target: await resolveProjectReference(config, id, kind, key, { preferredPath, mainFile })
    }), {
      preflight: () => {
        if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND");
      }
    });
  });
}
