import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpError } from "../../http.js";
import { agentLaunch, executeAgentCommand } from "./common.js";
import type { AgentAdapter, AgentAdapterContext, NativeSessionInspection } from "./types.js";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const zeroUuid = "00000000-0000-0000-0000-000000000000";
const isUuidPrefix = (value: string) => value.length > 0 && value.length < 36 && uuid.test(value + zeroUuid.slice(value.length));
const home = (context: AgentAdapterContext) => path.join(context.stateDirectory, "agy-home");
const appData = (context: AgentAdapterContext) => path.join(home(context), ".gemini", "antigravity-cli");
const binding = (context: AgentAdapterContext) => path.join(context.stateDirectory, "agy-conversation-id");
const bindingLock = (context: AgentAdapterContext) => `${binding(context)}.lock`;
const bindingAmbiguous = (context: AgentAdapterContext) => `${binding(context)}.ambiguous`;
const sessionSettings = (context: AgentAdapterContext) => path.join(context.stateDirectory, "agy-session-settings.json");
const sessionSettingsJson = '{"modelProvider":""}';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const windowsHookName = "texlite-session-start.cmd";
const isWindowsBatch = (executable: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);

function windowsBatchSettingsArg(context: AgentAdapterContext): string {
  const target = sessionSettings(context);
  if (!target.includes("%")) return target;
  const relative = /^[a-z]:[\\/]/i.test(target) && /^[a-z]:[\\/]/i.test(context.workingDirectory)
    ? path.win32.relative(context.workingDirectory, target)
    : path.relative(context.workingDirectory, target);
  return relative && !relative.includes("%") ? relative : target;
}

// Antigravity runs hook commands via `cmd /c` on Windows with the working
// directory set to the folder containing hooks.json. Keeping hooks.json on a
// quote-free relative command (`.\texlite-session-start.cmd`) avoids cmd.exe
// quote-stripping and Go exec.Command `\"` escaping issues, while forwarding
// Node via TEXLITE_NODE_EXEC preserves Unicode and special-character paths.
export function windowsAgyHookScript(nodeExecutable: string): string {
  if (/["\0\r\n]/.test(nodeExecutable)) throw new Error("Unsupported Windows executable path");
  const fallback = nodeExecutable.replaceAll("%", "%%");
  return [
    "@echo off",
    "setlocal disabledelayedexpansion",
    "if not defined TEXLITE_NODE_EXEC goto fallback",
    '"%TEXLITE_NODE_EXEC%" "%~dp0texlite-session-start.mjs"',
    "exit /b %ERRORLEVEL%",
    ":fallback",
    `"${fallback}" "%~dp0texlite-session-start.mjs"`,
    ""
  ].join("\r\n");
}

// Written into the task home, never into host or project customizations.
// Keep the first valid conversation even if the native terminal starts another
// one. Always publish a complete temporary file via hard link (or an atomic
// lock-directory + rename fallback where hard links are unavailable). If lock
// acquisition fails without an existing valid binding, mark the binding as
// ambiguous and exit non-zero so a later conversation cannot silently backfill.
const sessionHook = (target: string) => `import fs from "node:fs";
import { randomUUID } from "node:crypto";
const uuid = ${uuid};
const zeroUuid = ${JSON.stringify(zeroUuid)};
const isUuidPrefix = (value) => value.length > 0 && value.length < 36 && uuid.test(value + zeroUuid.slice(value.length));
const { conversationId } = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof conversationId === "string" && uuid.test(conversationId)) {
  const target = process.argv[2] ?? ${JSON.stringify(target)};
  const lock = target + ".lock";
  const ambiguous = target + ".ambiguous";
  const temporary = target + "." + randomUUID();
  const exists = (filename) => {
    try { fs.lstatSync(filename); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const bindingState = () => {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return "invalid";
      if (stat.size === 0 || stat.size > 36) return "incomplete";
      const contents = fs.readFileSync(target, "utf8");
      if (contents.length === 36 && uuid.test(contents)) return "valid";
      if (isUuidPrefix(contents) && !conversationId.toLowerCase().startsWith(contents.toLowerCase())) return "invalid";
      return "incomplete";
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  };
  const markAmbiguous = () => {
    try { fs.writeFileSync(ambiguous, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  };
  const publishWithLock = () => {
    const initial = bindingState();
    if (initial === "valid") return "exists";
    if (initial === "invalid") return "invalid";
    if (exists(ambiguous)) return "ambiguous";
    let locked = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; break; }
      catch (lockError) {
        if (lockError.code !== "EEXIST") throw lockError;
        const current = bindingState();
        if (current === "valid") return "exists";
        if (current === "invalid") return "invalid";
        if (exists(ambiguous)) return "ambiguous";
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    if (!locked) {
      if (bindingState() === "valid") return "exists";
      markAmbiguous();
      return "failed";
    }
    try {
      const current = bindingState();
      if (current === "valid") return "exists";
      if (current === "invalid") return "invalid";
      if (exists(ambiguous)) return "ambiguous";
      fs.renameSync(temporary, target);
      return "moved";
    } finally {
      try { fs.rmdirSync(lock); } catch {}
    }
  };
  fs.writeFileSync(temporary, conversationId, { flag: "wx", mode: 0o600 });
  let outcome = "linked";
  try {
    const state = bindingState();
    if (state === "valid") outcome = "exists";
    else if (state === "invalid") outcome = "invalid";
    else if (exists(ambiguous)) outcome = "ambiguous";
    else fs.linkSync(temporary, target);
  }
  catch (error) {
    if (error.code === "EEXIST") {
      const state = bindingState();
      outcome = state === "valid" ? "exists" : state === "invalid" ? "invalid" : publishWithLock();
    } else if (error.code === "ENOTSUP" || error.code === "ENOSYS" || error.code === "EXDEV") {
      outcome = publishWithLock();
    } else throw error;
  }
  finally {
    if (outcome !== "moved") { try { fs.unlinkSync(temporary); } catch {} }
  }
  if (outcome !== "linked" && outcome !== "moved" && outcome !== "exists") {
    throw new Error("Could not safely bind Antigravity conversation ID");
  }
}
process.stdout.write("{}");
`;

async function localStat(filename: string) {
  try { return await fs.promises.lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

type BindingState =
  | { status: "missing" }
  | { status: "valid"; id: string }
  | { status: "incomplete"; prefix: string | null }
  | { status: "invalid" };

async function inspectBinding(filename: string): Promise<BindingState> {
  const record = await localStat(filename);
  if (!record) return { status: "missing" };
  if (!record.isFile()) return { status: "invalid" };
  if (record.size === 0 || record.size > 36) return { status: "incomplete", prefix: null };
  const contents = await fs.promises.readFile(filename, "utf8");
  if (contents.length === 36 && uuid.test(contents)) return { status: "valid", id: contents };
  return { status: "incomplete", prefix: isUuidPrefix(contents) ? contents.toLowerCase() : null };
}

async function repairBinding(filename: string, id: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}`;
  await fs.promises.writeFile(temporary, id, { flag: "wx", mode: 0o600 });
  try { await fs.promises.rename(temporary, filename); }
  catch (error) {
    try { await fs.promises.unlink(temporary); } catch { /* Ignore temp cleanup errors. */ }
    throw error;
  }
}

async function clearStaleBindingLocks(context: AgentAdapterContext): Promise<void> {
  await fs.promises.rm(bindingAmbiguous(context), { force: true });
  await fs.promises.rm(bindingLock(context), { recursive: true, force: true });
}

function onboardingComplete(contents: Buffer): boolean {
  try {
    const state = JSON.parse(contents.toString("utf8"));
    return state?.onboardingComplete === true || state?.consumerOnboardingComplete === true
      || state?.enterpriseOnboardingComplete === true;
  } catch { return false; }
}

async function seedPreferences(targetDirectory: string): Promise<void> {
  const sourceDirectory = path.join(os.homedir(), ".gemini", "antigravity-cli");
  // Keep native preferences and first-run state without importing the rest of
  // the cache, credentials, or history. A task's own choices always win.
  for (const name of ["settings.json", "keybindings.json", "cache/nux_state.json", "cache/onboarding.json"]) {
    const target = path.join(targetDirectory, name);
    if (await localStat(target)) continue;
    let contents: Buffer;
    try { contents = await fs.promises.readFile(path.join(sourceDirectory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (name === "cache/onboarding.json" && !onboardingComplete(contents)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.promises.writeFile(target, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

export const agyAdapter: AgentAdapter = {
  id: "agy", label: "Antigravity", supportsResume: true,
  isSupported: () => process.platform === "linux" || process.platform === "darwin" || process.platform === "win32",
  async discoverFeatures(executable) {
    const { stdout, stderr } = await executeAgentCommand(executable, ["--help"], { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true });
    const help = stdout + stderr;
    return new Set(help.includes("--conversation") && help.includes("--settings") ? ["isolated-conversations"] : []);
  },
  async prepare(context) {
    if (!context.features.has("isolated-conversations")) throw httpError(409, "AGENT_UNAVAILABLE");
    if (context.nativeSessionId) {
      const saved = await this.findNativeSession(context);
      if (saved.status === "unknown") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
      if (saved.status !== "found") throw httpError(409, "AGENT_NO_CONTEXT");
      const bound = await inspectBinding(binding(context));
      if (bound.status === "missing" || bound.status === "incomplete") {
        await repairBinding(binding(context), context.nativeSessionId);
      }
      await clearStaleBindingLocks(context);
    } else if (await localStat(binding(context)) || await localStat(bindingLock(context)) || await localStat(bindingAmbiguous(context))) {
      // SessionStart may run before AGY persists a conversation, or an incomplete
      // binding / stale lock may remain after an interrupted hook. Only discard
      // them when the private conversation store is verified empty.
      if ((await this.findNativeSession(context)).status !== "empty") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
      await fs.promises.rm(binding(context), { force: true });
      await clearStaleBindingLocks(context);
    }
    const config = path.join(home(context), ".gemini", "config");
    const hook = path.join(config, "texlite-session-start.mjs");
    await fs.promises.mkdir(config, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(appData(context), { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.join(home(context), "tmp"), { recursive: true, mode: 0o700 });
    await seedPreferences(appData(context));
    await fs.promises.writeFile(hook, sessionHook(binding(context)), { mode: 0o600 });
    let command: string;
    if (process.platform === "win32") {
      await fs.promises.writeFile(sessionSettings(context), sessionSettingsJson, { mode: 0o600 });
      await fs.promises.writeFile(path.join(config, windowsHookName), windowsAgyHookScript(process.execPath), { mode: 0o600 });
      command = `.\\${windowsHookName}`;
    } else {
      command = [process.execPath, hook, binding(context)].map(shellQuote).join(" ");
    }
    await fs.promises.writeFile(path.join(config, "hooks.json"), JSON.stringify({
      "texlite-session": { SessionStart: [{ type: "command", command, timeout: 5 }] }
    }), { mode: 0o600 });
  },
  start(context) {
    const directory = home(context);
    const temp = path.join(directory, "tmp");
    const overrides: Record<string, string> = {
      HOME: directory, XDG_CONFIG_HOME: path.join(directory, ".config"), XDG_DATA_HOME: path.join(directory, ".local", "share"),
      XDG_STATE_HOME: path.join(directory, ".local", "state"), XDG_CACHE_HOME: path.join(directory, ".cache"),
      TMPDIR: temp
    };
    if (process.platform === "win32") {
      overrides.USERPROFILE = directory;
      overrides.TEMP = temp;
      overrides.TMP = temp;
      overrides.TEXLITE_NODE_EXEC = process.execPath;
    }
    // Use native account sign-in even if the settings copied into the task
    // select a different provider. AGY talks to the service user's keyring.
    // Windows .cmd/.bat shims pass a settings file path (using a relative path
    // when the data directory contains `%`) instead of inline JSON so
    // windowsAgentCommand keeps rejecting quotes and `%` in batch arguments.
    const settingsArg = isWindowsBatch(context.executable) ? windowsBatchSettingsArg(context) : sessionSettingsJson;
    const launch = agentLaunch(context, ["--settings", settingsArg], overrides);
    const sessionBus = process.platform === "linux" ? process.env.DBUS_SESSION_BUS_ADDRESS : undefined;
    if (sessionBus) launch.env.DBUS_SESSION_BUS_ADDRESS = sessionBus;
    delete launch.env.GEMINI_API_KEY;
    delete launch.env.GOOGLE_GEMINI_BASE_URL;
    return launch;
  },
  resume(context) {
    const launch = this.start(context);
    return { ...launch, args: [...launch.args, "--conversation", context.nativeSessionId] };
  },
  async findNativeSession(context): Promise<NativeSessionInspection> {
    try {
      const directory = appData(context);
      for (const part of [home(context), path.dirname(directory), directory]) {
        if (!(await localStat(part))?.isDirectory()) return { status: "unknown" };
      }
      const bound = await inspectBinding(binding(context));
      if (bound.status === "invalid") return { status: "unknown" };
      const registered = bound.status === "valid" ? bound.id : null;
      const id = context.nativeSessionId ?? registered;
      if (id && !uuid.test(id)) return { status: "unknown" };
      const conversations = path.join(directory, "conversations");
      const store = await localStat(conversations);
      if (store && !store.isDirectory()) return { status: "unknown" };
      const entries = store ? await fs.promises.readdir(conversations, { withFileTypes: true }) : [];
      if (id) {
        if (registered && context.nativeSessionId && registered !== context.nativeSessionId) return { status: "unknown" };
        if (bound.status === "incomplete" && bound.prefix && !id.toLowerCase().startsWith(bound.prefix)) return { status: "unknown" };
        const entry = entries.find((file) => file.name === `${id}.db`);
        if (!entry) return context.nativeSessionId || entries.length === 0 ? { status: "empty" } : { status: "unknown" };
        return entry.isFile() ? { status: "found", id } : { status: "unknown" };
      }
      if (await localStat(bindingAmbiguous(context))) {
        return { status: entries.length === 0 ? "empty" : "unknown" };
      }
      const databases = entries.filter((file) => file.name.endsWith(".db"));
      if (databases.length === 1 && databases[0].isFile() && uuid.test(databases[0].name.slice(0, -3))) {
        const candidate = databases[0].name.slice(0, -3);
        if (bound.status === "incomplete" && bound.prefix && !candidate.toLowerCase().startsWith(bound.prefix)) {
          return { status: "unknown" };
        }
        return { status: "found", id: candidate };
      }
      return { status: entries.length === 0 ? "empty" : "unknown" };
    } catch { return { status: "unknown" }; }
  },
  async cleanup() {
    // The service stops the process tree, then removes the entire task directory.
    // Native history, including forks, never lives in the host conversation store.
  }
};
