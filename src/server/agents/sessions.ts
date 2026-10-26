import fs from "node:fs";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { AgentAccess, AgentCatalog, AgentId, AgentPolicy, AgentTask, AgentTaskPage, AgentServerMessage } from "../../shared/agentProtocol.js";
import { parseAgentClientMessage } from "../../shared/agentProtocol.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { httpError } from "../http.js";
import { accessibleProject, canEdit } from "../projects.js";
import { requireEditableProject } from "../routes/projectShared.js";
import { AgentRegistry } from "./registry.js";
import { agentTaskRoot, AgentSourceSync, ensureAgentInstructions, writeAgentProjectContext, type AgentWorkspaceContext } from "./workspaces.js";
import { sourceRoot } from "../files.js";
import { loadAgentPty, stopAgentPty, type AgentPty, type AgentPtyFactory } from "./terminal.js";
import type { NativeSessionInspection } from "./adapters/types.js";
import { clearAgentExecution, recoverAgentExecution } from "./execution.js";

interface TaskRow {
  id: string; project_id: string; user_id: string; project_name: string; user_name: string;
  agent_id: AgentId; title: string; state: AgentTask["state"];
  cleanup_state: AgentTask["cleanupState"]; error_code: string | null; native_session_id: string | null;
  ever_started: number; created_at: string; updated_at: string; started_at: string | null; ended_at: string | null; exit_code: number | null;
}
interface Attachment { socket: WebSocket; authorized: () => boolean }
type TaskActor = Pick<UserRow, "id" | "role">;
interface Execution {
  pty: AgentPty; attachments: Set<Attachment>; controller: Attachment | null;
  output: string; stopping: boolean; finished: Promise<void>; finish: () => void;
  subscriptions: Array<{ dispose(): void }>;
  termination: Promise<void> | null;
  exitCode: number | null;
  source: AgentSourceSync;
  releaseProject: () => void;
}
export interface AgentServiceOptions {
  registry?: AgentRegistry;
  loadPty?: () => Promise<AgentPtyFactory | null>;
  stopPty?: (pty: AgentPty) => Promise<void>;
  onError?: (error: unknown) => void;
}
const now = () => new Date().toISOString();
const taskNameCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-";
function randomTaskName(): string {
  return Array.from({ length: 6 }, () => taskNameCharacters[randomInt(taskNameCharacters.length)]).join("");
}

/** Owns tasks and executions, not provider quotas or per-user runtime limits. */
export class AgentService {
  readonly registry: AgentRegistry;
  private readonly db: DatabaseConnection;
  private readonly executions = new Map<string, Execution>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly activeProjects = new Map<string, string>();
  private readonly recoveries = new Map<string, () => void>();
  private readonly recovery: Promise<void>;
  private closing = false;

  constructor(private readonly context: AgentWorkspaceContext, private readonly options: AgentServiceOptions = {}) {
    this.db = context.db;
    this.registry = options.registry ?? new AgentRegistry();
    this.db.prepare("UPDATE agent_tasks SET state = 'interrupted', ended_at = ?, updated_at = ? WHERE state IN ('starting', 'running', 'stopping')").run(now(), now());
    this.db.prepare("UPDATE agent_tasks SET cleanup_state = 'failed', error_code = 'AGENT_CLEANUP_FAILED' WHERE cleanup_state = 'deleting'").run();
    for (const row of this.db.prepare("SELECT * FROM agent_tasks").all() as TaskRow[]) {
      if (!fs.existsSync(this.executionFile(row.id))) continue;
      this.db.prepare("UPDATE agent_tasks SET state = 'stopping', error_code = 'AGENT_RECOVERY_FAILED' WHERE id = ?").run(row.id);
      this.activeProjects.set(row.project_id, row.id);
      const releaseWriter = this.context.projectMutations.registerExternalWriter(row.project_id, async () => { await this.stop(row.id); });
      this.recoveries.set(row.id, () => {
        if (this.activeProjects.get(row.project_id) === row.id) this.activeProjects.delete(row.project_id);
        releaseWriter?.();
      });
    }
    this.recovery = this.recoverOnStartup();
  }

  /** Startup recovery completes before new executions or HTTP traffic are admitted. */
  ready(): Promise<void> { return this.recovery; }

  policy(): AgentPolicy {
    const row = this.db.prepare("SELECT allowed FROM agent_policy WHERE id = 1").get() as { allowed: string };
    return { allowed: JSON.parse(row.allowed) as AgentId[] };
  }

  access(userId: string, projectId?: string): AgentAccess {
    const { total, activeCount } = this.db.prepare(`SELECT COUNT(*) AS total,
      COUNT(CASE WHEN state IN ('starting', 'running', 'stopping')
        AND (? IS NULL OR project_id = ?) THEN 1 END) AS activeCount
      FROM agent_tasks WHERE user_id = ?`).get(projectId ?? null, projectId ?? null, userId) as { total: number; activeCount: number };
    return { visible: this.policy().allowed.length > 0 || total > 0, activeCount };
  }

  async catalog(refresh = false): Promise<AgentCatalog> {
    await this.recovery;
    if (refresh) this.registry.refresh();
    const policy = this.policy();
    const [agents, factory] = await Promise.all([this.registry.catalog(policy), (this.options.loadPty ?? loadAgentPty)()]);
    return { policy, agents, ptyAvailable: factory !== null };
  }

  async setPolicy(policy: AgentPolicy): Promise<void> {
    await this.recovery;
    this.db.prepare("UPDATE agent_policy SET allowed = ? WHERE id = 1").run(JSON.stringify([...new Set(policy.allowed)]));
    await this.reconcilePermissions();
  }

  list(user: UserRow, admin: boolean, query: { project?: string; user?: string; agent?: string; state?: string; page?: string }): AgentTaskPage {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (!admin) { conditions.push("user_id = ?"); values.push(user.id); }
    if (query.project) { conditions.push("(project_id = ? OR COALESCE(p.name, t.project_name) LIKE ?)"); values.push(query.project, `%${query.project}%`); }
    if (admin && query.user) { conditions.push("(user_id = ? OR COALESCE(u.display_name, t.user_name) LIKE ?)"); values.push(query.user, `%${query.user}%`); }
    if (query.agent) { conditions.push("agent_id = ?"); values.push(query.agent); }
    if (query.state === "running") conditions.push("state IN ('starting', 'running', 'stopping')");
    else if (query.state === "cleanup") conditions.push("cleanup_state = 'failed'");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const from = "FROM agent_tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.user_id";
    const { total } = this.db.prepare(`SELECT count(*) AS total ${from} ${where}`).get(...values) as { total: number };
    const requested = Number(query.page ?? 1);
    const page = Math.min(Math.max(1, Number.isSafeInteger(requested) ? requested : 1), Math.max(1, Math.ceil(total / 20)));
    const rows = this.db.prepare(`SELECT t.*, COALESCE(p.name, t.project_name) AS project_name, COALESCE(u.display_name, t.user_name) AS user_name
      ${from} ${where} ORDER BY t.updated_at DESC, t.id LIMIT 20 OFFSET ?`).all(...values, (page - 1) * 20) as TaskRow[];
    const project = query.project ? accessibleProject(this.db, query.project, user) : null;
    return { tasks: rows.map((row) => this.json(row)), total, page, pageSize: 20,
      activeTaskId: project && canEdit(project) ? this.activeProjects.get(project.id) ?? null : null };
  }

  task(id: string, user: UserRow, administration = false): AgentTask {
    return this.json(this.owned(id, user, administration));
  }

  async refreshProjectContext(projectId: string): Promise<void> {
    const id = this.activeProjects.get(projectId);
    if (id) await this.withTask(id, async () => {
      if (this.activeProjects.get(projectId) === id) await writeAgentProjectContext(this.context, id, projectId);
    });
  }

  async create(projectId: string, user: UserRow, agentId: AgentId, title?: string): Promise<AgentTask> {
    await this.recovery;
    this.requireEnabled(agentId);
    const project = requireEditableProject(this.db, projectId, user);
    if (!(await this.registry.detect(agentId)).executable) throw httpError(409, "AGENT_UNAVAILABLE");
    if (this.closing) throw httpError(409, "AGENT_UNAVAILABLE");
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO agent_tasks
      (id, project_id, user_id, project_name, user_name, agent_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, user.id, project.name, user.display_name, agentId, title?.trim() || randomTaskName(), timestamp, timestamp);
    try {
      await fs.promises.mkdir(path.join(agentTaskRoot(this.context.config, id), "state"), { recursive: true, mode: 0o700 });
      requireEditableProject(this.db, projectId, user);
      this.requireEnabled(agentId);
      return this.task(id, user);
    } catch (error) {
      await fs.promises.rm(agentTaskRoot(this.context.config, id), { recursive: true, force: true });
      this.db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(id);
      throw error;
    }
  }

  update(id: string, user: UserRow, changes: { title: string }): AgentTask {
    const row = this.owned(id, user);
    if (row.cleanup_state === "deleting") throw httpError(409, "AGENT_SESSION_BUSY");
    this.db.prepare("UPDATE agent_tasks SET title = ?, updated_at = ? WHERE id = ?")
      .run(changes.title, now(), id);
    return this.task(id, user);
  }

  async start(id: string, user: UserRow): Promise<AgentTask> {
    return this.withTask(id, async () => {
      let row = this.owned(id, user);
      this.requireEditable(row);
      if (this.recoveries.has(id)) throw httpError(409, "AGENT_RECOVERY_FAILED");
      if (this.executions.has(id)) return this.json(row);
      if (row.cleanup_state !== "none") throw httpError(409, "AGENT_SESSION_BUSY");
      // Claim synchronously before discovery/credential preparation can yield.
      // This applies to all users, agents and tasks in this project.
      if (this.activeProjects.has(row.project_id)) throw httpError(409, "AGENT_PROJECT_BUSY");
      const releaseWriter = this.context.projectMutations.registerExternalWriter(row.project_id, async () => { await this.stop(id); });
      if (!releaseWriter) throw httpError(409, "AGENT_PROJECT_BUSY");
      this.activeProjects.set(row.project_id, id);
      const releaseProject = () => {
        if (this.activeProjects.get(row.project_id) === id) this.activeProjects.delete(row.project_id);
        releaseWriter();
      };
      let source: AgentSourceSync | undefined;
      try {
        // Starting a CLI is not the same as creating its first conversation.
        // A verified empty native store may be launched again in the same task;
        // a known conversation is always resumed, never silently replaced.
        let native: NativeSessionInspection | undefined;
        if (row.ever_started && !row.native_session_id) { native = await this.captureContext(id); row = this.owned(id, user); }
        const resume = Boolean(row.native_session_id);
        const adapter = this.registry.adapter(row.agent_id);
        const root = agentTaskRoot(this.context.config, id);
        const context = await this.registry.context(row.agent_id, id, root, row.native_session_id, sourceRoot(this.context.config, row.project_id));
        if (!context.executable) throw httpError(409, "AGENT_UNAVAILABLE");
        if (!resume && row.ever_started && native?.status !== "empty") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
        if (resume && !adapter.supportsResume) throw httpError(409, "AGENT_NO_CONTEXT");
        const spawn = await (this.options.loadPty ?? loadAgentPty)();
        if (!spawn) throw httpError(409, "AGENT_PTY_UNAVAILABLE");
        await fs.promises.mkdir(context.stateDirectory, { recursive: true, mode: 0o700 });
        await adapter.prepare(context);
        await ensureAgentInstructions(this.context, row.project_id, user);
        await writeAgentProjectContext(this.context, id, row.project_id);
        source = new AgentSourceSync(this.context, id, row.project_id, row.user_id, (error) => {
          const code = error instanceof Error && "code" in error && error.code === "AGENT_SYNC_CONFLICT" ? "AGENT_SYNC_CONFLICT" : "AGENT_SYNC_FAILED";
          this.db.prepare("UPDATE agent_tasks SET error_code = ? WHERE id = ?").run(code, id);
          this.options.onError?.(error);
          void this.stop(id).catch((failure) => this.options.onError?.(failure));
        });
        await source.start();
        this.requireEditable(row);
        if (this.closing) throw httpError(409, "AGENT_UNAVAILABLE");
        this.db.prepare("UPDATE agent_tasks SET state = 'starting', error_code = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        try {
          const command = resume ? adapter.resume({ ...context, nativeSessionId: row.native_session_id! }) : adapter.start(context);
          const pty = await spawn(command.executable, command.args, { name: "xterm-256color", cwd: context.workingDirectory, env: command.env, cols: 100, rows: 24,
            executionFile: this.executionFile(id),
            beforeStart: () => { this.db.prepare("UPDATE agent_tasks SET ever_started = 1 WHERE id = ?").run(id); } });
          let finish!: () => void;
          const execution: Execution = { pty, attachments: new Set(), controller: null, output: "", stopping: false, termination: null, exitCode: null,
            finished: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish(), subscriptions: [], source, releaseProject };
          this.executions.set(id, execution);
          execution.subscriptions.push(pty.onData((data) => this.output(id, execution, data)));
          execution.subscriptions.push(pty.onExit(({ exitCode }) => {
            if (this.executions.get(id) !== execution || execution.exitCode !== null) return;
            execution.exitCode = exitCode;
            execution.finish();
            // A CLI may leave workers alive after its parent exits. Reap the
            // remaining owned process group before releasing this execution.
            if (!execution.termination) void this.terminate(id, execution, "exited").catch((error) => this.options.onError?.(error));
          }));
          this.db.prepare("UPDATE agent_tasks SET state = 'running', ever_started = 1, started_at = ?, ended_at = NULL, exit_code = NULL, updated_at = ? WHERE id = ?")
            .run(now(), now(), id);
          return this.task(id, user);
        } catch (error) {
          this.options.onError?.(error);
          this.db.prepare("UPDATE agent_tasks SET state = 'failed', error_code = 'AGENT_START_FAILED', updated_at = ? WHERE id = ?").run(now(), id);
          throw httpError(409, "AGENT_START_FAILED");
        }
      } catch (error) {
        const execution = this.executions.get(id);
        if (execution) await this.terminate(id, execution, "stopped");
        else { try { await source?.close(); } finally { releaseProject(); } }
        throw error;
      }
    });
  }

  async stop(id: string, user?: TaskActor, administration = false): Promise<AgentTask | null> {
    return this.withTask(id, async () => {
      if (user) this.owned(id, user, administration);
      await this.stopExecution(id);
      await this.captureContext(id);
      const row = this.row(id);
      if (user && row) this.audit(id, user.id, "stop", "ok");
      return row ? this.json(row) : null;
    });
  }

  async remove(id: string, user: TaskActor, administration = false): Promise<void> {
    await this.withTask(id, async () => {
      const row = this.owned(id, user, administration);
      this.db.prepare("UPDATE agent_tasks SET cleanup_state = 'deleting', error_code = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      try {
        await this.stopExecution(id);
        await this.captureContext(id);
        const current = this.row(id)!;
        const root = agentTaskRoot(this.context.config, id);
        const context = await this.registry.context(row.agent_id, id, root, current.native_session_id, sourceRoot(this.context.config, row.project_id));
        if (row.ever_started) await this.registry.adapter(row.agent_id).cleanup(context);
        // Only the task's generated UUID directory is ever removed.
        await fs.promises.rm(root, { recursive: true, force: true });
        this.audit(id, user.id, "delete", "ok");
        this.db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(id);
      } catch (error) {
        this.db.prepare("UPDATE agent_tasks SET cleanup_state = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
          .run("AGENT_CLEANUP_FAILED", now(), id);
        this.audit(id, user.id, "delete", "failed");
        if (error instanceof Error && "statusCode" in error) throw error;
        this.options.onError?.(error);
        throw httpError(409, "AGENT_CLEANUP_FAILED");
      }
    });
  }

  attach(id: string, user: UserRow, socket: WebSocket, authorized: () => boolean): void {
    const row = this.owned(id, user);
    this.requireEditable(row);
    const execution = this.executions.get(id);
    if (!execution || execution.stopping) throw httpError(409, "AGENT_SESSION_BUSY");
    const attachment: Attachment = { socket, authorized };
    execution.attachments.add(attachment);
    if (!execution.controller) execution.controller = attachment;
    this.send(socket, { type: "state", task: this.json(row) });
    if (execution.output) this.send(socket, { type: "output", data: execution.output });
    this.controls(execution);
    socket.on("message", (raw) => {
      if (!authorized()) { socket.close(1008, "Authentication expired"); return; }
      if (!this.editable(row)) { socket.close(1008, "Access revoked"); void this.stop(id).catch((error) => this.options.onError?.(error)); return; }
      if (this.executions.get(id) !== execution || execution.stopping) return;
      const message = parseAgentClientMessage(raw.toString());
      if (!message) { socket.close(1008, "Invalid terminal message"); return; }
      if (message.type === "takeControl") { execution.controller = attachment; this.controls(execution); }
      if (execution.controller !== attachment) return;
      if (message.type === "input") execution.pty.write(message.data);
      if (message.type === "resize") {
        execution.pty.resize(message.cols, message.rows);
      }
    });
    socket.on("close", () => {
      execution.attachments.delete(attachment);
      if (execution.controller === attachment) execution.controller = execution.attachments.values().next().value ?? null;
      this.controls(execution);
    });
  }

  /** Called after permission/policy mutations, not by a perpetual polling timer. */
  async reconcilePermissions(cleanOrphans = false): Promise<void> {
    await this.recovery;
    const stops: Promise<unknown>[] = [];
    for (const id of new Set([...this.executions.keys(), ...this.recoveries.keys()])) {
      const row = this.row(id);
      if (!row || !this.editable(row)) stops.push(this.stop(id));
    }
    await Promise.all(stops);
    if (cleanOrphans) {
      const orphaned = this.db.prepare(`SELECT t.id FROM agent_tasks t
        LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.user_id
        WHERE t.cleanup_state = 'none' AND (p.id IS NULL OR u.id IS NULL)`).all() as Array<{ id: string }>;
      await Promise.all(orphaned.map(async ({ id }) => {
        try { await this.remove(id, { id: "system", role: "admin" }, true); }
        catch (error) { this.options.onError?.(error); }
      }));
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.recovery;
    await Promise.allSettled([...this.operations.values()]);
    // A failed stop must not let app.close() close the database while other
    // executions are still flushing their last source/history changes.
    const results = await Promise.allSettled([...new Set([...this.executions.keys(), ...this.recoveries.keys()])].map((id) => this.stop(id)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failed to stop all coding agent tasks");
  }

  private async captureContext(id: string, afterExit = false): Promise<NativeSessionInspection> {
    const row = this.row(id);
    if (row?.native_session_id) return { status: "found", id: row.native_session_id };
    if (!row || !row.ever_started || (!afterExit && this.executions.has(id))) return { status: "unknown" };
    const context = await this.registry.context(row.agent_id, id, agentTaskRoot(this.context.config, id), null, sourceRoot(this.context.config, row.project_id));
    const native = await this.registry.adapter(row.agent_id).findNativeSession(context);
    if (native.status === "found") this.db.prepare("UPDATE agent_tasks SET native_session_id = ? WHERE id = ?").run(native.id, id);
    return native;
  }

  private async stopExecution(id: string): Promise<void> {
    if (this.recoveries.has(id)) { await this.recoverExecution(id, "stopped"); return; }
    const execution = this.executions.get(id);
    if (!execution) return;
    return this.terminate(id, execution, "stopped");
  }

  private terminate(id: string, execution: Execution, finalState: "stopped" | "exited"): Promise<void> {
    if (execution.termination) return execution.termination;
    execution.stopping = true;
    this.db.prepare("UPDATE agent_tasks SET state = 'stopping', updated_at = ? WHERE id = ?").run(now(), id);
    const termination = Promise.resolve().then(async () => {
      await (this.options.stopPty ?? stopAgentPty)(execution.pty);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([execution.finished, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(httpError(409, "AGENT_STOP_FAILED")), 3_000);
        })]);
      } finally { clearTimeout(timer); }
      if (this.executions.get(id) !== execution) return;
      try { await this.captureContext(id, true); }
      catch (error) { this.options.onError?.(error); }
      try { await execution.source.close(); }
      catch (error) {
        this.db.prepare("UPDATE agent_tasks SET error_code = 'AGENT_SYNC_FAILED' WHERE id = ?").run(id);
        this.options.onError?.(error);
      }
      clearAgentExecution(this.executionFile(id));
      this.executions.delete(id);
      execution.releaseProject();
      this.db.prepare("UPDATE agent_tasks SET state = ?, exit_code = ?, ended_at = ?, updated_at = ? WHERE id = ?")
        .run(finalState, execution.exitCode, now(), now(), id);
      const row = this.row(id);
      if (row) for (const attachment of execution.attachments) {
        this.send(attachment.socket, { type: "state", task: this.json(row) });
        attachment.socket.close(1000, "Execution ended");
      }
      for (const subscription of execution.subscriptions) subscription.dispose();
    });
    execution.termination = termination;
    void termination.catch(() => {
      execution.termination = null;
      this.db.prepare("UPDATE agent_tasks SET error_code = 'AGENT_STOP_FAILED' WHERE id = ?").run(id);
    });
    return termination;
  }

  private output(id: string, execution: Execution, data: string): void {
    const row = this.row(id);
    if (!row || !this.editable(row)) { void this.stop(id).catch((error) => this.options.onError?.(error)); return; }
    execution.output = (execution.output + data).slice(-256 * 1024);
    for (const attachment of execution.attachments) {
      if (!attachment.authorized()) { attachment.socket.close(1008, "Authentication expired"); continue; }
      if (attachment.socket.bufferedAmount > 512 * 1024) { attachment.socket.close(1013, "Reconnect to redraw terminal"); continue; }
      this.send(attachment.socket, { type: "output", data });
    }
  }
  private controls(execution: Execution): void {
    for (const attachment of execution.attachments) this.send(attachment.socket, { type: "control", writable: execution.controller === attachment });
  }
  private send(socket: WebSocket, message: AgentServerMessage): void { if (socket.readyState === 1) socket.send(JSON.stringify(message)); }
  private audit(id: string, actorId: string, action: string, result: string): void {
    const row = this.row(id)!;
    this.db.prepare("INSERT INTO agent_cleanup_events (task_id, actor_id, project_id, agent_id, action, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, actorId, row.project_id, row.agent_id, action, result, now());
  }
  private row(id: string): TaskRow | undefined { return this.db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as TaskRow | undefined; }
  private owned(id: string, user: TaskActor, administration = false): TaskRow {
    const row = this.row(id);
    if (!row || (row.user_id !== user.id && !(administration && user.role === "admin"))) throw httpError(404, "AGENT_SESSION_NOT_FOUND");
    return row;
  }
  private editable(row: TaskRow): boolean {
    const user = this.db.prepare("SELECT * FROM users WHERE id = ? AND disabled = 0").get(row.user_id) as UserRow | undefined;
    if (!user || user.must_change_password) return false;
    const project = accessibleProject(this.db, row.project_id, user);
    const policy = this.policy();
    return Boolean(project && canEdit(project) && policy.allowed.includes(row.agent_id));
  }
  private requireEditable(row: TaskRow): void { if (!this.editable(row)) throw httpError(403, "AGENT_DISABLED"); }
  private requireEnabled(id: AgentId): void {
    const policy = this.policy();
    if (!policy.allowed.includes(id)) throw httpError(403, "AGENT_DISABLED");
  }
  private json(row: TaskRow): AgentTask {
    return { id: row.id, projectId: row.project_id, projectName: row.project_name, userId: row.user_id, userName: row.user_name,
      agentId: row.agent_id, title: row.title, state: row.state, cleanupState: row.cleanup_state,
      errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at,
      endedAt: row.ended_at, exitCode: row.exit_code, nativeSessionId: row.native_session_id,
      canResume: Boolean(row.native_session_id && this.registry.adapter(row.agent_id).supportsResume) };
  }
  private executionFile(id: string): string { return path.join(agentTaskRoot(this.context.config, id), "execution.json"); }

  private async recoverOnStartup(): Promise<void> {
    await Promise.all([...this.recoveries.keys()].map(async (id) => {
      try { await this.recoverExecution(id, "interrupted"); }
      catch { /* Failure is logged and its task/claim remains available for retry. */ }
    }));
  }

  private async recoverExecution(id: string, state: "interrupted" | "stopped"): Promise<void> {
    try {
      await recoverAgentExecution(this.executionFile(id));
      const row = this.row(id);
      // Source files left by an interrupted CLI are authoritative at startup.
      // Preserve them in snapshot history before releasing its project claim.
      if (row && this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(row.project_id)) {
        const author = this.db.prepare("SELECT 1 FROM users WHERE id = ?").get(row.user_id) ? row.user_id : null;
        this.context.recordHistory(row.project_id, author, "file");
      }
      this.db.prepare("UPDATE agent_tasks SET state = ?, error_code = NULL, ended_at = ?, updated_at = ? WHERE id = ?").run(state, now(), now(), id);
      this.recoveries.get(id)?.();
      this.recoveries.delete(id);
    } catch (error) {
      this.db.prepare("UPDATE agent_tasks SET state = 'stopping', error_code = 'AGENT_RECOVERY_FAILED' WHERE id = ?").run(id);
      this.options.onError?.(error);
      throw httpError(409, "AGENT_RECOVERY_FAILED");
    }
  }
  private async withTask<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this.recovery;
    const previous = this.operations.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.operations.set(id, pending);
    try { return await pending; }
    finally { if (this.operations.get(id) === pending) this.operations.delete(id); }
  }
}
