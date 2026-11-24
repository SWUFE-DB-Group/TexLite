import { execFileSync, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agyAdapter, windowsAgyHookScript } from "../src/server/agents/adapters/agy.js";
import * as agentCommands from "../src/server/agents/adapters/common.js";
import type { AgentAdapterContext } from "../src/server/agents/adapters/types.js";
import { AgentRegistry } from "../src/server/agents/registry.js";
import { AgentService } from "../src/server/agents/sessions.js";
import { windowsAgentCommand, type AgentPty, type AgentPtyFactory } from "../src/server/agents/terminal.js";
import { agentTaskRoot } from "../src/server/agents/workspaces.js";
import { CollaborationService } from "../src/server/collaboration.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection, type UserRow } from "../src/server/db.js";
import { ProjectEditHistoryService } from "../src/server/editHistory.js";
import { createProjectFiles, sourceRoot } from "../src/server/files.js";
import { ProjectMutationCoordinator } from "../src/server/projectMutations.js";

let root: string;
let host: string;
let context: AgentAdapterContext;

function stubHostHome(directory: string) {
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
}

function runHookWithMockLinkFailure(hookScript: string, conversationId: string, errorCode: "ENOTSUP" | "EXDEV"): {
  status: number; stdout: string; stderr: string; linkCalled: boolean;
} {
  const preload = path.join(root, `fail-link-${randomUUID()}.mjs`);
  const marker = path.join(root, `link-called-${randomUUID()}`);
  fs.writeFileSync(preload, [
    'import fs from "node:fs";',
    `fs.linkSync = () => { fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(errorCode)}); const error = new Error(${JSON.stringify(errorCode)}); error.code = ${JSON.stringify(errorCode)}; throw error; };`
  ].join("\n"));
  try {
    const stdout = execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, hookScript], {
      input: JSON.stringify({ conversationId }), encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "", linkCalled: fs.existsSync(marker) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", linkCalled: fs.existsSync(marker) };
  }
}

function createFakeAgyCli(binDir: string, recordLog: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "fake-agy.mjs");
  fs.writeFileSync(script, `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("agy 1.5.11\\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stderr.write("Usage:\\n  --conversation UUID\\n  --settings JSON_OR_PATH\\n");
  process.exit(0);
}

const settingsIndex = args.indexOf("--settings");
if (settingsIndex === -1 || !args[settingsIndex + 1]) throw new Error("Missing --settings");
const rawSettings = args[settingsIndex + 1];
const parsedSettings = JSON.parse(rawSettings.startsWith("{") ? rawSettings : fs.readFileSync(rawSettings, "utf8"));
if (parsedSettings.modelProvider !== "") throw new Error("Expected modelProvider override");
if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_BASE_URL) throw new Error("Unexpected Gemini API env");

const homeDir = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
if (!homeDir) throw new Error("Missing home directory");
const configDir = path.join(homeDir, ".gemini", "config");
const hooks = JSON.parse(fs.readFileSync(path.join(configDir, "hooks.json"), "utf8"));
const hookCommand = hooks["texlite-session"].SessionStart[0].command;

const runHook = (conversationId) => {
  const input = JSON.stringify({ conversationId });
  const stdout = process.platform === "win32"
    ? execFileSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", hookCommand], { cwd: configDir, env: process.env, input, encoding: "utf8", windowsHide: true })
    : execFileSync("/bin/sh", ["-c", hookCommand], { cwd: configDir, env: process.env, input, encoding: "utf8" });
  if (stdout !== "{}") throw new Error("Unexpected hook stdout: " + JSON.stringify(stdout));
};

const conversations = path.join(homeDir, ".gemini", "antigravity-cli", "conversations");
fs.mkdirSync(conversations, { recursive: true });
const conversationIndex = args.indexOf("--conversation");
const resumedId = conversationIndex !== -1 ? args[conversationIndex + 1] : null;
const logFile = ${JSON.stringify(recordLog)};

if (resumedId) {
  if (!fs.existsSync(path.join(conversations, resumedId + ".db"))) throw new Error("Missing resumed DB: " + resumedId);
  fs.appendFileSync(logFile, JSON.stringify({ phase: "resume", resumedId, settingsArg: rawSettings }) + "\\n");
} else {
  const first = process.env.FAKE_AGY_FIRST_ID;
  const fork = process.env.FAKE_AGY_FORK_ID;
  for (const id of [first, fork]) {
    runHook(id);
    fs.writeFileSync(path.join(conversations, id + ".db"), "fake conversation " + id);
  }
  fs.appendFileSync(logFile, JSON.stringify({ phase: "start", first, fork, settingsArg: rawSettings }) + "\\n");
}
process.exit(0);
`);

  if (process.platform === "win32") {
    const cmd = path.join(binDir, "agy.cmd");
    const node = process.execPath.replaceAll("%", "%%");
    fs.writeFileSync(cmd, [
      "@echo off",
      "setlocal disabledelayedexpansion",
      `"${node}" "%~dp0fake-agy.mjs" %*`,
      ""
    ].join("\r\n"));
    return cmd;
  }
  const launcher = path.join(binDir, "agy");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\"'\"'")}' '${script.replaceAll("'", "'\"'\"'")}' "$@"\n`, { mode: 0o755 });
  return launcher;
}

function createSubprocessPtyFactory(): AgentPtyFactory {
  return (executable, args, options) => {
    let command = executable;
    let argv = args;
    let windowsVerbatimArguments = false;
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
      const wrapped = windowsAgentCommand(executable, args);
      command = wrapped.executable;
      argv = wrapped.argv;
      windowsVerbatimArguments = true;
    }
    const child = spawnChild(command, argv, {
      cwd: options.cwd,
      env: { ...options.env, FAKE_AGY_FIRST_ID: process.env.FAKE_AGY_FIRST_ID, FAKE_AGY_FORK_ID: process.env.FAKE_AGY_FORK_ID },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments,
      windowsHide: true
    });
    const dataListeners = new Set<(value: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    let exited: { exitCode: number } | undefined;
    const emit = (chunk: Buffer) => { const text = chunk.toString("utf8"); for (const listener of dataListeners) listener(text); };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.once("exit", (code) => {
      exited = { exitCode: code ?? 1 };
      for (const listener of [...exitListeners]) listener(exited);
    });
    const pty: AgentPty = {
      pid: child.pid ?? 1,
      stop: async () => { if (!exited) child.kill(); },
      write: (data) => { child.stdin?.write(data); },
      resize: () => undefined,
      onData: (callback) => { dataListeners.add(callback); return { dispose: () => { dataListeners.delete(callback); } }; },
      onExit: (callback) => {
        if (exited) queueMicrotask(() => callback(exited!));
        else exitListeners.add(callback);
        return { dispose: () => { exitListeners.delete(callback); } };
      }
    };
    return pty;
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agy-adapter-"));
  host = path.join(root, "host's home");
  fs.mkdirSync(host, { recursive: true });
  stubHostHome(host);
  context = {
    taskId: "11111111-2222-4333-8444-555555555555",
    nativeSessionId: null,
    executable: "agy",
    stateDirectory: path.join(root, "task", "state"),
    workingDirectory: path.join(root, "paper"),
    features: new Set(["isolated-conversations"])
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Antigravity (agy) adapter", () => {
  it("enables Antigravity on Linux, macOS, and Windows", () => {
    const originalPlatform = process.platform;
    try {
      for (const [platform, supported] of [["linux", true], ["darwin", true], ["win32", true], ["freebsd", false]] as const) {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        expect(agyAdapter.isSupported?.()).toBe(supported);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("detects Antigravity's session flags when help is printed to stderr", async () => {
    const execute = vi.spyOn(agentCommands, "executeAgentCommand").mockResolvedValue({ stdout: "", stderr: "Usage:\n  --conversation UUID\n  --settings JSON\n" });
    expect(await agyAdapter.discoverFeatures("agy")).toEqual(new Set(["isolated-conversations"]));
    execute.mockResolvedValueOnce({ stdout: "", stderr: "Usage:\n  --conversation UUID\n" });
    expect(await agyAdapter.discoverFeatures("agy")).toEqual(new Set());
  });

  it("uses a settings file for Windows batch shims while keeping inline JSON for native binaries", async () => {
    const originalPlatform = process.platform;
    const stateDirectory = path.join(root, "Research Team", "state");
    const batchCtx = { ...context, executable: "C:\\Tools\\Research Team\\agy.cmd", stateDirectory };
    const nativeCtx = { ...context, executable: "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe", stateDirectory };
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await agyAdapter.prepare(batchCtx);
      const settingsFile = path.join(stateDirectory, "agy-session-settings.json");
      expect(fs.readFileSync(settingsFile, "utf8")).toBe('{"modelProvider":""}');

      const batchLaunch = agyAdapter.start(batchCtx);
      expect(batchLaunch.args).toEqual(["--settings", settingsFile]);
      expect(() => windowsAgentCommand(batchLaunch.executable, batchLaunch.args)).not.toThrow();

      const batchResume = agyAdapter.resume({ ...batchCtx, nativeSessionId: context.taskId });
      expect(batchResume.args).toEqual(["--settings", settingsFile, "--conversation", context.taskId]);
      expect(() => windowsAgentCommand(batchResume.executable, batchResume.args)).not.toThrow();

      const nativeLaunch = agyAdapter.start(nativeCtx);
      expect(nativeLaunch.args).toEqual(["--settings", '{"modelProvider":""}']);

      // When the Windows data directory contains `%`, batch shims use a relative
      // settings path from workingDirectory so windowsAgentCommand stays strict.
      const percentDataDir = path.join(root, "Research 100%", "TexLite");
      const percentCtx: AgentAdapterContext = {
        ...batchCtx,
        workingDirectory: path.join(percentDataDir, "projects", "paper-1", "source"),
        stateDirectory: path.join(percentDataDir, "agent-tasks", context.taskId, "state")
      };
      await agyAdapter.prepare(percentCtx);
      const percentLaunch = agyAdapter.start(percentCtx);
      expect(percentLaunch.args[0]).toBe("--settings");
      expect(percentLaunch.args[1]).not.toContain("%");
      expect(path.resolve(percentCtx.workingDirectory, percentLaunch.args[1])).toBe(path.join(percentCtx.stateDirectory, "agy-session-settings.json"));
      expect(() => windowsAgentCommand(percentLaunch.executable, percentLaunch.args)).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("prepares Windows hooks and environment without nested shell quotes", async () => {
    const originalPlatform = process.platform;
    const stateDirectory = path.join(root, "O'Connor 中文 100% state");
    const ctx = { ...context, stateDirectory };
    vi.stubEnv("GEMINI_API_KEY", "unrelated-key");
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "http://localhost:1234");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/fake-bus");

    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await agyAdapter.prepare(ctx);
      const launch = agyAdapter.start(ctx);
      const taskHome = path.join(stateDirectory, "agy-home");
      const taskTemp = path.join(taskHome, "tmp");
      expect(launch.env).toMatchObject({
        USERPROFILE: taskHome, HOME: taskHome, TEMP: taskTemp, TMP: taskTemp, TMPDIR: taskTemp,
        TEXLITE_NODE_EXEC: process.execPath
      });
      expect(launch.env).not.toHaveProperty("GEMINI_API_KEY");
      expect(launch.env).not.toHaveProperty("GOOGLE_GEMINI_BASE_URL");
      expect(launch.env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");

      const configDir = path.join(taskHome, ".gemini", "config");
      const hooks = JSON.parse(fs.readFileSync(path.join(configDir, "hooks.json"), "utf8"));
      expect(hooks["texlite-session"].SessionStart[0].command).toBe(".\\texlite-session-start.cmd");
      const batch = fs.readFileSync(path.join(configDir, "texlite-session-start.cmd"), "utf8");
      expect(batch).toContain("\r\n");
      expect(batch).toContain("@echo off\r\nsetlocal disabledelayedexpansion\r\n");
      expect(batch).toContain('"%TEXLITE_NODE_EXEC%" "%~dp0texlite-session-start.mjs"');

      expect(windowsAgyHookScript("C:\\Program Files (x86)\\100% Node\\node.exe"))
        .toContain('"C:\\Program Files (x86)\\100%% Node\\node.exe" "%~dp0texlite-session-start.mjs"');
      expect(() => windowsAgyHookScript('C:\\bad"path\\node.exe')).toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }

    const hookScript = path.join(stateDirectory, "agy-home", ".gemini", "config", "texlite-session-start.mjs");
    const first = randomUUID(), second = randomUUID();
    expect(execFileSync(process.execPath, [hookScript], { input: JSON.stringify({ conversationId: first }), encoding: "utf8" })).toBe("{}");
    expect(execFileSync(process.execPath, [hookScript], { input: JSON.stringify({ conversationId: second }), encoding: "utf8" })).toBe("{}");
    expect(fs.readFileSync(path.join(stateDirectory, "agy-conversation-id"), "utf8")).toBe(first);
  });

  it.runIf(process.platform === "win32")("executes the generated .cmd hook through cmd.exe with and without TEXLITE_NODE_EXEC", async () => {
    const stateDirectory = path.join(root, "Windows Hook O'Connor state");
    const ctx = { ...context, stateDirectory };
    await agyAdapter.prepare(ctx);
    const launch = agyAdapter.start(ctx);
    const configDir = path.join(stateDirectory, "agy-home", ".gemini", "config");
    const hooks = JSON.parse(fs.readFileSync(path.join(configDir, "hooks.json"), "utf8"));
    const command = hooks["texlite-session"].SessionStart[0].command;
    const bindingFile = path.join(stateDirectory, "agy-conversation-id");

    const first = randomUUID();
    const out1 = execFileSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", command], {
      cwd: configDir, env: { ...process.env, ...launch.env }, input: JSON.stringify({ conversationId: first }),
      encoding: "utf8", windowsHide: true
    });
    expect(out1).toBe("{}");
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);

    // Exercise the :fallback branch when TEXLITE_NODE_EXEC is absent.
    fs.unlinkSync(bindingFile);
    const second = randomUUID();
    const envWithoutNodeExec = { ...process.env, ...launch.env };
    delete envWithoutNodeExec.TEXLITE_NODE_EXEC;
    const out2 = execFileSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", command], {
      cwd: configDir, env: envWithoutNodeExec, input: JSON.stringify({ conversationId: second }),
      encoding: "utf8", windowsHide: true
    });
    expect(out2).toBe("{}");
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(second);
  });

  it("publishes atomically without hard links, keeps the first valid ID, and repairs damaged bindings", async () => {
    await agyAdapter.prepare(context);
    const hookScript = path.join(context.stateDirectory, "agy-home", ".gemini", "config", "texlite-session-start.mjs");
    const bindingFile = path.join(context.stateDirectory, "agy-conversation-id");
    const lockDir = `${bindingFile}.lock`;
    const first = randomUUID(), second = randomUUID();

    // Hard links unsupported: first valid ID wins and leaves no lock or temp files.
    expect(runHookWithMockLinkFailure(hookScript, first, "ENOTSUP")).toMatchObject({ status: 0, stdout: "{}", linkCalled: true });
    expect(runHookWithMockLinkFailure(hookScript, second, "EXDEV")).toMatchObject({ status: 0, stdout: "{}" });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.readdirSync(context.stateDirectory).filter((name) => name.startsWith("agy-conversation-id."))).toEqual([]);

    // Damaged / truncated binding file is atomically replaced by the next hook.
    fs.writeFileSync(bindingFile, "partial-uuid");
    expect(runHookWithMockLinkFailure(hookScript, second, "ENOTSUP")).toMatchObject({ status: 0, stdout: "{}", linkCalled: true });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(second);

    // Also self-heals a 0-byte damaged binding on the normal EEXIST hard-link path.
    fs.writeFileSync(bindingFile, "");
    expect(execFileSync(process.execPath, [hookScript], { input: JSON.stringify({ conversationId: first }), encoding: "utf8" })).toBe("{}");
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);
  });

  it("fails explicitly on a fresh stale lock and prevents a later SessionStart from claiming the binding", async () => {
    await agyAdapter.prepare(context);
    const hookScript = path.join(context.stateDirectory, "agy-home", ".gemini", "config", "texlite-session-start.mjs");
    const bindingFile = path.join(context.stateDirectory, "agy-conversation-id");
    const lockDir = `${bindingFile}.lock`;
    const ambiguousFile = `${bindingFile}.ambiguous`;
    const store = path.join(context.stateDirectory, "agy-home", ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(store, { recursive: true });
    const first = randomUUID(), second = randomUUID();

    // Simulate a fresh lock left behind by an interrupted hook before any binding exists.
    fs.mkdirSync(lockDir);
    const firstAttempt = runHookWithMockLinkFailure(hookScript, first, "ENOTSUP");
    expect(firstAttempt.linkCalled).toBe(true);
    expect(firstAttempt.status).not.toBe(0);
    expect(firstAttempt.stdout).toBe("");
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(fs.existsSync(ambiguousFile)).toBe(true);

    // Even if the stale lock is later removed, a second SessionStart must never backfill `second`.
    fs.rmdirSync(lockDir);
    const secondAttempt = runHookWithMockLinkFailure(hookScript, second, "ENOTSUP");
    expect(secondAttempt.status).not.toBe(0);
    expect(secondAttempt.stdout).toBe("");
    expect(fs.existsSync(bindingFile)).toBe(false);

    // Even if only `second.db` was persisted (original never wrote a DB), `.ambiguous`
    // must keep inspection `unknown` instead of guessing that `second` is the original.
    fs.writeFileSync(path.join(store, `${second}.db`), "second conversation");
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(agyAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });

    // If the store is truly empty, `.ambiguous` can be cleared on the next fresh prepare().
    fs.unlinkSync(path.join(store, `${second}.db`));
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    await agyAdapter.prepare(context);
    expect(fs.existsSync(ambiguousFile)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);

    // If TexLite already persisted the trusted original ID, resume still finds it even with `.ambiguous`.
    fs.writeFileSync(ambiguousFile, "");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(store, `${first}.db`), "first conversation");
    expect(await agyAdapter.findNativeSession({ ...context, nativeSessionId: first })).toEqual({ status: "found", id: first });
    await agyAdapter.prepare({ ...context, nativeSessionId: first });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);
    expect(fs.existsSync(ambiguousFile)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);

    // Once a valid binding exists, a later SessionStart succeeds without overwriting it even if a lock exists.
    fs.mkdirSync(lockDir);
    expect(runHookWithMockLinkFailure(hookScript, second, "ENOTSUP")).toMatchObject({ status: 0, stdout: "{}" });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);
  });

  it("recovers safely from an incomplete binding when a unique database exists, without guessing on ambiguity", async () => {
    await agyAdapter.prepare(context);
    const bindingFile = path.join(context.stateDirectory, "agy-conversation-id");
    const store = path.join(context.stateDirectory, "agy-home", ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(store, { recursive: true });
    const first = randomUUID(), second = randomUUID();

    // 0-byte binding with empty store -> empty, and prepare unlinks the damaged file.
    fs.writeFileSync(bindingFile, "");
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "empty" });
    await agyAdapter.prepare(context);
    expect(fs.existsSync(bindingFile)).toBe(false);

    // Truncated binding with a conflicting UUID prefix -> refuses to adopt the unrelated DB or overwrite via hook.
    fs.writeFileSync(path.join(store, `${first}.db`), "native db");
    const conflictingPrefix = first.startsWith("aaaaaaaa-") ? "bbbbbbbb-" : "aaaaaaaa-";
    fs.writeFileSync(bindingFile, conflictingPrefix);
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(agyAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });
    expect(await agyAdapter.findNativeSession({ ...context, nativeSessionId: first })).toEqual({ status: "unknown" });
    const hookScript = path.join(context.stateDirectory, "agy-home", ".gemini", "config", "texlite-session-start.mjs");
    expect(runHookWithMockLinkFailure(hookScript, first, "ENOTSUP")).toMatchObject({ stdout: "" });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(conflictingPrefix);

    // Truncated binding with a matching UUID prefix -> recoverable as found, and resume repairs binding.
    fs.writeFileSync(bindingFile, first.slice(0, 10));
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "found", id: first });
    await agyAdapter.prepare({ ...context, nativeSessionId: first });
    expect(fs.readFileSync(bindingFile, "utf8")).toBe(first);

    // Truncated binding with two DBs -> ambiguous, refuses to guess.
    fs.writeFileSync(bindingFile, "");
    fs.writeFileSync(path.join(store, `${second}.db`), "forked db");
    expect(await agyAdapter.findNativeSession(context)).toEqual({ status: "unknown" });
    await expect(agyAdapter.prepare(context)).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHECK_FAILED" });

    // Non-file binding (directory) is never treated as recoverable or overwritten.
    fs.unlinkSync(bindingFile);
    fs.mkdirSync(bindingFile);
    expect(await agyAdapter.findNativeSession({ ...context, nativeSessionId: first })).toEqual({ status: "unknown" });
  });

  it("seeds only Antigravity preferences and preserves changes made in a task", async () => {
    const source = path.join(host, ".gemini", "antigravity-cli");
    fs.mkdirSync(path.join(source, "cache"), { recursive: true });
    fs.mkdirSync(path.join(source, "conversations"));
    const settings = { colorScheme: "dark", trustedWorkspaces: ["/already-trusted"] };
    const seeds = {
      "settings.json": JSON.stringify(settings),
      "keybindings.json": '{"cli.someAction":["ctrl+t"]}',
      "cache/nux_state.json": '{"dismissed":[51]}',
      "cache/onboarding.json": '{"onboardingComplete":false,"consumerOnboardingComplete":true}'
    };
    for (const [name, contents] of Object.entries(seeds)) fs.writeFileSync(path.join(source, name), contents);
    fs.writeFileSync(path.join(source, "cache", "last_conversations.json"), "{}");
    fs.writeFileSync(path.join(source, "conversations", "host.db"), "private conversation");
    fs.writeFileSync(path.join(source, "auth.json"), "private credentials");

    await agyAdapter.prepare(context);
    const target = path.join(agyAdapter.start(context).env.HOME, ".gemini", "antigravity-cli");
    for (const [name, contents] of Object.entries(seeds)) expect(fs.readFileSync(path.join(target, name), "utf8")).toBe(contents);
    for (const name of ["cache/last_conversations.json", "conversations", "auth.json"]) {
      expect(fs.existsSync(path.join(target, name))).toBe(false);
    }

    const taskSettings = { colorScheme: "light", trustedWorkspaces: [context.workingDirectory] };
    fs.writeFileSync(path.join(target, "settings.json"), JSON.stringify(taskSettings));
    fs.writeFileSync(path.join(target, "cache", "nux_state.json"), '{"dismissed":[51,52]}');
    fs.writeFileSync(path.join(target, "cache", "onboarding.json"), '{"onboardingComplete":false}');
    await agyAdapter.prepare(context);
    expect(JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8"))).toEqual(taskSettings);
    expect(fs.readFileSync(path.join(target, "cache", "nux_state.json"), "utf8")).toBe('{"dismissed":[51,52]}');
    expect(fs.readFileSync(path.join(target, "cache", "onboarding.json"), "utf8")).toBe('{"onboardingComplete":false}');
    expect(JSON.parse(fs.readFileSync(path.join(source, "settings.json"), "utf8"))).toEqual(settings);
  });

  it.each([
    ['{"onboardingComplete":true}', true],
    ['{"enterpriseOnboardingComplete":true}', true],
    ['{"onboardingComplete":"true","consumerOnboardingComplete":false}', false],
    ["{broken", false],
    [null, false]
  ] as const)("seeds only completed, valid Antigravity onboarding state (%s)", async (contents, seeded) => {
    const relative = path.join(".gemini", "antigravity-cli", "cache", "onboarding.json");
    if (contents !== null) {
      const source = path.join(host, relative);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
    }
    await agyAdapter.prepare(context);
    const target = path.join(agyAdapter.start(context).env.HOME, relative);
    expect(fs.existsSync(target)).toBe(seeded);
  });

  it("runs a real fake AGY CLI through hook execution, resumes the original conversation, and preserves host history on deletion", async () => {
    const dataDir = path.join(root, "TexLite 100% data");
    fs.mkdirSync(dataDir, { recursive: true });
    const configPath = path.join(dataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ storage: { dataDir }, updates: { enabled: false } }));
    const config = loadConfig(configPath);
    const db: DatabaseConnection = openDatabase(config);
    const collaboration = new CollaborationService(config, db, ({ projectId, edits }) => {
      new ProjectEditHistoryService(db).record(projectId, edits);
    });
    const coordinator = new ProjectMutationCoordinator(collaboration);
    const recordLog = path.join(root, "fake-agy.log");
    const binDir = path.join(root, "agy bin");
    const cliPath = createFakeAgyCli(binDir, recordLog);

    const hostData = path.join(host, ".gemini", "antigravity-cli");
    fs.mkdirSync(path.join(hostData, "conversations"), { recursive: true });
    const hostDb = path.join(hostData, "conversations", `${randomUUID()}.db`);
    fs.writeFileSync(hostDb, "host conversation history");
    const hostSettings = '{"colorScheme":"dark","modelProvider":"gemini"}';
    fs.writeFileSync(path.join(hostData, "settings.json"), hostSettings);

    const firstId = randomUUID();
    const forkId = randomUUID();
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("GEMINI_API_KEY", "host-api-key");
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "http://127.0.0.1:9999");
    vi.stubEnv("FAKE_AGY_FIRST_ID", firstId);
    vi.stubEnv("FAKE_AGY_FORK_ID", forkId);

    const ownerId = randomUUID();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, created_at) VALUES (?, 'owner', 'Owner', 'unused', 'admin', 1, ?)").run(ownerId, now);
    db.prepare("INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at) VALUES (?, ?, 'Paper', 'main.tex', 'pdflatex', ?, ?)").run(projectId, ownerId, now, now);
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(ownerId) as UserRow;
    createProjectFiles(config, projectId);
    const originalSource = fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8");

    const registry = new AgentRegistry();
    const service = new AgentService({
      config, db, collaboration, projectMutations: coordinator,
      recordHistory: vi.fn(),
      recordEdits: (id, edits) => new ProjectEditHistoryService(db).record(id, edits)
    }, {
      registry,
      loadPty: async () => createSubprocessPtyFactory()
    });

    try {
      const detected = await registry.detect("agy");
      if (process.platform === "win32") expect(detected.executable?.toLowerCase()).toBe(cliPath.toLowerCase());
      else expect(detected.executable).toBe(cliPath);
      expect(detected.version).toBe("1.5.11");
      expect(detected.features.has("isolated-conversations")).toBe(true);

      await service.setPolicy({ allowed: ["agy"] });
      const task = await service.create(projectId, owner, "agy", "Check abstract");
      await service.start(task.id, owner);
      await vi.waitFor(() => {
        expect(service.task(task.id, owner)).toMatchObject({ state: "exited", nativeSessionId: firstId, canResume: true });
      }, { timeout: 10_000 });

      await service.start(task.id, owner);
      await vi.waitFor(() => {
        const lines = fs.readFileSync(recordLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(lines).toHaveLength(2);
        if (process.platform === "win32") expect(lines[0].settingsArg).toMatch(/agy-session-settings\.json$/);
        expect(lines[1]).toMatchObject({ phase: "resume", resumedId: firstId });
        expect(service.task(task.id, owner)).toMatchObject({ state: "exited", nativeSessionId: firstId, canResume: true });
      }, { timeout: 10_000 });

      const taskRoot = agentTaskRoot(config, task.id);
      await service.remove(task.id, owner, true);
      expect(fs.existsSync(taskRoot)).toBe(false);
      expect(fs.readFileSync(hostDb, "utf8")).toBe("host conversation history");
      expect(fs.readFileSync(path.join(hostData, "settings.json"), "utf8")).toBe(hostSettings);
      expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe(originalSource);
    } finally {
      await service.dispose();
      collaboration.destroy();
      db.close();
    }
  }, 25_000);
});
