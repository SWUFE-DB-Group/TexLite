import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { maxCollaborativeFileBytes, type CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection, ProjectRow } from "../db.js";
import {
  createProjectFiles,
  duplicateProjectFiles,
  outputRoot,
  removeProjectDirectory,
  resolveSourcePath,
  safeRelativePath,
  sourceRoot
} from "../files.js";
import type { HistoryReason } from "../history.js";
import { apiError, contentDisposition, httpError } from "../http.js";
import { isMainDocumentCandidate } from "../latexRoot.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import { accessibleProject, canEdit } from "../projects.js";
import { writeProjectArchive } from "../archive.js";
import { extractProjectZip, ZipValidationError } from "../zip.js";
import { HarperUnavailableError, type HarperService } from "../harper.js";
import {
  commentsSummaryForProject,
  commentsSummaryForProjects,
  dictionaryWord,
  escapeLikePattern,
  now,
  ProjectTag,
  projectJson,
  requireProjectOwnerPermission,
  tagColors,
  tagsForProject,
  tagsForProjects,
  text
} from "./projectShared.js";

interface ProjectCatalogRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  harper: HarperService;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

/** Register project catalog, metadata, archive, dictionary, tag, export, and deletion routes. */
export function registerProjectCatalogRoutes(app: FastifyInstance, context: ProjectCatalogRouteContext): void {
  const { config, db, collaboration, projectMutations, latexCompletions, projectOutlines, harper, recordHistory } = context;

  app.get("/api/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const tags = db.prepare("SELECT id, name, color FROM user_tags WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(user.id);
    return { tags };
  });

  /**
   * Return the current user's tag catalog together with usage counts.  This is
   * intentionally separate from /api/tags: the lightweight catalog is loaded
   * with every project-list refresh, while counts are only needed by the tag
   * management dialog.
   */
  app.get("/api/tags/management", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const rows = db.prepare(`SELECT tag.id, tag.name, tag.color, COUNT(link.project_id) AS project_count
      FROM user_tags tag
      LEFT JOIN user_project_tag_links link ON link.tag_id = tag.id
      WHERE tag.user_id = ?
      GROUP BY tag.id
      ORDER BY tag.name COLLATE NOCASE`).all(user.id) as Array<ProjectTag & { project_count: number }>;
    return {
      tags: rows.map(({ id, name, color, project_count }) => ({
        id,
        name,
        color,
        projectCount: Number(project_count) || 0
      }))
    };
  });

  app.post("/api/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown };
    const name = text(body.name, 32);
    const color = tagColors.includes(body.color as typeof tagColors[number])
      ? body.color as typeof tagColors[number] : "gray";
    const tag: ProjectTag = { id: randomUUID(), name, color };
    const createdAt = now();
    if (db.prepare("SELECT 1 FROM user_tags WHERE user_id = ? AND name = ?").get(user.id, tag.name)) {
      return apiError(reply, 409, "TAG_NAME_EXISTS");
    }
    db.prepare("INSERT INTO user_tags (id, name, color, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tag.id, tag.name, tag.color, user.id, createdAt, createdAt);
    return reply.code(201).send({ tag });
  });

  app.patch("/api/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown };
    const name = text(body.name, 32);
    const color = tagColors.includes(body.color as typeof tagColors[number])
      ? body.color as typeof tagColors[number] : "gray";
    const existing = db.prepare("SELECT id FROM user_tags WHERE id = ? AND user_id = ?").get(tagId, user.id);
    if (!existing) return apiError(reply, 404, "TAG_NOT_FOUND");
    if (db.prepare("SELECT 1 FROM user_tags WHERE user_id = ? AND name = ? AND id <> ?").get(user.id, name, tagId)) {
      return apiError(reply, 409, "TAG_NAME_EXISTS");
    }
    db.prepare("UPDATE user_tags SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(name, color, now(), tagId, user.id);
    return { tag: { id: tagId, name, color } satisfies ProjectTag };
  });

  app.delete("/api/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const tag = db.prepare(`SELECT tag.id, COUNT(link.project_id) AS project_count
      FROM user_tags tag
      LEFT JOIN user_project_tag_links link ON link.tag_id = tag.id
      WHERE tag.id = ? AND tag.user_id = ?
      GROUP BY tag.id`).get(tagId, user.id) as { id: string; project_count: number } | undefined;
    if (!tag) return apiError(reply, 404, "TAG_NOT_FOUND");
    // Foreign-key cascading removes only this user's project/tag links. The
    // projects and their source files are deliberately left untouched.
    db.prepare("DELETE FROM user_tags WHERE id = ? AND user_id = ?").run(tag.id, user.id);
    return { deletedId: tag.id, projectCount: Number(tag.project_count) || 0 };
  });

  app.get("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { archived?: string; page?: string; pageSize?: string; search?: string; tag?: string; sort?: string };
    const archivedOnly = query.archived === "1" || query.archived === "true";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const requestedPageSize = Number.parseInt(query.pageSize ?? "20", 10);
    const pageSize = Math.min(100, Math.max(1, Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 20));
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    const sortColumn = query.sort === "created" ? "p.created_at" : "p.updated_at";
    const archiveCondition = archivedOnly
      ? "EXISTS (SELECT 1 FROM user_project_archives archive WHERE archive.project_id = p.id AND archive.user_id = :userId)"
      : "NOT EXISTS (SELECT 1 FROM user_project_archives archive WHERE archive.project_id = p.id AND archive.user_id = :userId)";
    const from = `FROM projects p JOIN users owner ON owner.id = p.owner_id
      LEFT JOIN users modifier ON modifier.id = p.last_modified_by
      LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = :userId`;
    const conditions = [
      "(p.owner_id = :userId OR pm.user_id = :userId)",
      archiveCondition
    ];
    const params: Record<string, string | number> = { userId: user.id };
    if (search) {
      conditions.push("(p.name LIKE :search ESCAPE '\\' OR owner.username LIKE :search ESCAPE '\\' OR owner.display_name LIKE :search ESCAPE '\\')");
      params.search = `%${escapeLikePattern(search)}%`;
    }
    if (tagId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM user_project_tag_links tag_link
        JOIN user_tags tag ON tag.id = tag_link.tag_id
        WHERE tag_link.project_id = p.id AND tag.user_id = :userId AND tag.id = :tagId
      )`);
      params.tagId = tagId;
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const countRow = db.prepare(`SELECT COUNT(DISTINCT p.id) AS total ${from} ${where}`).get(params) as { total: number };
    const total = Number(countRow.total);
    const totalPages = Math.ceil(total / pageSize);
    const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const rowsParams = { ...params, limit: pageSize, offset: (currentPage - 1) * pageSize };
    const select = `SELECT DISTINCT p.*,
      CASE WHEN p.owner_id = :userId THEN 'owner' ELSE pm.permission END AS permission,
      owner.username AS owner_username, owner.display_name AS owner_display_name,
      modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name`;
    const rows = db.prepare(`${select} ${from} ${where}
      ORDER BY ${sortColumn} DESC, p.name COLLATE NOCASE ASC
      LIMIT :limit OFFSET :offset`).all(rowsParams);
    const projects = rows as unknown as Array<ProjectRow & { permission: string }>;
    const projectIds = projects.map((project) => project.id);
    const projectTags = tagsForProjects(db, projectIds, user.id);
    const commentsSummaries = commentsSummaryForProjects(db, projectIds);
    return {
      projects: projects.map((project) => projectJson(
        { ...project, archived: archivedOnly },
        projectTags.get(project.id) ?? [],
        commentsSummaries.get(project.id)
      )),
      pagination: { page: currentPage, pageSize, total, totalPages }
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    const body = request.body as Record<string, unknown>;
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(body?.name, 120),
      main_file: "main.tex", latexmkrc: null, engine: config.defaultEngine, created_at: now(), updated_at: now()
    };
    createProjectFiles(config, project.id);
    try {
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.latexmkrc, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      throw error;
    }
    recordHistory(project.id, user.id, "initial");
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/import", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    const part = await request.file();
    if (!part || !part.filename.toLowerCase().endsWith(".zip")) {
      return apiError(reply, 400, "ZIP_ONLY");
    }
    const query = request.query as { name?: string };
    const fallbackName = path.basename(part.filename, path.extname(part.filename));
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(query.name || fallbackName, 120),
      main_file: "", latexmkrc: null, engine: config.defaultEngine, created_at: now(), updated_at: now()
    };
    fs.mkdirSync(sourceRoot(config, project.id), { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputRoot(config, project.id), { recursive: true, mode: 0o700 });
    try {
      const extracted = await extractProjectZip(await part.toBuffer(), sourceRoot(config, project.id), config.maxUploadBytes);
      project.main_file = extracted.mainFile;
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      if (error instanceof ZipValidationError) return apiError(reply, 400, error.code, error.details);
      return apiError(reply, 400, "ZIP_INVALID");
    }
    recordHistory(project.id, user.id, "initial");
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.post("/api/projects/:id/duplicate", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (user.role !== "admin" && !user.can_create_projects) {
      return apiError(reply, 403, "PROJECT_CREATE_FORBIDDEN");
    }
    const { id } = request.params as { id: string };
    const source = accessibleProject(db, id, user);
    if (!source) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { name?: unknown } | undefined;
    const requestedName = typeof body?.name === "string" && body.name.trim() ? body.name : `${source.name.slice(0, 115)} (1)`;
    const project: ProjectRow = {
      id: randomUUID(), owner_id: user.id, last_modified_by: user.id, name: text(requestedName, 120),
      main_file: source.main_file, latexmkrc: source.latexmkrc, engine: source.engine, created_at: now(), updated_at: now()
    };
    try {
      // Duplicate the source tree only after flushing the live Yjs room and
      // while a short source barrier prevents autosave from changing files
      // between directory entries. The copy is asynchronous, so a large
      // project does not block the Node.js event loop for its entire duration.
      await projectMutations.runConsistentRead(source.id, () => duplicateProjectFiles(config, source.id, project.id), {
        preflight: () => {
          if (!accessibleProject(db, source.id, user)) {
            throw httpError(404, "PROJECT_NOT_FOUND");
          }
        }
      });
      db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(project.id, project.owner_id, project.last_modified_by, project.name, project.main_file, project.latexmkrc, project.engine, project.created_at, project.updated_at);
    } catch (error) {
      removeProjectDirectory(config, project.id);
      throw error;
    }
    recordHistory(project.id, user.id, "initial");
    return reply.code(201).send({ project: projectJson({
      ...project, permission: "owner", owner_username: user.username, owner_display_name: user.display_name,
      last_modified_username: user.username, last_modified_display_name: user.display_name
    }) });
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    return {
      project: projectJson(
        project,
        tagsForProject(db, id, user.id),
        commentsSummaryForProject(db, id)
      )
    };
  });

  app.put("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    db.prepare(`INSERT OR IGNORE INTO user_project_archives (user_id, project_id, archived_at) VALUES (?, ?, ?)`)
      .run(user.id, id, now());
    return { ok: true, archived: true };
  });

  app.delete("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    db.prepare("DELETE FROM user_project_archives WHERE user_id = ? AND project_id = ?").run(user.id, id);
    return { ok: true, archived: false };
  });

  app.get("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const rows = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return { words: rows.map((row) => row.word) };
  });

  app.post("/api/projects/:id/spellcheck", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (!accessibleProject(db, id, user)) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { path?: unknown; source?: unknown } | undefined;
    if (typeof body?.source !== "string" || typeof body.path !== "string") return apiError(reply, 400, "SPELLCHECK_SOURCE_INVALID");
    if (Buffer.byteLength(body.source, "utf8") > maxCollaborativeFileBytes(config)) {
      return apiError(reply, 413, "SPELLCHECK_SOURCE_TOO_LARGE");
    }
    try {
      return { lints: await harper.lint(body.source, body.path) };
    } catch (error) {
      // A missing optional command is an expected fallback condition. Keep it
      // out of normal logs while preserving diagnostics for an actual failure.
      if (error instanceof HarperUnavailableError) request.log.debug({ projectId: id }, "Host Harper CLI unavailable; using browser fallback");
      else request.log.error({ err: error, projectId: id }, "Harper writing check failed");
      return apiError(reply, 503, "HARPER_UNAVAILABLE");
    }
  });

  app.post("/api/projects/:id/dictionary", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN");
    const body = request.body as { word?: unknown } | undefined;
    const word = dictionaryWord(body?.word);
    db.prepare(`INSERT OR IGNORE INTO project_dictionary_words (project_id, word, created_by, created_at)
      VALUES (?, ?, ?, ?)`).run(id, word, user.id, now());
    collaboration.signalDictionary(id);
    const words = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return reply.code(201).send({ word, words: words.map((row) => row.word) });
  });

  app.delete("/api/projects/:id/dictionary/:word", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, word: rawWord } = request.params as { id: string; word: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (!canEdit(project)) return apiError(reply, 403, "DICTIONARY_EDIT_FORBIDDEN");
    const word = dictionaryWord(rawWord);
    db.prepare("DELETE FROM project_dictionary_words WHERE project_id = ? AND word = ?").run(id, word);
    collaboration.signalDictionary(id);
    const words = db.prepare(`SELECT word FROM project_dictionary_words
      WHERE project_id = ? ORDER BY word COLLATE NOCASE`).all(id) as Array<{ word: string }>;
    return { words: words.map((row) => row.word) };
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "PROJECT_OWNER_ONLY");
    const body = request.body as Record<string, unknown>;
    return await projectMutations.runWrite(id, async () => {
      const currentProject = accessibleProject(db, id, user);
      if (!currentProject || currentProject.permission !== "owner") {
        return apiError(reply, 403, "PROJECT_OWNER_ONLY");
      }
      const name = typeof body.name === "string" ? text(body.name, 120) : currentProject.name;
      let mainFile = currentProject.main_file;
      if (body.mainFile !== undefined) {
        if (typeof body.mainFile !== "string" || !body.mainFile.trim()) {
          return apiError(reply, 400, "MAIN_FILE_INVALID");
        }
        mainFile = safeRelativePath(body.mainFile);
      }
      const engine = typeof body.engine === "string" && config.allowedEngines.includes(body.engine as typeof currentProject.engine)
        ? body.engine as typeof currentProject.engine : currentProject.engine;
      const latexmkrc = body.latexmkrc === null || body.latexmkrc === ""
        ? null
        : typeof body.latexmkrc === "string" ? safeRelativePath(body.latexmkrc) : currentProject.latexmkrc;
      if (!mainFile.toLocaleLowerCase().endsWith(".tex")) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", { path: mainFile });
      }
      const mainFileAbsolute = resolveSourcePath(config, id, mainFile);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(mainFileAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return apiError(reply, 400, "MAIN_FILE_NOT_FOUND", { path: mainFile });
        }
        throw error;
      }
      if (!stat.isFile()) {
        return apiError(reply, 400, "MAIN_FILE_INVALID", { path: mainFile });
      }
      if (body.mainFile !== undefined && !await isMainDocumentCandidate(config, id, mainFile)) {
        return apiError(reply, 400, "MAIN_DOCUMENT_INVALID", { path: mainFile });
      }
      if (latexmkrc && !config.allowProjectLatexmkrc) return apiError(reply, 400, "LATEXMKRC_DISABLED");
      if (latexmkrc) {
        const rcAbsolute = resolveSourcePath(config, id, latexmkrc);
        let rcStat: fs.Stats | null = null;
        try {
          rcStat = fs.statSync(rcAbsolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return apiError(reply, 400, "LATEXMKRC_NOT_FOUND", { path: latexmkrc });
          }
          throw error;
        }
        if (!rcStat.isFile()) {
          return apiError(reply, 400, "LATEXMKRC_INVALID", { path: latexmkrc });
        }
      }
      db.prepare("UPDATE projects SET name = ?, main_file = ?, latexmkrc = ?, engine = ?, updated_at = ?, last_modified_by = ? WHERE id = ?")
        .run(name, mainFile, latexmkrc, engine, now(), user.id, id);
      recordHistory(id, user.id, "settings", []);
      return {
        project: projectJson(
          accessibleProject(db, id, user)!,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });

  app.post("/api/projects/:id/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const body = request.body as { tagId?: unknown };
    if (typeof body.tagId !== "string" || !db.prepare("SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?").get(body.tagId, user.id)) {
      return apiError(reply, 404, "TAG_NOT_FOUND");
    }
    db.prepare("INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)")
      .run(id, body.tagId, now());
    const tags = tagsForProject(db, id, user.id);
    return reply.code(201).send({
      tags,
      project: projectJson(
        accessibleProject(db, id, user)!,
        tags,
        commentsSummaryForProject(db, id)
      )
    });
  });

  app.delete("/api/projects/:id/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, tagId } = request.params as { id: string; tagId: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    db.prepare(`DELETE FROM user_project_tag_links WHERE tag_id = ? AND project_id = ?
      AND EXISTS (SELECT 1 FROM user_tags WHERE id = ? AND user_id = ?)`)
      .run(tagId, id, tagId, user.id);
    const tags = tagsForProject(db, id, user.id);
    return {
      tags,
      project: projectJson(
        accessibleProject(db, id, user)!,
        tags,
        commentsSummaryForProject(db, id)
      )
    };
  });

  app.get("/api/projects/:id/download", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    const temporaryDirectory = path.join(config.dataDir, "tmp");
    const temporaryArchive = path.join(temporaryDirectory, `project-${id}-${randomUUID()}.zip`);
    try {
      await fs.promises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await projectMutations.runConsistentRead(id, () => writeProjectArchive(config, id, temporaryArchive), {
        preflight: () => {
          const current = accessibleProject(db, id, user);
          if (!current) throw httpError(404, "PROJECT_NOT_FOUND");
        }
      });
    } catch (error) {
      await fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined);
      throw error;
    }
    const filename = `${project.name}.zip`;
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition(filename, "attachment"));
    const stream = fs.createReadStream(temporaryArchive);
    const cleanup = () => { void fs.promises.rm(temporaryArchive, { force: true }).catch(() => undefined); };
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return reply.send(stream);
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    if (project.permission !== "owner") return apiError(reply, 403, "PROJECT_DELETE_FORBIDDEN");
    return await projectMutations.runExclusive(id, "project deletion", () => {
      collaboration.resetProject(id);
      removeProjectDirectory(config, id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      latexCompletions.invalidate(id);
      projectOutlines.invalidate(id);
      return { ok: true };
    }, { preflight: () => { requireProjectOwnerPermission(db, id, user); } });
  });
}
