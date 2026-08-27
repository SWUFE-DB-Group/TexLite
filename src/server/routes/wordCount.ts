import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { maxCollaborativeFileBytes } from "../collaboration.js";
import { compileMainFile } from "../compileArtifacts.js";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { assertNoSourceSymlinks, safeRelativePath, sourceRoot } from "../files.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject } from "../projects.js";
import { TexcountExecutionError, TexcountService, TexcountUnavailableError } from "../texcount.js";

type WordCountMode = "full" | "selection";

interface WordCountRouteContext {
  config: Config;
  db: DatabaseConnection;
  projectMutations: ProjectMutationCoordinator;
  texcount: TexcountService;
}

/** Register host TeXcount-backed full-document and editor-selection counts. */
export function registerWordCountRoutes(app: FastifyInstance, context: WordCountRouteContext): void {
  const { config, db, projectMutations, texcount } = context;

  app.post("/api/projects/:id/word-count", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = (request.body ?? {}) as {
      mode?: unknown;
      mainFile?: unknown;
      path?: unknown;
      source?: unknown;
    };
    const mode = body.mode;
    if (mode !== "full" && mode !== "selection") return apiError(reply, 400, "WORD_COUNT_SOURCE_INVALID");

    try {
      if (mode === "selection") {
        return await countSelection(config, id, body, texcount);
      }
      return await countDocument(config, db, projectMutations, texcount, id, user, body.mainFile);
    } catch (error) {
      if (error instanceof TexcountUnavailableError) return apiError(reply, 503, "WORD_COUNT_UNAVAILABLE");
      if (error instanceof TexcountExecutionError) return apiError(reply, 422, "WORD_COUNT_FAILED");
      throw error;
    }
  });
}

async function countSelection(
  config: Config,
  projectId: string,
  body: { path?: unknown; source?: unknown },
  texcount: TexcountService
) {
  if (typeof body.path !== "string" || typeof body.source !== "string") {
    throw httpError(400, "WORD_COUNT_SOURCE_INVALID");
  }
  let filePath: string;
  try { filePath = safeRelativePath(body.path); }
  catch { throw httpError(400, "WORD_COUNT_SOURCE_INVALID"); }
  // TeXcount's stdin parser is intended for TeX-like source. Keep BibTeX and
  // binary resources out of this endpoint while allowing .sty/.cls snippets.
  if (!/\.(?:tex|sty|cls)$/i.test(filePath) || !body.source.trim()) {
    throw httpError(400, "WORD_COUNT_SOURCE_INVALID");
  }
  if (Buffer.byteLength(body.source, "utf8") > maxCollaborativeFileBytes(config)) {
    throw httpError(413, "WORD_COUNT_SOURCE_TOO_LARGE");
  }
  const counts = await texcount.countSource(sourceRoot(config, projectId), body.source);
  return { mode: "selection" as const, path: filePath, ...counts };
}

async function countDocument(
  config: Config,
  db: DatabaseConnection,
  projectMutations: ProjectMutationCoordinator,
  texcount: TexcountService,
  projectId: string,
  user: UserRow,
  requestedMainFile: unknown
) {
  const initialProject = accessibleProject(db, projectId, user);
  if (!initialProject) throw httpError(404, "PROJECT_NOT_FOUND");
  const mainFile = compileMainFile(config, projectId, initialProject.main_file, requestedMainFile);
  if (!mainFile) throw httpError(400, "MAIN_DOCUMENT_INVALID");
  return await projectMutations.runConsistentRead(projectId, async () => {
    // TeXcount follows \input/\include paths. Reject links before handing it
    // the source root so a checked-out link cannot expose files outside it.
    assertNoSourceSymlinks(config, projectId);
    const counts = await texcount.countFile(sourceRoot(config, projectId), mainFile);
    return { mode: "full" as const, path: mainFile, ...counts };
  }, {
    preflight: () => {
      const current = accessibleProject(db, projectId, user);
      if (!current) throw httpError(404, "PROJECT_NOT_FOUND");
      const selected = compileMainFile(config, projectId, current.main_file, requestedMainFile);
      if (!selected || selected !== mainFile) throw httpError(400, "MAIN_DOCUMENT_INVALID");
    }
  });
}
