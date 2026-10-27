import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAdapter } from "../src/server/agents/adapters/codex.js";
import { claudeAdapter } from "../src/server/agents/adapters/claude.js";
import { opencodeAdapter } from "../src/server/agents/adapters/opencode.js";
import type { AgentAdapterContext } from "../src/server/agents/adapters/types.js";
import { AgentRegistry } from "../src/server/agents/registry.js";
import { windowsAgentCommand } from "../src/server/agents/terminal.js";
import * as agentCommands from "../src/server/agents/adapters/common.js";

let root: string;
let context: AgentAdapterContext;

function fakeOpenCode(sessions: Array<{ id: string }>): string {
  fs.mkdirSync(context.workingDirectory, { recursive: true });
  fs.copyFileSync(new URL("./fixtures/opencode-session.cjs", import.meta.url), path.join(context.workingDirectory, "session"));
  context.executable = process.execPath;
  const database = opencodeAdapter.start(context).env.OPENCODE_DB;
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, JSON.stringify(sessions));
  return database;
}

function fakeSharedOpenCode(sessions: string[] = ["ses_native"]): string {
  fs.mkdirSync(context.workingDirectory, { recursive: true });
  for (const command of ["debug", "session"]) fs.copyFileSync(new URL("./fixtures/opencode-session.cjs", import.meta.url), path.join(context.workingDirectory, command));
  context = { ...context, executable: process.execPath, features: new Set(["standalone"]) };
  const filename = path.join(root, "host.db");
  vi.stubEnv("OPENCODE_DB", filename);
  const db = new Database(filename);
  try {
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY); CREATE TABLE credential (integration_id TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO credential VALUES (?, ?)").run("github-copilot", "host fixture credential");
    for (const id of sessions) db.prepare("INSERT INTO session_v2 VALUES (?)").run(id);
  } finally { db.close(); }
  return filename;
}

function sharedSessionId(): string { return `ses_texlite${context.taskId.replaceAll("-", "")}`; }
function privateDatabasePath(): string { return path.join(context.stateDirectory, "data", "opencode", "opencode.db"); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-adapters-"));
  vi.stubEnv("XDG_DATA_HOME", path.join(root, "host-data"));
  vi.stubEnv("XDG_STATE_HOME", path.join(root, "host-state"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "host-claude"));
  context = { taskId: "11111111-2222-4333-8444-555555555555", nativeSessionId: null,
    executable: "agent", stateDirectory: path.join(root, "state"), workingDirectory: path.join(root, "work"), features: new Set() };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("native agent adapters", () => {
  it("wraps Windows npm command entrypoints without exposing arbitrary shell expansion", () => {
    const command = windowsAgentCommand("C:\\Users\\Research Team\\codex.cmd", ["resume", context.taskId]);
    expect(command.args).toBe(`/d /v:off /s /c ""C:\\Users\\Research Team\\codex.cmd" "resume" "${context.taskId}""`);
    expect(() => windowsAgentCommand("codex.cmd", ["%TEMP%"]).args).toThrow();
  });
  it("scopes Codex state, resumes an explicit ID, and only enables detected flags", () => {
    vi.stubEnv("TEXLITE_SECRET", "do-not-inherit");
    const start = codexAdapter.start(context);
    expect(start.env.CODEX_HOME).toBe(path.join(context.stateDirectory, "codex"));
    expect(start.env.TEXLITE_SECRET).toBeUndefined();
    expect(start.args).not.toContain("--no-daemon");
    expect(codexAdapter.start({ ...context, features: new Set(["no-daemon"]) }).args).toContain("--no-daemon");
    expect(codexAdapter.resume({ ...context, nativeSessionId: context.taskId }).args).toEqual(["resume", context.taskId, "--no-alt-screen"]);
    expect(start.args.some((arg) => arg.includes("bypass") || arg === "--last")).toBe(false);
  });

  it("copies explicit credentials once and preserves task-refreshed credentials", async () => {
    const host = path.join(root, "host"); fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, "auth.json"), "host credentials");
    fs.writeFileSync(path.join(host, "config.toml"), "model = 'host-model'");
    fs.mkdirSync(path.join(host, "sessions")); fs.writeFileSync(path.join(host, "sessions", "unrelated"), "keep");
    vi.stubEnv("CODEX_HOME", host);
    await codexAdapter.prepare(context);
    const auth = path.join(context.stateDirectory, "codex", "auth.json");
    expect(fs.readFileSync(auth, "utf8")).toBe("host credentials");
    expect(fs.existsSync(path.join(context.stateDirectory, "codex", "sessions"))).toBe(false);
    fs.writeFileSync(auth, "refreshed task credentials"); await codexAdapter.prepare(context);
    expect(fs.readFileSync(auth, "utf8")).toBe("refreshed task credentials");
    await codexAdapter.cleanup(context);
    expect(fs.readFileSync(path.join(host, "sessions", "unrelated"), "utf8")).toBe("keep");
  });

  it("locates only a unique Codex context rather than selecting another task's latest conversation", async () => {
    const dir = path.join(context.stateDirectory, "codex", "sessions", "2026", "10", "25"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-${context.taskId}.jsonl`), "{}");
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "found", id: context.taskId });
    fs.writeFileSync(path.join(dir, "rollout-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"), "{}");
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
  });

  it("does not inherit OpenCode's host database or remote execution settings", () => {
    vi.stubEnv("OPENCODE_DB", "/unrelated/host.db"); vi.stubEnv("OPENCODE_SERVER_URL", "http://another-instance");
    const start = opencodeAdapter.start(context);
    expect(start.env.OPENCODE_DB).toBe(path.join(context.stateDirectory, "data", "opencode", "opencode.db"));
    expect(start.env.XDG_DATA_HOME).toBe(path.join(context.stateDirectory, "data"));
    expect(start.env.XDG_STATE_HOME).toBe(path.join(context.stateDirectory, "runtime"));
    expect(start.env.OPENCODE_SERVER_URL).toBeUndefined();
    expect(opencodeAdapter.resume({ ...context, nativeSessionId: "ses_test" }).args).toEqual(["--session", "ses_test"]);
  });

  it.each([codexAdapter, opencodeAdapter])("does not expand $id environment access to Claude-only provider settings", (adapter) => {
    const names = ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET"];
    for (const name of names) vi.stubEnv(name, "fixture Claude-only setting");
    const start = adapter.start(context);
    const resume = adapter.resume({ ...context, nativeSessionId: "ses_saved" });
    for (const name of names) {
      expect(start.env).not.toHaveProperty(name);
      expect(resume.env).not.toHaveProperty(name);
    }
  });

  it.each([
    { adapter: codexAdapter, privateKeys: ["CODEX_HOME"] },
    { adapter: opencodeAdapter, privateKeys: ["OPENCODE_DB", "XDG_DATA_HOME", "XDG_STATE_HOME"] }
  ])("inherits the host cache across $adapter.id tasks without sharing conversation state", ({ adapter, privateKeys }) => {
    const cache = path.join(root, "host-cache");
    vi.stubEnv("XDG_CACHE_HOME", cache);
    const first = adapter.start(context);
    const other = { ...context, taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", stateDirectory: path.join(root, "other-state"),
      workingDirectory: path.join(root, "other-project"), nativeSessionId: "ses_saved" };
    const second = adapter.resume(other);
    expect(first.env.XDG_CACHE_HOME).toBe(cache);
    expect(second.env.XDG_CACHE_HOME).toBe(cache);
    for (const key of privateKeys) {
      expect(first.env[key].startsWith(context.stateDirectory + path.sep)).toBe(true);
      expect(second.env[key].startsWith(other.stateDirectory + path.sep)).toBe(true);
      expect(first.env[key]).not.toBe(second.env[key]);
    }
  });

  it.each([codexAdapter, opencodeAdapter, claudeAdapter])("leaves $id cache defaults to the CLI when XDG_CACHE_HOME is unset", async (adapter) => {
    vi.stubEnv("XDG_CACHE_HOME", undefined);
    if (adapter.id === "claude") await adapter.prepare(context);
    expect(adapter.start(context).env).not.toHaveProperty("XDG_CACHE_HOME");
    expect(adapter.resume({ ...context, nativeSessionId: adapter.id === "claude" ? context.taskId : "ses_saved" }).env).not.toHaveProperty("XDG_CACHE_HOME");
  });

  it("discovers an OpenCode session in the project's cwd, not the TexLite server's cwd", async () => {
    fakeOpenCode([{ id: "ses_existingProjectConversation" }]);
    expect(process.cwd()).not.toBe(context.workingDirectory);
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "found", id: "ses_existingProjectConversation" });
  });

  it("deletes only the identified OpenCode session in the same project cwd and state", async () => {
    const database = fakeOpenCode([{ id: "ses_ownConversation" }]);
    await opencodeAdapter.cleanup({ ...context, nativeSessionId: "ses_ownConversation" });
    expect(JSON.parse(fs.readFileSync(database, "utf8"))).toEqual([]);
  });

  it("does not guess or delete another OpenCode conversation when discovery is ambiguous", async () => {
    const sessions = [{ id: "ses_first" }, { id: "ses_second" }];
    const database = fakeOpenCode(sessions);
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await opencodeAdapter.cleanup({ ...context, nativeSessionId: "ses_first" });
    expect(JSON.parse(fs.readFileSync(database, "utf8"))).toEqual(sessions);
  });

  it("uses a deterministic Claude conversation ID and requires its actual transcript before restoring it", async () => {
    expect(claudeAdapter.start(context).args).toEqual(["--session-id", context.taskId]);
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await claudeAdapter.prepare(context);
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    await expect(claudeAdapter.prepare({ ...context, nativeSessionId: context.taskId })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    const dir = path.join(root, "host-claude", "projects", "task-workspace"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${context.taskId}.jsonl`), "{}");
    expect(await claudeAdapter.findNativeSession(context)).toEqual({ status: "found", id: context.taskId });
    await claudeAdapter.prepare({ ...context, nativeSessionId: context.taskId });
    expect(claudeAdapter.resume({ ...context, nativeSessionId: context.taskId }).args).toEqual(["--resume", context.taskId]);
  });

  it("distinguishes a verified empty OpenCode session list from a missing database", async () => {
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    expect(fs.existsSync(opencodeAdapter.start(context).env.OPENCODE_DB)).toBe(false);
    fakeOpenCode([]);
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
  });

  it.each(["not json", "{}", '[{"id":"invalid"}]'])("does not mistake failed or unsupported OpenCode discovery for an empty conversation (%s)", async (data) => {
    const database = fakeOpenCode([]);
    fs.writeFileSync(database, data);
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
  });

  it("distinguishes unused and missing transcript stores for Codex", async () => {
    const directory = path.join(context.stateDirectory, "codex");
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    fs.mkdirSync(directory, { recursive: true });
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    const transcripts = path.join(directory, "sessions");
    fs.mkdirSync(transcripts);
    fs.writeFileSync(path.join(transcripts, `rollout-${context.taskId}.jsonl`), "{}");
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "found", id: context.taskId });
  });

  it("recognizes archived transcript evidence instead of treating the Codex home as unused", async () => {
    const directory = path.join(context.stateDirectory, "codex", "archived_sessions");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `rollout-${context.taskId}.jsonl`), "{}");
    expect(await codexAdapter.findNativeSession(context)).toEqual({ status: "found", id: context.taskId });
  });

  it.each([0, 1])("verifies silent OpenCode listings against its own SQLite database (%i sessions)", async (count) => {
    const filename = fakeOpenCode([]);
    fs.rmSync(filename);
    const db = new Database(filename);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    if (count) db.prepare("INSERT INTO session VALUES (?)").run("ses_existing");
    db.close();
    fs.writeFileSync(path.join(context.workingDirectory, "session"), "process.exit(0);");
    expect(await opencodeAdapter.findNativeSession(context)).toEqual(count ? { status: "found", id: "ses_existing" } : { status: "empty" });
    const check = new Database(filename, { readonly: true });
    try { expect(check.prepare("SELECT COUNT(*) AS count FROM session").get()).toEqual({ count }); }
    finally { check.close(); }
  });

  it("does not interpret silence with an unreadable native database as an unused conversation", async () => {
    fakeOpenCode([]);
    fs.writeFileSync(path.join(context.workingDirectory, "session"), "process.exit(0);");
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
  });

  it("can verify a genuinely empty database without depending on OpenCode management commands", async () => {
    const filename = fakeOpenCode([]);
    fs.rmSync(filename);
    const db = new Database(filename);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.close();
    fs.writeFileSync(path.join(context.workingDirectory, "session"), "throw new Error('Management command must not run for a verified empty store');");
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
  });

  it("finds saved sessions from SQLite instead of trusting an empty CLI listing", async () => {
    const filename = fakeOpenCode([]);
    fs.rmSync(filename);
    const db = new Database(filename);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('ses_existing')");
    db.close();
    fs.writeFileSync(path.join(context.workingDirectory, "session"), "process.stdout.write('[]');");
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "found", id: "ses_existing" });
  });

  it.each([true, false])("detects OpenCode standalone support without hardcoding a version (supported=%s)", async (standalone) => {
    vi.spyOn(agentCommands, "executeAgentCommand").mockResolvedValueOnce({ stdout: standalone ? "FLAGS\n  --standalone  Use a private server\n" : "FLAGS\n  --session ID", stderr: "" });
    const features = await opencodeAdapter.discoverFeatures(context.executable);
    expect(features.has("standalone")).toBe(standalone);
    const scoped = { ...context, features };
    expect(opencodeAdapter.start(scoped).args).toEqual(standalone ? ["--standalone", "--session", sharedSessionId()] : []);
    if (standalone) expect(() => opencodeAdapter.resume({ ...scoped, nativeSessionId: "ses_saved" })).toThrow();
    else expect(opencodeAdapter.resume({ ...scoped, nativeSessionId: "ses_saved" }).args).toEqual(["--session", "ses_saved"]);
  });

  it("does not let OpenCode create a replacement for a missing --session ID", async () => {
    fakeOpenCode([]);
    await expect(opencodeAdapter.prepare({ ...context, nativeSessionId: "ses_deleted" })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
    const filename = opencodeAdapter.start(context).env.OPENCODE_DB;
    fs.writeFileSync(filename, JSON.stringify([{ id: "ses_different" }]));
    await expect(opencodeAdapter.prepare({ ...context, nativeSessionId: "ses_deleted" })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
  });

  it("does not create a replacement after an unverified OpenCode resume lookup", async () => {
    await expect(opencodeAdapter.prepare({ ...context, nativeSessionId: "ses_saved", features: new Set(["standalone"]) }))
      .rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
  });

  it("does not clean unregistered host conversations even when a session ID is supplied", async () => {
    const execute = vi.spyOn(agentCommands, "executeAgentCommand");
    await expect(opencodeAdapter.cleanup({ ...context, nativeSessionId: "ses_saved", features: new Set(["standalone"]) }))
      .rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("shares native authentication and binds a fresh V2 task without claiming existing host conversations", async () => {
    const filename = fakeSharedOpenCode();
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await opencodeAdapter.prepare(context);
    const launch = opencodeAdapter.start(context);
    expect(launch.env.OPENCODE_DB).toBe(filename);
    expect(launch.env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME);
    expect(launch.env.XDG_STATE_HOME).toBe(process.env.XDG_STATE_HOME);
    expect(launch.args).toEqual(["--standalone", "--session", sharedSessionId()]);
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    const db = new Database(filename);
    try {
      expect(db.prepare("SELECT integration_id FROM credential").all()).toEqual([{ integration_id: "github-copilot" }]);
      expect(db.prepare("SELECT id FROM session_v2").all()).toEqual([{ id: "ses_native" }]);
      db.prepare("INSERT INTO session_v2 VALUES (?)").run(sharedSessionId());
    } finally { db.close(); }
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "found", id: sharedSessionId() });
    expect(fs.existsSync(privateDatabasePath())).toBe(false);
  });

  it("pins the registered database across host configuration changes and verifies exact V2 resumes", async () => {
    const filename = fakeSharedOpenCode();
    await opencodeAdapter.prepare(context);
    const db = new Database(filename);
    db.prepare("INSERT INTO session_v2 VALUES (?)").run(sharedSessionId()); db.close();
    vi.stubEnv("OPENCODE_DB", path.join(root, "different-host.db"));
    const saved = { ...context, nativeSessionId: sharedSessionId() };
    await opencodeAdapter.prepare(saved);
    expect(opencodeAdapter.resume(saved).env.OPENCODE_DB).toBe(filename);
    expect(opencodeAdapter.resume(saved).args).toEqual(["--standalone", "--session", sharedSessionId()]);
    expect(() => opencodeAdapter.resume({ ...context, nativeSessionId: "ses_native" })).toThrow();
    await expect(opencodeAdapter.prepare({ ...context, nativeSessionId: "ses_native" }))
      .rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    const update = new Database(filename);
    update.prepare("DELETE FROM session_v2 WHERE id = ?").run(sharedSessionId()); update.close();
    await expect(opencodeAdapter.prepare(saved)).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
  });

  it.each([true, false])("deletes only the registered V2 session and preserves host data (project exists=%s)", async (projectExists) => {
    const filename = fakeSharedOpenCode();
    await opencodeAdapter.prepare(context);
    const db = new Database(filename);
    db.prepare("INSERT INTO session_v2 VALUES (?)").run(sharedSessionId()); db.close();
    if (!projectExists) {
      fs.copyFileSync(path.join(context.workingDirectory, "session"), path.join(context.stateDirectory, "session"));
      fs.rmSync(context.workingDirectory, { recursive: true });
    }
    const saved = { ...context, nativeSessionId: sharedSessionId() };
    await opencodeAdapter.cleanup(saved);
    await opencodeAdapter.cleanup(saved); // Retrying an already completed deletion is safe.
    expect(fs.existsSync(context.workingDirectory)).toBe(projectExists);
    const check = new Database(filename, { readonly: true });
    try {
      expect(check.prepare("SELECT id FROM session_v2").all()).toEqual([{ id: "ses_native" }]);
      expect(check.prepare("SELECT value FROM credential").get()).toEqual({ value: "host fixture credential" });
    } finally { check.close(); }
    expect(fs.existsSync(filename)).toBe(true);
  });

  it("does not resurrect a deleted V2 session from a leftover legacy table", async () => {
    const filename = fakeSharedOpenCode();
    await opencodeAdapter.prepare(context);
    const db = new Database(filename);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO session VALUES (?)").run(sharedSessionId()); db.close();
    expect(await opencodeAdapter.findNativeSession({ ...context, nativeSessionId: sharedSessionId() })).toEqual({ status: "empty" });
    await expect(opencodeAdapter.prepare({ ...context, nativeSessionId: sharedSessionId() })).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
  });

  it("does not claim an existing host ID before recording ownership", async () => {
    fakeSharedOpenCode([sharedSessionId(), "ses_native"]);
    await expect(opencodeAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    expect(fs.existsSync(path.join(context.stateDirectory, "opencode-session.json"))).toBe(false);
  });

  it.each(["not json", JSON.stringify({ database: "/somewhere/native.db", sessionId: "ses_native" })])("refuses invalid ownership bindings without native cleanup (%s)", async (data) => {
    fakeSharedOpenCode();
    fs.mkdirSync(context.stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(context.stateDirectory, "opencode-session.json"), data);
    const execute = vi.spyOn(agentCommands, "executeAgentCommand");
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(opencodeAdapter.cleanup(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps shared cleanup retryable when the registered database is unavailable", async () => {
    const filename = fakeSharedOpenCode();
    await opencodeAdapter.prepare(context);
    fs.renameSync(filename, filename + ".offline");
    const execute = vi.spyOn(agentCommands, "executeAgentCommand");
    await expect(opencodeAdapter.cleanup(context)).rejects.toMatchObject({ code: "AGENT_CLEANUP_FAILED" });
    expect(execute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(context.stateDirectory, "opencode-session.json"))).toBe(true);
  });

  it("reports native path discovery failures without exposing command diagnostics", async () => {
    fakeSharedOpenCode();
    vi.spyOn(agentCommands, "executeAgentCommand").mockRejectedValueOnce(new Error("private native diagnostic"));
    await expect(opencodeAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    expect(fs.existsSync(path.join(context.stateDirectory, "opencode-session.json"))).toBe(false);
  });

  it("upgrades an empty private V2 store while retaining its old files", async () => {
    const filename = fakeSharedOpenCode();
    const privateFile = privateDatabasePath();
    fs.mkdirSync(path.dirname(privateFile), { recursive: true });
    const old = new Database(privateFile); old.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)"); old.close();
    expect(await opencodeAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    await opencodeAdapter.prepare(context);
    expect(opencodeAdapter.start(context).env.OPENCODE_DB).toBe(filename);
    expect(fs.existsSync(privateFile)).toBe(true);
  });

  it.each(["session", "session_v2"])("preserves a private %s conversation when resuming after a CLI upgrade", async (table) => {
    const filename = fakeOpenCode([]); fs.rmSync(filename);
    const db = new Database(filename);
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('ses_first'), ('ses_saved')`);
    db.close();
    vi.stubEnv("XDG_DATA_HOME", path.join(root, "host-without-credentials"));
    const scoped = { ...context, nativeSessionId: "ses_saved", features: new Set(["standalone"]) };
    const execute = vi.spyOn(agentCommands, "executeAgentCommand");
    expect(await opencodeAdapter.findNativeSession(scoped)).toEqual({ status: "found", id: "ses_saved" });
    await expect(opencodeAdapter.prepare(scoped)).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(opencodeAdapter.resume(scoped).env.OPENCODE_DB).toBe(filename);
    expect(fs.existsSync(path.join(context.stateDirectory, "opencode-session.json"))).toBe(false);
    const update = new Database(filename);
    update.prepare(`DELETE FROM ${table} WHERE id = ?`).run("ses_saved"); update.close();
    await expect(opencodeAdapter.prepare(scoped)).rejects.toMatchObject({ code: "AGENT_NO_CONTEXT" });
  });

  it("discovers executables without treating installation as permission or authentication", async () => {
    const registry = new AgentRegistry((id) => id === "claude" ? process.execPath : null);
    const catalog = await registry.catalog({ allowed: [] });
    expect(catalog.find((agent) => agent.id === "claude")).toMatchObject({ installed: true, enabled: false, version: process.version.slice(1) });
    expect(catalog.find((agent) => agent.id === "codex")).toMatchObject({ installed: false, version: null });
    const allowed = await registry.catalog({ allowed: ["claude"] });
    expect(allowed.find((agent) => agent.id === "claude")).toMatchObject({ installed: true, enabled: true });
  });
});
