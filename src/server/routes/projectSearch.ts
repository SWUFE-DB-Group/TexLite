import type { FastifyInstance } from "fastify";
import { isTextContent } from "../../shared/fileTypes.js";
import { PROJECT_SEARCH_MAX_QUERY_LENGTH, PROJECT_SEARCH_MAX_MATCHES, PROJECT_SEARCH_MAX_REPLACEMENT_LENGTH, type ProjectReplaceTarget, type ProjectSearchOptions } from "../../shared/projectSearch.js";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { CollaborationService } from "../collaboration.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { searchProject } from "../projectSearch.js";
import { accessibleProject } from "../projects.js";
import { requireEditableProject } from "./projectShared.js";
import { prepareProjectReplacement } from "../projectReplace.js";
import { safeRelativePath } from "../files.js";

function searchOptions(body: Record<string, unknown> | null): ProjectSearchOptions {
  if (!body || typeof body.query !== "string" || body.query.length === 0
    || body.query.length > PROJECT_SEARCH_MAX_QUERY_LENGTH || /[\r\n\0]/.test(body.query)
    || (body.caseSensitive !== undefined && typeof body.caseSensitive !== "boolean")
    || (body.wholeWord !== undefined && typeof body.wholeWord !== "boolean")) throw httpError(400, "REQUEST_INVALID");
  return { query: body.query, caseSensitive: body.caseSensitive !== false, wholeWord: body.wholeWord !== false };
}

export function registerProjectSearchRoutes(app: FastifyInstance, { config, db, projectMutations, collaboration }: {
  config: Config; db: DatabaseConnection; projectMutations: ProjectMutationCoordinator; collaboration: CollaborationService;
}): void {
  app.post("/api/projects/:id/search", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const options = searchOptions(request.body as Record<string, unknown> | null);
    return await projectMutations.runConsistentRead(id, () => searchProject(config, id, options), {
      preflight: () => { if (!accessibleProject(db, id, user)) throw httpError(404, "PROJECT_NOT_FOUND"); }
    });
  });

  app.post("/api/projects/:id/search/replace", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { id } = request.params as { id: string };
    requireEditableProject(db, id, user);
    const body = request.body as Record<string, unknown> | null;
    const options = searchOptions(body);
    if (typeof body?.replacement !== "string" || body.replacement.length > PROJECT_SEARCH_MAX_REPLACEMENT_LENGTH
      || !isTextContent(Buffer.from(body.replacement, "utf8")) || !Array.isArray(body.targets)
      || !body.targets.length || body.targets.length > PROJECT_SEARCH_MAX_MATCHES) throw httpError(400, "REQUEST_INVALID");
    const replacement = body.replacement;
    const paths = new Set<string>();
    let totalRanges = 0;
    const targets: ProjectReplaceTarget[] = body.targets.map((value: unknown) => {
      const target = value as Partial<ProjectReplaceTarget> | null;
      if (!target || typeof target.path !== "string" || safeRelativePath(target.path) !== target.path || paths.has(target.path)
        || typeof target.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(target.sourceHash)
        || !Array.isArray(target.ranges) || !target.ranges.length
        || target.ranges.some((range) => !range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
          || range.from < 0 || range.to <= range.from)) throw httpError(400, "REQUEST_INVALID");
      const ranges = [...target.ranges].sort((a, b) => a.from - b.from);
      if (ranges.some((range, index) => index > 0 && range.from < ranges[index - 1].to)) throw httpError(400, "REQUEST_INVALID");
      paths.add(target.path); totalRanges += ranges.length;
      return { path: target.path, sourceHash: target.sourceHash, ranges };
    });
    if (totalRanges > PROJECT_SEARCH_MAX_MATCHES) throw httpError(400, "REQUEST_INVALID");
    await collaboration.prepareSourceEditRoom(id);
    return projectMutations.runWrite(id, () => {
      const plan = prepareProjectReplacement(config, id, options, replacement, targets);
      if (plan.files.length) collaboration.applySourceEdits(id, plan.files, user.id);
      return { replaced: plan.replaced, files: plan.files.length };
    }, { preflight: () => { requireEditableProject(db, id, user); } });
  });
}
