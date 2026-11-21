import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpError } from "../../http.js";
import { agentLaunch, executeAgentCommand } from "./common.js";
import type { AgentAdapter, AgentAdapterContext, NativeSessionInspection } from "./types.js";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const home = (context: AgentAdapterContext) => path.join(context.stateDirectory, "agy-home");
const appData = (context: AgentAdapterContext) => path.join(home(context), ".gemini", "antigravity-cli");
const binding = (context: AgentAdapterContext) => path.join(context.stateDirectory, "agy-conversation-id");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// Written into the task home, never into host or project customizations.
// Keep the first conversation even if the native terminal starts another one.
// Publishing a complete file by exclusive link makes a crash during the hook
// recoverable without exposing a partial ID to the next launch.
const sessionHook = `import fs from "node:fs";
import { randomUUID } from "node:crypto";
const { conversationId } = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof conversationId === "string" && ${uuid}.test(conversationId)) {
  const target = process.argv[2];
  const temporary = target + "." + randomUUID();
  fs.writeFileSync(temporary, conversationId, { flag: "wx", mode: 0o600 });
  try { fs.linkSync(temporary, target); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { fs.unlinkSync(temporary); }
}
process.stdout.write("{}");
`;

async function localStat(filename: string) {
  try { return await fs.promises.lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
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
  id: "agy", label: "Antigravity", supportsResume: true, isSupported: () => process.platform === "linux",
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
    }
    const config = path.join(home(context), ".gemini", "config");
    const hook = path.join(config, "texlite-session-start.mjs");
    await fs.promises.mkdir(config, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(appData(context), { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.join(home(context), "tmp"), { recursive: true, mode: 0o700 });
    await seedPreferences(appData(context));
    await fs.promises.writeFile(hook, sessionHook, { mode: 0o600 });
    await fs.promises.writeFile(path.join(config, "hooks.json"), JSON.stringify({
      "texlite-session": { SessionStart: [{ type: "command",
        command: [process.execPath, hook, binding(context)].map(shellQuote).join(" "), timeout: 5 }] }
    }), { mode: 0o600 });
  },
  start(context) {
    const directory = home(context);
    // Use native account sign-in even if the settings copied into the task
    // select a different provider. AGY talks to the service user's keyring.
    const launch = agentLaunch(context, ["--settings", '{"modelProvider":""}'], {
      HOME: directory, XDG_CONFIG_HOME: path.join(directory, ".config"), XDG_DATA_HOME: path.join(directory, ".local", "share"),
      XDG_STATE_HOME: path.join(directory, ".local", "state"), XDG_CACHE_HOME: path.join(directory, ".cache"),
      TMPDIR: path.join(directory, "tmp")
    });
    const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS;
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
      const record = await localStat(binding(context));
      if (record && (!record.isFile() || record.size !== 36)) return { status: "unknown" };
      const registered = record ? await fs.promises.readFile(binding(context), "utf8") : null;
      if (registered && !uuid.test(registered)) return { status: "unknown" };
      const id = context.nativeSessionId ?? registered;
      if (id && !uuid.test(id)) return { status: "unknown" };
      const conversations = path.join(directory, "conversations");
      const store = await localStat(conversations);
      if (store && !store.isDirectory()) return { status: "unknown" };
      const entries = store ? await fs.promises.readdir(conversations, { withFileTypes: true }) : [];
      if (id) {
        if (registered && context.nativeSessionId && registered !== context.nativeSessionId) return { status: "unknown" };
        const entry = entries.find((file) => file.name === `${id}.db`);
        if (!entry) return context.nativeSessionId ? { status: "empty" } : { status: "unknown" };
        return entry.isFile() ? { status: "found", id } : { status: "unknown" };
      }
      const databases = entries.filter((file) => file.name.endsWith(".db"));
      if (databases.length === 1 && databases[0].isFile() && uuid.test(databases[0].name.slice(0, -3))) {
        return { status: "found", id: databases[0].name.slice(0, -3) };
      }
      return { status: entries.length === 0 ? "empty" : "unknown" };
    } catch { return { status: "unknown" }; }
  },
  async cleanup() {
    // The service stops the process tree, then removes the entire task directory.
    // Native history, including forks, never lives in the host conversation store.
  }
};
