import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import type { ProjectGitService } from "../git.js";
import type { HistoryReason } from "../history.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject } from "../projects.js";
import {
  projectTextSnapshot,
  reanchorProjectSnapshot,
  requireActiveUser,
  touchProject
} from "./projectShared.js";

interface ProjectGitRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  projectGit: ProjectGitService;
  recordHistory: (projectId: string, userId: string | null, reason: HistoryReason, paths?: readonly string[]) => unknown;
}

/** Register owner-only local Git and GitHub backup routes. */
export function registerProjectGitRoutes(app: FastifyInstance, context: ProjectGitRouteContext): void {
  const { config, db, collaboration, projectMutations, projectGit, recordHistory } = context;

  const requireGitOwner = (projectId: string, user: UserRow) => {
    requireActiveUser(db, user);
    const project = accessibleProject(db, projectId, user);
    if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
    if (project.owner_id !== user.id) throw httpError(403, "PROJECT_OWNER_ONLY");
    return project;
  };

  app.get("/api/projects/:id/git", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runConsistentRead(id, async () => {
      return { status: await projectGit.status(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.put("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { token?: unknown };
    if (typeof body.token !== "string") return apiError(reply, 400, "GIT_TOKEN_INVALID");
    const token = body.token;
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.configureToken(requireGitOwner(id, user), token) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.delete("/api/projects/:id/git/token", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.removeToken(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/repository", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; private?: unknown };
    if (typeof body.name !== "string") return apiError(reply, 400, "GIT_REPOSITORY_NAME_INVALID");
    const repositoryName = body.name.trim();
    return await projectMutations.runSerialized(id, async () => {
      return { status: await projectGit.createGitHubRepository(requireGitOwner(id, user), repositoryName, body.private !== false) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/commit", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    const body = request.body as { message?: unknown };
    return await projectMutations.runExclusive(id, "Git commit", async () => {
      const project = requireGitOwner(id, user);
      const commit = await projectGit.commit(project, user, typeof body.message === "string" ? body.message : "");
      return reply.code(201).send({ commit, status: await projectGit.status(project) });
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/push", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    if (collaboration.isMaintaining(id)) return apiError(reply, 409, "PROJECT_BUSY");
    return await projectMutations.runSerialized(id, async () => {
      const project = requireGitOwner(id, user);
      return { status: await projectGit.push(project) };
    }, { flush: false, preflight: () => { requireGitOwner(id, user); } });
  });

  app.get("/api/projects/:id/git/history", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    return await projectMutations.runConsistentRead(id, async () => {
      return { commits: await projectGit.history(requireGitOwner(id, user)) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.get("/api/projects/:id/git/diff", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const { revision } = request.query as { revision?: string };
    return await projectMutations.runConsistentRead(id, async () => {
      const project = requireGitOwner(id, user);
      return projectGit.diff(project, revision);
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/checkout", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    requireGitOwner(id, user);
    const body = request.body as { revision?: unknown; force?: unknown };
    if (body.revision !== null && typeof body.revision !== "string") return apiError(reply, 400, "GIT_REVISION_INVALID");
    const revisionInput = body.revision === null ? null : body.revision as string;
    return await projectMutations.runExclusive(id, "Git checkout", async () => {
      const currentProject = requireGitOwner(id, user);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      const revision = await projectGit.checkout(currentProject, revisionInput, body.force === true);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "git");
      return { revision, status: await projectGit.status(currentProject) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });

  app.post("/api/projects/:id/git/discard", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    requireGitOwner(id, user);
    return await projectMutations.runExclusive(id, "Git restore", async () => {
      const currentProject = requireGitOwner(id, user);
      recordHistory(id, user.id, "checkpoint");
      const before = projectTextSnapshot(config, id);
      await projectGit.discardChanges(currentProject);
      reanchorProjectSnapshot(db, id, before, projectTextSnapshot(config, id));
      touchProject(db, id, user.id);
      recordHistory(id, user.id, "git");
      return { status: await projectGit.status(currentProject) };
    }, { preflight: () => { requireGitOwner(id, user); } });
  });
}
