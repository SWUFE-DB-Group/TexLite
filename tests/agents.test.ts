import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/server/agents/sessions.js";
import { AgentRegistry } from "../src/server/agents/registry.js";
import type { AgentAdapter } from "../src/server/agents/adapters/types.js";
import { AGENT_IDS, AGENT_LABELS, agentInputChunks, parseAgentClientMessage, type AgentId, type AgentTask, type AgentServerMessage } from "../src/shared/agentProtocol.js";
import { agentMessages } from "../src/shared/agentMessages.js";
import { agentUiMessages } from "../src/client/agents/messages.js";
import { agentTaskRoot, mergeAgentText } from "../src/server/agents/workspaces.js";
import { loadAgentPty, type AgentPty, type AgentPtyFactory } from "../src/server/agents/terminal.js";
import { CollaborationService } from "../src/server/collaboration.js";
import { ProjectMutationCoordinator } from "../src/server/projectMutations.js";
import { openDatabase, type DatabaseConnection, type UserRow } from "../src/server/db.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { createProjectFiles, sourceRoot } from "../src/server/files.js";
import { ProjectEditHistoryService } from "../src/server/editHistory.js";
import { buildApp } from "../src/server/app.js";
import { hashPassword } from "../src/server/security.js";
import * as Y from "yjs";
import { createSourceAnchor } from "../src/server/anchors.js";

class FakePty implements AgentPty {
  readonly pid = 123456789;
  write = vi.fn(); resize = vi.fn(); pause = vi.fn(); resume = vi.fn(); kill = vi.fn();
  private data = new Set<(value: string) => void>();
  private exit = new Set<(value: { exitCode: number }) => void>();
  onData(callback: (value: string) => void) { this.data.add(callback); return { dispose: () => { this.data.delete(callback); } }; }
  onExit(callback: (value: { exitCode: number }) => void) { this.exit.add(callback); return { dispose: () => { this.exit.delete(callback); } }; }
  output(value: string) { for (const callback of this.data) callback(value); }
  end(exitCode = 0) { for (const callback of [...this.exit]) callback({ exitCode }); }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages: AgentServerMessage[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close = vi.fn((_code?: number, _message?: string) => { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); });
  get ws(): WebSocket { return this as unknown as WebSocket; }
  input(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
}

let root: string;
let config: Config;
let db: DatabaseConnection;
let collaboration: CollaborationService;
let coordinator: ProjectMutationCoordinator;
let service: AgentService;
let registry: AgentRegistry;
let adapters: AgentAdapter[];
let owner: UserRow;
let editor: UserRow;
let reader: UserRow;
let admin: UserRow;
let projectId: string;
let processes: FakePty[];
let spawn: ReturnType<typeof vi.fn<AgentPtyFactory>>;
let app: FastifyInstance | undefined;
const recordHistory = vi.fn();

function user(name: string, role: "user" | "admin" = "user"): UserRow {
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, created_at) VALUES (?, ?, ?, 'unused', ?, 1, ?)")
    .run(id, name, `${name} display`, role, new Date().toISOString());
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agents-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ storage: { dataDir: root }, updates: { enabled: false } }));
  config = loadConfig(configPath);
  config.clientDir = path.join(root, "no-client");
  db = openDatabase(config);
  owner = user("owner"); editor = user("editor"); reader = user("reader"); admin = user("admin", "admin");
  projectId = randomUUID();
  db.prepare("INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at) VALUES (?, ?, 'Paper', 'main.tex', 'pdflatex', ?, ?)")
    .run(projectId, owner.id, new Date().toISOString(), new Date().toISOString());
  for (const [member, permission] of [[editor, "edit"], [reader, "read"]] as const) db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)").run(projectId, member.id, permission, new Date().toISOString());
  createProjectFiles(config, projectId);
  collaboration = new CollaborationService(config, db, ({ projectId: id, edits }) => { new ProjectEditHistoryService(db).record(id, edits); });
  adapters = AGENT_IDS.map<AgentAdapter>((id) => ({ id, label: AGENT_LABELS[id], supportsResume: true,
    discoverFeatures: async () => new Set<string>(), prepare: vi.fn(async () => undefined),
    start: (context) => ({ executable: context.executable, args: [], env: {} }),
    resume: (context) => ({ executable: context.executable, args: ["resume", context.nativeSessionId], env: {} }),
    findNativeSession: async (context) => context.taskId,
    cleanup: vi.fn(async () => undefined) }));
  registry = new AgentRegistry(() => process.execPath, adapters);
  vi.spyOn(registry, "detect").mockImplementation(async () => ({ executable: process.execPath, version: "1.0.0", features: new Set<string>() }));
  processes = [];
  spawn = vi.fn<AgentPtyFactory>(() => { const process = new FakePty(); processes.push(process); return process; });
  coordinator = new ProjectMutationCoordinator(collaboration);
  service = new AgentService({ config, db, collaboration, projectMutations: coordinator, recordHistory,
    recordEdits: (id, edits) => new ProjectEditHistoryService(db).record(id, edits) },
  { registry, loadPty: async () => spawn, stopPty: async (process) => (process as FakePty).end() });
  recordHistory.mockClear();
});

afterEach(async () => {
  await app?.close(); app = undefined;
  await service.dispose();
  collaboration.destroy();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function enable() { await service.setPolicy({ allowed: [...AGENT_IDS] }); }
async function create(agentId: AgentId = "codex", actor = owner) { await enable(); return service.create(projectId, actor, agentId, "Revise abstract"); }
function anotherProject(): string {
  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at) VALUES (?, ?, 'Another', 'main.tex', 'pdflatex', ?, ?)")
    .run(id, editor.id, new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, 'edit', ?)").run(id, owner.id, new Date().toISOString());
  createProjectFiles(config, id);
  return id;
}
async function liveRoom(): Promise<{ doc: Y.Doc }> {
  const internals = collaboration as unknown as {
    initializeRoom: (id: string, generation: number) => Promise<{ doc: Y.Doc }>;
    projectGeneration: (id: string) => number;
  };
  return internals.initializeRoom(projectId, internals.projectGeneration(projectId));
}
const workingFile = (task: AgentTask, file = "main.tex") => path.join(sourceRoot(config, task.projectId), file);

describe("external agent tasks", () => {
  it("lists tasks by last update descending for administration", async () => {
    const oldest = await create(); const newest = await create("claude", editor); const middle = await create("opencode");
    const update = db.prepare("UPDATE agent_tasks SET updated_at = ? WHERE id = ?");
    update.run("2026-10-25T10:00:00Z", oldest.id);
    update.run("2026-10-25T12:00:00Z", newest.id);
    update.run("2026-10-25T11:00:00Z", middle.id);
    expect(service.list(admin, true, {}).tasks.map((task) => task.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it("defaults off and distinguishes missing installations from administrator policy", async () => {
    expect(service.policy()).toEqual({ allowed: [] });
    await expect(service.create(projectId, owner, "codex", "Test")).rejects.toMatchObject({ code: "AGENT_DISABLED" });
    await enable();
    vi.mocked(registry.detect).mockResolvedValue({ executable: null, version: null, features: new Set() });
    const catalog = await service.catalog();
    expect(catalog.agents[0]).toMatchObject({ installed: false, enabled: true });
    await expect(service.create(projectId, owner, "codex", "Test")).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });

  it("allows independent tasks with the same project/user/agent and denies readers", async () => {
    const a = await create(); const b = await create(); const c = await create("codex", editor);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(fs.readFileSync(workingFile(a), "utf8")).toBe(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8"));
    expect(spawn).not.toHaveBeenCalled();
    await expect(service.create(projectId, reader, "codex", "Read only")).rejects.toMatchObject({ code: "PROJECT_EDIT_FORBIDDEN" });
    expect(service.list(owner, false, {}).tasks).toHaveLength(2);
    expect(() => service.task(c.id, owner)).toThrow();
    expect(service.list(admin, true, { project: "Paper" }).total).toBe(3);
    expect(db.prepare("PRAGMA table_info(agent_tasks)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "archived" })]));
  });

  it("claims a project before asynchronous preparation and rejects all other tasks, including other users/agents", async () => {
    const a = await create(); const b = await create("claude", editor); const c = await create("opencode");
    let release!: () => void;
    vi.mocked(adapters[0].prepare).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const starting = service.start(a.id, owner);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(service.start(b.id, editor)).rejects.toMatchObject({ code: "AGENT_PROJECT_BUSY" });
    await expect(service.start(c.id, owner)).rejects.toMatchObject({ code: "AGENT_PROJECT_BUSY" });
    release(); await starting;
    await service.start(a.id, owner);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [], expect.objectContaining({ cwd: sourceRoot(config, projectId) }));
    expect(service.list(editor, false, { project: projectId }).activeTaskId).toBe(a.id);
    await service.stop(a.id, owner);
    await service.start(b.id, editor);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(service.list(owner, false, { project: projectId }).activeTaskId).toBe(b.id);
  });

  it("allows agents in different projects to run concurrently", async () => {
    const a = await create();
    const other = anotherProject();
    const b = await service.create(other, editor, "claude", "Other paper");
    await Promise.all([service.start(a.id, owner), service.start(b.id, editor)]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("releases a failed startup claim and never copies source files", async () => {
    const a = await create(); const b = await create("claude", editor);
    expect(fs.readdirSync(agentTaskRoot(config, a.id))).toEqual(["state"]);
    vi.mocked(adapters[0].prepare).mockRejectedValueOnce(new Error("Credentials unavailable"));
    await expect(service.start(a.id, owner)).rejects.toThrow("Credentials unavailable");
    await service.start(b.id, editor);
    expect(service.task(b.id, editor).state).toBe("running");
  });

  it("retains the project claim when process termination fails, and releases it after retry", async () => {
    const a = await create(); const b = await create("claude", editor);
    await service.dispose();
    const stop = vi.fn<(process: AgentPty) => Promise<void>>(async () => { throw new Error("Cannot stop process group"); });
    service = new AgentService({ config, db, collaboration, projectMutations: coordinator, recordHistory, recordEdits: () => undefined },
      { registry, loadPty: async () => spawn, stopPty: stop });
    await service.start(a.id, owner);
    await expect(service.stop(a.id, owner)).rejects.toThrow("Cannot stop process group");
    await expect(service.start(b.id, editor)).rejects.toMatchObject({ code: "AGENT_PROJECT_BUSY" });
    stop.mockImplementation(async (process) => { (process as FakePty).end(); });
    await service.stop(a.id, owner);
    await service.start(b.id, editor);
  });

  it("keeps processes across disconnect/project archive and stops without deleting context", async () => {
    const task = await create(); await service.start(task.id, owner);
    const socket = new FakeSocket(); service.attach(task.id, owner, socket.ws, () => true);
    socket.close();
    db.prepare("INSERT INTO user_project_archives (user_id, project_id, archived_at) VALUES (?, ?, ?)").run(owner.id, projectId, new Date().toISOString());
    await service.reconcilePermissions();
    expect(service.task(task.id, owner).state).toBe("running");
    expect(service.list(owner, false, { state: "running" }).tasks[0].id).toBe(task.id);
    expect(service.task(task.id, owner)).not.toHaveProperty("archived");
    await service.stop(task.id, owner);
    expect(service.task(task.id, owner)).toMatchObject({ state: "stopped", canResume: true, nativeSessionId: task.id });
    expect(fs.existsSync(workingFile(task))).toBe(true);
    await service.start(task.id, owner);
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(["resume", task.id]);
  });

  it("always resumes an existing task and uses a separate task for a new conversation", async () => {
    const task = await create();
    const firstLaunch = vi.spyOn(adapters[0], "start");
    const resume = vi.spyOn(adapters[0], "resume");
    await service.start(task.id, owner);
    await service.stop(task.id, owner);
    expect(service.task(task.id, owner).nativeSessionId).toBe(task.id);
    await service.start(task.id, owner);
    expect(firstLaunch).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: task.id }));
    expect(service.task(task.id, owner).nativeSessionId).toBe(task.id);
    await service.stop(task.id, owner);
    const next = await create();
    await service.start(next.id, owner);
    expect(firstLaunch).toHaveBeenCalledTimes(2);
    expect(firstLaunch.mock.calls[0][0].stateDirectory).not.toBe(firstLaunch.mock.calls[1][0].stateDirectory);
  });

  it("does not silently replace a conversation when native context is unavailable", async () => {
    const task = await create();
    const firstLaunch = vi.spyOn(adapters[0], "start");
    const resume = vi.spyOn(adapters[0], "resume");
    vi.spyOn(adapters[0], "findNativeSession").mockResolvedValue(null);
    await service.start(task.id, owner);
    await service.stop(task.id, owner);
    await expect(service.start(task.id, owner)).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    expect(firstLaunch).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(service.task(task.id, owner).state).toBe("stopped");
    expect(service.list(owner, false, { project: projectId }).activeTaskId).toBeNull();
    const next = await create();
    await service.start(next.id, owner);
    expect(firstLaunch).toHaveBeenCalledTimes(2);
  });

  it("preserves the original context after a failed resume, without falling back to a fresh start", async () => {
    const task = await create();
    const firstLaunch = vi.spyOn(adapters[0], "start");
    const resume = vi.spyOn(adapters[0], "resume");
    await service.start(task.id, owner);
    await service.stop(task.id, owner);
    resume.mockImplementationOnce(() => { throw new Error("Native resume failed"); });
    await expect(service.start(task.id, owner)).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    expect(service.task(task.id, owner)).toMatchObject({ state: "failed", nativeSessionId: task.id });
    expect(firstLaunch).toHaveBeenCalledTimes(1);
    await service.start(task.id, owner);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(["resume", task.id]);
  });

  it("isolates terminal access and implements single-input ownership and takeover", async () => {
    const task = await create(); await service.start(task.id, owner);
    const first = new FakeSocket(); const second = new FakeSocket();
    service.attach(task.id, owner, first.ws, () => true); service.attach(task.id, owner, second.ws, () => true);
    expect(() => service.attach(task.id, admin, new FakeSocket().ws, () => true)).toThrow();
    second.input({ type: "input", data: "ignored" }); expect(processes[0].write).not.toHaveBeenCalled();
    first.input({ type: "input", data: "hello" }); expect(processes[0].write).toHaveBeenCalledWith("hello");
    second.input({ type: "takeControl" }); second.input({ type: "resize", cols: 120, rows: 35 });
    expect(processes[0].resize).toHaveBeenCalledWith(120, 35);
    first.close(); processes[0].output("output\r\n");
    expect(second.messages.at(-1)).toEqual({ type: "output", data: "output\r\n" });
    const reconnect = new FakeSocket(); service.attach(task.id, owner, reconnect.ws, () => true);
    expect(reconnect.messages).toContainEqual({ type: "output", data: "output\r\n" });
    second.input({ type: "resize", cols: -1, rows: 35 }); expect(second.close).toHaveBeenCalledWith(1008, "Invalid terminal message");
  });

  it("drops slow/expired attachments without stopping a task just because no browser is attached", async () => {
    const task = await create(); await service.start(task.id, owner);
    const slow = new FakeSocket(); const expired = new FakeSocket();
    service.attach(task.id, owner, slow.ws, () => true); service.attach(task.id, owner, expired.ws, () => false);
    slow.bufferedAmount = 1024 * 1024; processes[0].output("progress");
    expect(slow.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(expired.close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(service.task(task.id, owner).state).toBe("running");
  });

  it("stops executions when access is revoked, but preserves the task for cleanup", async () => {
    const task = await create("codex", editor); await service.start(task.id, editor);
    db.prepare("UPDATE project_members SET permission = 'read' WHERE user_id = ? AND project_id = ?").run(editor.id, projectId);
    await service.reconcilePermissions();
    expect(service.task(task.id, editor).state).toBe("stopped");
    await expect(service.start(task.id, editor)).rejects.toMatchObject({ code: "AGENT_DISABLED" });
    await service.remove(task.id, admin, true);
    expect(service.list(admin, true, {}).total).toBe(0);
  });

  it("administrator disablement stops active executions while cleanup remains available", async () => {
    const task = await create(); await service.start(task.id, owner);
    await service.setPolicy({ allowed: [] });
    expect(service.task(task.id, owner).state).toBe("stopped");
    await service.remove(task.id, owner);
    expect(fs.existsSync(agentTaskRoot(config, task.id))).toBe(false);
    expect(db.prepare("SELECT result FROM agent_cleanup_events WHERE task_id = ?").get(task.id)).toEqual({ result: "ok" });
  });

  it("stops only the deselected agent while other allowed agents continue", async () => {
    const codex = await create("codex");
    const opencode = await service.create(anotherProject(), owner, "opencode", "Other project");
    await service.start(codex.id, owner);
    await service.start(opencode.id, owner);
    await service.setPolicy({ allowed: ["opencode"] });
    expect(service.policy()).toEqual({ allowed: ["opencode"] });
    expect(service.task(codex.id, owner).state).toBe("stopped");
    expect(service.task(opencode.id, owner).state).toBe("running");
    await expect(service.start(codex.id, owner)).rejects.toMatchObject({ code: "AGENT_DISABLED" });
    await service.remove(codex.id, owner);
  });

  it("keeps failed native cleanup retryable and never purges unrelated data", async () => {
    const task = await create(); await service.start(task.id, owner);
    vi.mocked(adapters[0].cleanup).mockRejectedValueOnce(new Error("cleanup unavailable"));
    fs.writeFileSync(path.join(root, "unrelated"), "keep");
    await expect(service.remove(task.id, owner)).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(service.task(task.id, owner)).toMatchObject({ cleanupState: "failed", state: "stopped", errorCode: "AGENT_CLEANUP_FAILED" });
    expect(fs.existsSync(workingFile(task))).toBe(true);
    await service.remove(task.id, admin, true);
    expect(fs.existsSync(agentTaskRoot(config, task.id))).toBe(false);
    expect(fs.readFileSync(path.join(root, "unrelated"), "utf8")).toBe("keep");
  });

  it("retains cleanup locators across deletion of projects/users and cleans owned resources", async () => {
    const task = await create(); await service.start(task.id, owner);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(service.list(admin, true, {}).total).toBe(1);
    await service.reconcilePermissions(true);
    expect(service.list(admin, true, {}).total).toBe(0);
    expect(fs.existsSync(agentTaskRoot(config, task.id))).toBe(false);
  });

  it("preserves orphan records when native cleanup fails", async () => {
    const task = await create(); await service.start(task.id, owner);
    vi.mocked(adapters[0].cleanup).mockRejectedValueOnce(new Error("cleanup unavailable"));
    db.prepare("UPDATE projects SET owner_id = ? WHERE id = ?").run(admin.id, projectId);
    db.prepare("DELETE FROM users WHERE id = ?").run(owner.id);
    await service.reconcilePermissions(true);
    expect(service.list(admin, true, {}).tasks[0]).toMatchObject({ id: task.id, projectName: "Paper", userName: owner.display_name, cleanupState: "failed", state: "stopped" });
    await service.remove(task.id, admin, true);
    expect(service.list(admin, true, {}).total).toBe(0);
  });

  it("reclaims state after failed cleanup without removing the task prematurely", async () => {
    const task = await create(); await service.start(task.id, owner);
    vi.mocked(adapters[0].cleanup).mockRejectedValueOnce(new Error("unavailable"));
    await expect(service.remove(task.id, owner)).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(service.task(task.id, owner).cleanupState).toBe("failed");
    await service.remove(task.id, owner);
    expect(service.list(owner, false, {}).total).toBe(0);
  });

  it("does not start processes when PTY support is missing", async () => {
    const task = await create(); await service.dispose();
    service = new AgentService({ config, db, collaboration, projectMutations: new ProjectMutationCoordinator(collaboration), recordHistory, recordEdits: () => undefined }, { registry, loadPty: async () => null });
    await expect(service.start(task.id, owner)).rejects.toMatchObject({ code: "AGENT_PTY_UNAVAILABLE" });
    expect(service.task(task.id, owner).state).toBe("ready");
    expect((await service.catalog()).ptyAvailable).toBe(false);
  });

  it("handles process launch failure without leaving a task apparently running", async () => {
    const task = await create(); spawn.mockImplementationOnce(() => { throw new Error("native spawn failure"); });
    await expect(service.start(task.id, owner)).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    expect(service.task(task.id, owner)).toMatchObject({ state: "failed", errorCode: "AGENT_START_FAILED" });
  });

  it("releases naturally exited executions without automatically restarting them", async () => {
    const task = await create(); await service.start(task.id, owner);
    processes[0].end(7);
    await vi.waitFor(() => expect(service.task(task.id, owner)).toMatchObject({ state: "exited", exitCode: 7, nativeSessionId: task.id }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(workingFile(task))).toBe(true);
  });

  it("marks previous executions interrupted on restart without launching them", async () => {
    const task = await create();
    db.prepare("UPDATE agent_tasks SET state = 'running', ever_started = 1 WHERE id = ?").run(task.id);
    await service.dispose();
    service = new AgentService({ config, db, collaboration, projectMutations: new ProjectMutationCoordinator(collaboration), recordHistory, recordEdits: () => undefined }, { registry, loadPty: async () => spawn, stopPty: async (process) => (process as FakePty).end() });
    expect(service.task(task.id, owner).state).toBe("interrupted"); expect(spawn).not.toHaveBeenCalled();
    await service.start(task.id, owner);
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(["resume", task.id]);
  });

  it("paginates task metadata without enforcing a task-count limit", async () => {
    const task = await create();
    const insert = db.prepare("INSERT INTO agent_tasks (id, project_id, user_id, project_name, user_name, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, 'Paper', 'Owner', 'codex', 'Another task', ?, ?)");
    for (let i = 0; i < 24; i++) insert.run(randomUUID(), projectId, owner.id, task.createdAt, task.updatedAt);
    expect(service.list(admin, true, {}).tasks).toHaveLength(20);
    expect(service.list(owner, false, { page: "2" })).toMatchObject({ total: 25, page: 2, pageSize: 20 });
    expect(service.list(owner, false, { page: "2" }).tasks).toHaveLength(5);
  });
});

describe("agent direct project editing", () => {
  it("copies fixed instructions only on launch and records the new project file", async () => {
    const task = await create("claude", editor);
    expect(fs.existsSync(workingFile(task, "AGENTS.md"))).toBe(false);
    const update = vi.spyOn(collaboration, "updateFile");
    await service.start(task.id, editor);
    const template = fs.readFileSync(new URL("../templates/agents/AGENTS.md", import.meta.url), "utf8");
    expect(fs.readFileSync(workingFile(task, "AGENTS.md"), "utf8")).toBe(template);
    expect(template).toContain("../output");
    expect(template).toContain("TEXLITE_COMPILE_LOG");
    expect(template).not.toContain(root);
    expect(update).toHaveBeenCalledWith(projectId, "AGENTS.md", template, editor.id);
    expect(recordHistory).toHaveBeenCalledWith(projectId, editor.id, "file", ["AGENTS.md"]);
    await service.stop(task.id, editor);
    recordHistory.mockClear();
    await service.start(task.id, editor);
    expect(fs.readFileSync(workingFile(task, "AGENTS.md"), "utf8")).toBe(template);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it.each(["# Custom project instructions\nKeep this verbatim.\n", ""])("preserves an existing AGENTS.md verbatim: %j", async (content) => {
    const task = await create();
    fs.writeFileSync(workingFile(task, "AGENTS.md"), content);
    await service.start(task.id, owner);
    expect(fs.readFileSync(workingFile(task, "AGENTS.md"), "utf8")).toBe(content);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it("does not start a CLI when instructions cannot be copied, and releases the project claim", async () => {
    const task = await create();
    const copy = vi.spyOn(fs.promises, "copyFile").mockRejectedValueOnce(Object.assign(new Error("Instructions unwritable"), { code: "EACCES" }));
    try {
      await expect(service.start(task.id, owner)).rejects.toThrow("Instructions unwritable");
      expect(spawn).not.toHaveBeenCalled();
      expect(service.list(owner, false, { project: projectId }).activeTaskId).toBeNull();
    } finally { copy.mockRestore(); }
    await service.start(task.id, owner);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("runs a real PTY with a deterministic local CLI without calling any model", async (test) => {
    const factory = await loadAgentPty();
    if (!factory) { test.skip(); return; }
    const task = await create();
    await service.dispose();
    adapters[0].start = () => ({ executable: process.execPath, args: ["-e", `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      process.stdout.write('CHILD:' + child.pid + '\\r\\n');
      process.stdout.write('NATIVE_READY\\r\\n');
      process.stdin.on('data', data => { fs.writeFileSync('agent.txt', data); process.stdout.write('NATIVE_REPLY\\r\\n'); });
      setInterval(() => {}, 1000);
    `], env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color" } });
    service = new AgentService({ config, db, collaboration, projectMutations: new ProjectMutationCoordinator(collaboration), recordHistory,
      recordEdits: (id, edits) => new ProjectEditHistoryService(db).record(id, edits) }, { registry, loadPty: async () => factory });
    await service.start(task.id, owner);
    const socket = new FakeSocket(); service.attach(task.id, owner, socket.ws, () => true);
    await vi.waitFor(() => expect(socket.messages.some((message) => message.type === "output" && message.data.includes("NATIVE_READY"))).toBe(true));
    socket.input({ type: "input", data: "hello\r" });
    await vi.waitFor(() => expect(fs.existsSync(workingFile(task, "agent.txt"))).toBe(true));
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "agent.txt"))).toBe(true);
    await service.stop(task.id, owner);
    expect(service.task(task.id, owner).state).toBe("stopped");
    if (process.platform === "linux") {
      const output = socket.messages.filter((message) => message.type === "output").map((message) => message.data).join("");
      const child = output.match(/CHILD:(\d+)/)?.[1]; expect(child).toBeDefined();
      try { expect(fs.readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1][0]).toBe("Z"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "agent.txt"), "utf8")).toContain("hello");
  });

  it("attributes direct edits to the initiating user and preserves project source when deleting a task", async () => {
    const task = await create("claude", editor);
    const before = fs.readFileSync(workingFile(task), "utf8");
    await service.start(task.id, editor);
    fs.writeFileSync(workingFile(task), before + "\nAgent revision.\n");
    await service.stop(task.id, editor);
    expect(db.prepare("SELECT author_id FROM project_edit_segments WHERE project_id = ?").get(projectId)).toEqual({ author_id: editor.id });
    expect(recordHistory).toHaveBeenCalledWith(projectId, editor.id, "file", ["main.tex"]);
    await service.remove(task.id, editor);
    expect(fs.readFileSync(workingFile(task), "utf8")).toBe(before + "\nAgent revision.\n");
    expect(fs.existsSync(agentTaskRoot(config, task.id))).toBe(false);
  });

  it("synchronizes disk writes to a live Yjs room and updates comment anchors", async () => {
    const room = await liveRoom();
    const before = room.doc.getText("source:main.tex").toString();
    const anchor = createSourceAnchor(before, 0, 14);
    const commentId = randomUUID();
    db.prepare("INSERT INTO comments (id, project_id, file_path, author_id, content, selected_text, start_offset, end_offset, context_before, context_after, created_at, updated_at) VALUES (?, ?, 'main.tex', ?, 'Review', ?, ?, ?, ?, ?, ?, ?)")
      .run(commentId, projectId, owner.id, anchor.selectedText, anchor.startOffset, anchor.endOffset, anchor.contextBefore, anchor.contextAfter, new Date().toISOString(), new Date().toISOString());
    const task = await create("codex", editor);
    await service.start(task.id, editor);
    fs.writeFileSync(workingFile(task), "% Added by agent\n" + before);
    await vi.waitFor(() => expect(collaboration.fileContent(projectId, "main.tex")).toBe("% Added by agent\n" + before), { timeout: 3000 });
    expect(db.prepare("SELECT start_offset FROM comments WHERE id = ?").get(commentId)).toEqual({ start_offset: 17 });
    expect(db.prepare("SELECT author_id FROM project_edit_segments WHERE project_id = ?").get(projectId)).toEqual({ author_id: editor.id });
    await service.stop(task.id, editor);
  });

  it("merges non-overlapping human drafts before autosave and retains both authors in edit history", async () => {
    const room = await liveRoom();
    const task = await create("codex", editor);
    const text = room.doc.getText("source:main.tex");
    const before = text.toString();
    await service.start(task.id, editor);
    room.doc.transact(() => text.insert(text.length, "\nHuman appendix.\n"), { socket: {}, user: owner });
    fs.writeFileSync(workingFile(task), "% Agent header\n" + before);
    const receipt = collaboration.flushProject(projectId);
    expect(receipt?.ok).toBe(true);
    expect(text.toString()).toBe("% Agent header\n" + before + "\nHuman appendix.\n");
    expect(fs.readFileSync(workingFile(task), "utf8")).toBe(text.toString());
    expect(db.prepare("SELECT DISTINCT author_id FROM project_edit_segments WHERE project_id = ?").all(projectId)).toEqual(expect.arrayContaining([{ author_id: owner.id }, { author_id: editor.id }]));
    await service.stop(task.id, editor);
  });

  it("does not misattribute ordinary browser saves or HTTP file writes to the agent", async () => {
    const room = await liveRoom();
    const task = await create("claude", editor);
    await service.start(task.id, editor);
    const text = room.doc.getText("source:main.tex");
    room.doc.transact(() => text.insert(text.length, "\nHuman only.\n"), { socket: {}, user: owner });
    collaboration.flushProject(projectId);
    const content = text.toString() + "\nHTTP update.\n";
    fs.writeFileSync(workingFile(task), content);
    collaboration.updateFile(projectId, "main.tex", content, owner.id);
    await service.stop(task.id, editor);
    expect(db.prepare("SELECT DISTINCT author_id FROM project_edit_segments WHERE project_id = ?").all(projectId)).toEqual([{ author_id: owner.id }]);
  });

  it("records an external edit even if a cold room hydrates it before the next poll", async () => {
    const task = await create("codex", editor);
    await service.start(task.id, editor);
    const next = fs.readFileSync(workingFile(task), "utf8") + "\nAgent edit before reconnect\n";
    fs.writeFileSync(workingFile(task), next);
    await liveRoom();
    await service.stop(task.id, editor);
    expect(collaboration.fileContent(projectId, "main.tex")).toBe(next);
    expect(db.prepare("SELECT DISTINCT author_id FROM project_edit_segments WHERE project_id = ?").all(projectId)).toEqual([{ author_id: editor.id }]);
  });

  it("preserves conflicting agent content, keeps the human draft and ends execution", async () => {
    const room = await liveRoom();
    const task = await create("codex", editor);
    await service.start(task.id, editor);
    const text = room.doc.getText("source:main.tex");
    room.doc.transact(() => { text.delete(0, text.length); text.insert(0, "Human replacement"); }, { socket: {}, user: owner });
    fs.writeFileSync(workingFile(task), "Agent replacement");
    expect(collaboration.flushProject(projectId)?.ok).toBe(true);
    expect(text.toString()).toBe("Human replacement");
    expect(fs.readFileSync(workingFile(task), "utf8")).toBe("Human replacement");
    expect(fs.readFileSync(workingFile(task, ".texlite-agent-conflicts/" + task.id + "/main.tex"), "utf8")).toBe("Agent replacement");
    await vi.waitFor(() => expect(service.task(task.id, editor).state).toBe("stopped"));
    expect(service.task(task.id, editor).errorCode).toBe("AGENT_SYNC_CONFLICT");
  });

  it("handles new text, deleted files, binary updates and files written just before exit", async () => {
    const old = path.join(sourceRoot(config, projectId), "old.txt");
    fs.writeFileSync(old, "Old");
    const task = await create(); await service.start(task.id, owner);
    fs.rmSync(old);
    fs.writeFileSync(workingFile(task, "image.png"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(workingFile(task, "new.tex"), "New text");
    processes[0].end();
    await vi.waitFor(() => expect(service.task(task.id, owner).state).toBe("exited"));
    expect(recordHistory).toHaveBeenCalledWith(projectId, owner.id, "file", expect.arrayContaining(["old.txt", "image.png", "new.tex"]));
    expect(fs.readFileSync(workingFile(task, "new.tex"), "utf8")).toBe("New text");
    const next = await create("claude", editor); await service.start(next.id, editor);
  });

  it("flushes edits before launch and ends the agent before an exclusive tree replacement", async () => {
    const room = await liveRoom();
    const text = room.doc.getText("source:main.tex");
    room.doc.transact(() => text.insert(text.length, "\nBefore launch\n"), { socket: {}, user: owner });
    const task = await create(); await service.start(task.id, owner);
    expect(fs.readFileSync(workingFile(task), "utf8")).toContain("Before launch");
    fs.writeFileSync(workingFile(task, "last.txt"), "Last agent write");
    await coordinator.runExclusive(projectId, "test restore", () => {
      expect(service.task(task.id, owner).state).toBe("stopped");
      expect(fs.readFileSync(workingFile(task, "last.txt"), "utf8")).toBe("Last agent write");
    });
  });

  it("does not attribute ordinary directory moves to the agent", async () => {
    const task = await create();
    fs.mkdirSync(workingFile(task, "folder"));
    fs.writeFileSync(workingFile(task, "folder/chapter.tex"), "Chapter");
    await service.start(task.id, owner);
    fs.renameSync(workingFile(task, "folder"), workingFile(task, "renamed"));
    collaboration.movePath(projectId, "folder", "renamed", editor.id);
    recordHistory.mockClear();
    await service.stop(task.id, owner);
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it("provides project/main-file/log context outside the source tree", async () => {
    const task = await create();
    db.prepare("INSERT INTO compile_runs (id, project_id, main_file, status, log, created_at) VALUES (?, ?, 'main.tex', 'failed', 'Missing package', ?)").run(randomUUID(), projectId, new Date().toISOString());
    await service.start(task.id, owner);
    const state = path.join(agentTaskRoot(config, task.id), "state");
    expect(JSON.parse(fs.readFileSync(path.join(state, "project-context.json"), "utf8"))).toMatchObject({
      sourceDirectory: sourceRoot(config, projectId), mainFile: "main.tex", latestCompile: { status: "failed" }
    });
    expect(fs.readFileSync(path.join(state, "compile.log"), "utf8")).toBe("Missing package");
    db.prepare("UPDATE compile_runs SET status = 'succeeded', log = 'Fixed' WHERE project_id = ?").run(projectId);
    await service.refreshProjectContext(projectId);
    expect(fs.readFileSync(path.join(state, "compile.log"), "utf8")).toBe("Fixed");
  });

  it("rejects agent-created symlinks without reading outside the project", async () => {
    const task = await create(); await service.start(task.id, owner);
    fs.symlinkSync(path.join(root, "config.json"), workingFile(task, "link.txt"));
    await vi.waitFor(() => expect(service.task(task.id, owner).state).toBe("stopped"), { timeout: 3000 });
    expect(service.task(task.id, owner).errorCode).toBe("AGENT_SYNC_FAILED");
    fs.rmSync(workingFile(task, "link.txt"));
    expect(() => agentTaskRoot(config, "..")).toThrow();
  });

});

describe("conservative agent text merging", () => {
  it.each([
    ["alpha beta gamma", "ALPHA beta gamma", "alpha beta GAMMA", "ALPHA beta GAMMA"],
    ["abcd", "Abcd", "aBcd", "ABcd"],
    ["abc", "abc!", "abc!", "abc!"],
    ["abc", "aXbc", "aYbc", null],
    ["abc", "aBc", "aXc", null],
    ["abc", "aXYc", "aXc", null],
    ["你好 😀 世界", "您好 😀 世界", "你好 😀 世界！", "您好 😀 世界！"]
  ])("merges only unambiguous edits: %j / %j / %j", (base, human, agent, expected) => {
    expect(mergeAgentText(base, human, agent)).toBe(expected);
  });
});

describe("agent HTTP and WebSocket permissions", () => {
  async function httpApp() {
    await service.dispose();
    db.prepare("UPDATE users SET password_hash = ?").run(await hashPassword("agent-test-password"));
    app = await buildApp(config, db, { logger: false, agents: { registry, loadPty: async () => spawn, stopPty: async (process) => (process as FakePty).end() } });
    const login = async (actor: UserRow) => {
      const result = await app!.inject({ method: "POST", url: `${config.basePath === "/" ? "" : config.basePath}/api/auth/login`, payload: { username: actor.username, password: "agent-test-password" } });
      const header = result.headers["set-cookie"];
      return (Array.isArray(header) ? header[0] : header)!.split(";")[0];
    };
    return { ownerCookie: await login(owner), adminCookie: await login(admin), readerCookie: await login(reader), editorCookie: await login(editor) };
  }

  it("restricts configuration/metadata administration without granting project access", async () => {
    const cookies = await httpApp();
    expect((await app!.inject({ url: "/api/admin/agents", headers: { cookie: cookies.ownerCookie } })).statusCode).toBe(403);
    expect((await app!.inject({ url: "/api/agents" })).statusCode).toBe(401);
    expect((await app!.inject({ method: "PATCH", url: "/api/admin/agents", headers: { cookie: cookies.adminCookie }, payload: { allowed: ["codex", "shell"] } })).statusCode).toBe(400);
    const policyResponse = await app!.inject({ method: "PATCH", url: "/api/admin/agents", headers: { cookie: cookies.adminCookie }, payload: { allowed: ["codex"] } });
    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json().policy).toEqual({ allowed: ["codex"] });
    const created = await app!.inject({ method: "POST", url: `/api/projects/${projectId}/agent-tasks`, headers: { cookie: cookies.ownerCookie }, payload: { agentId: "codex", title: "Real task" } });
    expect(created.statusCode).toBe(201);
    const { task } = created.json() as { task: AgentTask };
    expect((await app!.inject({ url: `/api/agent-tasks/${task.id}`, headers: { cookie: cookies.adminCookie } })).statusCode).toBe(404);
    expect((await app!.inject({ url: "/api/admin/agent-tasks", headers: { cookie: cookies.adminCookie } })).json().total).toBe(1);
    expect((await app!.inject({ url: "/api/projects", headers: { cookie: cookies.adminCookie } })).json().projects).toEqual([]);
    expect((await app!.inject({ method: "POST", url: `/api/projects/${projectId}/agent-tasks`, headers: { cookie: cookies.readerCookie }, payload: { agentId: "codex", title: "Forbidden" } })).statusCode).toBe(403);
    expect(task).not.toHaveProperty("archived");
    expect((await app!.inject({ method: "PATCH", url: `/api/agent-tasks/${task.id}`, headers: { cookie: cookies.ownerCookie }, payload: { archived: true } })).statusCode).toBe(400);
    const renamed = await app!.inject({ method: "PATCH", url: `/api/agent-tasks/${task.id}`, headers: { cookie: cookies.ownerCookie }, payload: { title: "Renamed task" } });
    expect(renamed.json().task.title).toBe("Renamed task");
  });

  it("drains final agent writes during application shutdown", async () => {
    const cookies = await httpApp();
    db.prepare("UPDATE agent_policy SET allowed = '[\"codex\"]' WHERE id = 1").run();
    const created = await app!.inject({ method: "POST", url: `/api/projects/${projectId}/agent-tasks`, headers: { cookie: cookies.ownerCookie }, payload: { agentId: "codex", title: "Shutdown task" } });
    const { task } = created.json() as { task: AgentTask };
    await app!.inject({ method: "POST", url: `/api/agent-tasks/${task.id}/start`, headers: { cookie: cookies.ownerCookie }, payload: {} });
    fs.appendFileSync(workingFile(task), "\nLast edit before shutdown\n");
    await app!.close(); app = undefined;
    expect(db.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(task.id)).toEqual({ state: "stopped" });
    expect(db.prepare("SELECT author_id FROM project_edit_segments WHERE project_id = ?").get(projectId)).toEqual({ author_id: owner.id });
    expect(fs.readFileSync(workingFile(task), "utf8")).toContain("Last edit before shutdown");
  });

  it("automatically resumes through the start endpoint without a browser-selected launch mode", async () => {
    const cookies = await httpApp();
    db.prepare("UPDATE agent_policy SET allowed = '[\"codex\"]' WHERE id = 1").run();
    const created = await app!.inject({ method: "POST", url: `/api/projects/${projectId}/agent-tasks`, headers: { cookie: cookies.ownerCookie },
      payload: { agentId: "codex", title: "One conversation" } });
    const { task } = created.json() as { task: AgentTask };
    const first = await app!.inject({ method: "POST", url: `/api/agent-tasks/${task.id}/start`, headers: { cookie: cookies.ownerCookie } });
    expect(first.statusCode).toBe(200);
    expect(spawn.mock.calls[0][1]).toEqual([]);
    await app!.inject({ method: "POST", url: `/api/agent-tasks/${task.id}/stop`, headers: { cookie: cookies.ownerCookie } });
    const continued = await app!.inject({ method: "POST", url: `/api/agent-tasks/${task.id}/start`, headers: { cookie: cookies.ownerCookie } });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().task.nativeSessionId).toBe(task.id);
    expect(spawn.mock.calls[1][1]).toEqual(["resume", task.id]);
  });

  it("preserves tasks across project archive, reuses a process, and exposes an authenticated terminal", async () => {
    config.basePath = "/tools/latex";
    const cookies = await httpApp(); const base = config.basePath;
    // Login above used root routes: re-login using the deployed prefix.
    const login = await app!.inject({ method: "POST", url: `${base}/api/auth/login`, payload: { username: owner.username, password: "agent-test-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    db.prepare("UPDATE agent_policy SET allowed = '[\"codex\"]' WHERE id = 1").run();
    const created = await app!.inject({ method: "POST", url: `${base}/api/projects/${projectId}/agent-tasks`, headers: { cookie }, payload: { agentId: "codex", title: "Terminal task" } });
    const { task } = created.json() as { task: AgentTask }; expect(task).toBeDefined();
    expect((await app!.inject({ method: "POST", url: `${base}/api/agent-tasks/${task.id}/start`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
    const received: AgentServerMessage[] = [];
    const socket = await app!.injectWS(`${base}/api/agent-tasks/${task.id}/terminal`, { headers: { cookie, host: "localhost", origin: "http://localhost" }, socket: new Socket() }, { onInit: (client) => client.on("message", (raw) => received.push(JSON.parse(raw.toString()))) });
    expect({ state: socket.readyState, messages: received }).toMatchObject({ state: 1 });
    socket.send(JSON.stringify({ type: "input", data: "test-input" }));
    await vi.waitFor(() => expect(processes[0].write).toHaveBeenCalledWith("test-input"));
    socket.close();
    expect((await app!.inject({ method: "PUT", url: `${base}/api/projects/${projectId}/archive`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app!.inject({ url: `${base}/api/agent-tasks/${task.id}`, headers: { cookie } })).json().task.state).toBe("running");
    const invalid = await app!.injectWS(`${base}/api/agent-tasks/${task.id}/terminal`, { headers: { cookie, host: "localhost", origin: "http://evil.test" } });
    await vi.waitFor(() => expect(invalid.readyState).toBe(3));
    expect(processes[0].write).toHaveBeenCalledTimes(1);
    // Live terminal authentication must not reuse currentUser's per-request cache.
    const fresh = await app!.injectWS(`${base}/api/agent-tasks/${task.id}/terminal`, { headers: { cookie, host: "localhost", origin: "http://localhost" }, socket: new Socket() });
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(owner.id);
    fresh.send(JSON.stringify({ type: "input", data: "expired" }));
    await vi.waitFor(() => expect(fresh.readyState).toBe(3));
    expect(processes[0].write).toHaveBeenCalledTimes(1);
    void cookies;
  });
});

describe("agent protocol and localization", () => {
  it("preserves large Unicode pastes across bounded transport frames", () => {
    const input = "x".repeat(64 * 1024 - 1) + "📝" + "y".repeat(64 * 1024);
    const chunks = agentInputChunks(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks).toHaveLength(3);
    for (const data of chunks) {
      expect(parseAgentClientMessage(JSON.stringify({ type: "input", data }))).toEqual({ type: "input", data });
      expect(data).not.toMatch(/[\ud800-\udbff]$/);
    }
  });
  it("validates terminal operations without accepting arbitrary commands or sizes", () => {
    expect(parseAgentClientMessage('{"type":"takeControl"}')).toEqual({ type: "takeControl" });
    for (const value of ["not-json", "null", '{"type":"spawn","command":"sh"}', '{"type":"input","data":3}', '{"type":"resize","cols":1,"rows":20}']) expect(parseAgentClientMessage(value)).toBeNull();
  });
  it.each(["zh", "zh-Hant"] as const)("keeps %s agent messages and variables aligned", (locale) => {
    for (const catalog of [agentUiMessages, agentMessages]) {
      expect(Object.keys(catalog[locale]).sort()).toEqual(Object.keys(catalog.en).sort());
      for (const [key, value] of Object.entries(catalog.en)) expect((catalog[locale] as Record<string, string>)[key].match(/{{\w+}}/g) ?? [])
        .toEqual(value.match(/{{\w+}}/g) ?? []);
    }
  });
});
