import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAdapter } from "../src/server/agents/adapters/codex.js";
import { claudeAdapter } from "../src/server/agents/adapters/claude.js";
import { opencodeAdapter } from "../src/server/agents/adapters/opencode.js";
import type { AgentAdapterContext } from "../src/server/agents/adapters/types.js";
import { AgentRegistry } from "../src/server/agents/registry.js";
import { windowsAgentCommand } from "../src/server/agents/terminal.js";

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-adapters-"));
  context = { taskId: "11111111-2222-4333-8444-555555555555", nativeSessionId: null,
    executable: "agent", stateDirectory: path.join(root, "state"), workingDirectory: path.join(root, "work"), features: new Set() };
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

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
    expect(await codexAdapter.findNativeSession(context)).toBe(context.taskId);
    fs.writeFileSync(path.join(dir, "rollout-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"), "{}");
    expect(await codexAdapter.findNativeSession(context)).toBeNull();
  });

  it("does not inherit OpenCode's host database or remote execution settings", () => {
    vi.stubEnv("OPENCODE_DB", "/unrelated/host.db"); vi.stubEnv("OPENCODE_SERVER_URL", "http://another-instance");
    const start = opencodeAdapter.start(context);
    expect(start.env.OPENCODE_DB).toBe(path.join(context.stateDirectory, "data", "opencode", "opencode.db"));
    expect(start.env.OPENCODE_SERVER_URL).toBeUndefined();
    expect(opencodeAdapter.resume({ ...context, nativeSessionId: "ses_test" }).args).toEqual(["--session", "ses_test"]);
  });

  it("discovers an OpenCode session in the project's cwd, not the TexLite server's cwd", async () => {
    fakeOpenCode([{ id: "ses_existingProjectConversation" }]);
    expect(process.cwd()).not.toBe(context.workingDirectory);
    expect(await opencodeAdapter.findNativeSession(context)).toBe("ses_existingProjectConversation");
  });

  it("deletes only the identified OpenCode session in the same project cwd and state", async () => {
    const database = fakeOpenCode([{ id: "ses_ownConversation" }]);
    await opencodeAdapter.cleanup({ ...context, nativeSessionId: "ses_ownConversation" });
    expect(JSON.parse(fs.readFileSync(database, "utf8"))).toEqual([]);
  });

  it("does not guess or delete another OpenCode conversation when discovery is ambiguous", async () => {
    const sessions = [{ id: "ses_first" }, { id: "ses_second" }];
    const database = fakeOpenCode(sessions);
    expect(await opencodeAdapter.findNativeSession(context)).toBeNull();
    await opencodeAdapter.cleanup({ ...context, nativeSessionId: "ses_first" });
    expect(JSON.parse(fs.readFileSync(database, "utf8"))).toEqual(sessions);
  });

  it("uses a deterministic Claude conversation ID and requires its actual transcript before restoring it", async () => {
    expect(claudeAdapter.start(context).args).toEqual(["--session-id", context.taskId]);
    expect(claudeAdapter.resume({ ...context, nativeSessionId: context.taskId }).args).toEqual(["--resume", context.taskId]);
    expect(await claudeAdapter.findNativeSession(context)).toBeNull();
    const dir = path.join(context.stateDirectory, "claude", "projects", "task-workspace"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${context.taskId}.jsonl`), "{}");
    expect(await claudeAdapter.findNativeSession(context)).toBe(context.taskId);
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
