import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { agentLaunch, noAgentFeatures } from "./common.js";
import type { AgentAdapter, AgentAdapterContext, NativeSessionInspection } from "./types.js";
import { httpError } from "../../http.js";

interface HostSession {
  configDirectory: string;
  /** Leave CLAUDE_CONFIG_DIR unset for native ~/.claude.json discovery. */
  defaultHome: string | null;
  sessionId: string;
}

// Claude-specific settings supplement the shared proxy/certificate and
// ANTHROPIC_* environment. Do not inherit session identity, nested-launch
// markers or transcript controls: TexLite owns conversation continuation.
// https://code.claude.com/docs/en/env-vars
const hostEnvironmentNames = [
  /^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_(?:BEDROCK|VERTEX|FOUNDRY|ANTHROPIC_AWS)|SKIP_(?:BEDROCK|VERTEX|FOUNDRY|ANTHROPIC_AWS|MANTLE)_AUTH)$/,
  /^CLAUDE_CODE_(?:SUBAGENT_MODEL(?:_FORCE)?|EFFORT_LEVEL|AUTO_COMPACT_WINDOW|AUTOCOMPACT_PCT_OVERRIDE|MAX_OUTPUT_TOKENS|ALWAYS_ENABLE_EFFORT|DISABLE_(?:ADAPTIVE_THINKING|1M_CONTEXT|EXPERIMENTAL_BETAS|NONESSENTIAL_TRAFFIC))$/,
  /^CLAUDE_CODE_(?:API_KEY_HELPER_TTL_MS|AWS_CHAIN_RESOLVE_TIMEOUT_MS|CERT_STORE|CLIENT_(?:CERT|KEY|KEY_PASSPHRASE))$/,
  /^(?:AWS_|AZURE_|VERTEX_REGION_)/,
  /^(?:CLOUD_ML_REGION|GCLOUD_PROJECT|API_TIMEOUT_MS|MAX_THINKING_TOKENS)$/
];

function hostClaudeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && hostEnvironmentNames.some((pattern) => pattern.test(name))) env[name] = value;
  }
  return env;
}

const bindingFile = (context: AgentAdapterContext) => path.join(context.stateDirectory, "claude-session.json");

function binding(context: AgentAdapterContext): HostSession | null {
  try {
    const value = JSON.parse(fs.readFileSync(bindingFile(context), "utf8")) as HostSession;
    if (!value || value.sessionId !== context.taskId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.sessionId)
      || typeof value.configDirectory !== "string" || !path.isAbsolute(value.configDirectory)
      || !(value.defaultHome === null || typeof value.defaultHome === "string" && path.isAbsolute(value.defaultHome)
        && value.configDirectory === path.join(value.defaultHome, ".claude"))) throw new Error("Invalid Claude session binding");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
  }
}

function hostSession(context: AgentAdapterContext): HostSession {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  const home = os.homedir();
  return { configDirectory: configured ? path.resolve(configured) : path.join(home, ".claude"),
    defaultHome: configured ? null : home, sessionId: context.taskId };
}

/** Inspect filenames, not transcript contents or another session's metadata. */
async function projectDirectories(session: HostSession): Promise<string[]> {
  const root = path.join(session.configDirectory, "projects");
  try {
    const directories: string[] = [];
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      const directory = path.join(root, entry.name);
      if (entry.isDirectory()) directories.push(directory);
      else if (entry.isSymbolicLink()) {
        try { if ((await fs.promises.stat(directory)).isDirectory()) directories.push(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    return directories;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function inspectSession(session: HostSession): Promise<NativeSessionInspection> {
  for (const directory of await projectDirectories(session)) {
    try {
      const stat = await fs.promises.lstat(path.join(directory, `${session.sessionId}.jsonl`));
      if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unknown" };
      return { status: "found", id: session.sessionId };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { status: "empty" };
}

/** Never remove a project directory: it may contain unrelated host sessions. */
async function removeSession(session: HostSession): Promise<void> {
  for (const directory of await projectDirectories(session)) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const own = entry.name === session.sessionId || entry.name === `${session.sessionId}.jsonl`
        || entry.name.startsWith(`${session.sessionId}.orphaned-`) && entry.name.endsWith(".jsonl")
        || entry.name.startsWith(`${session.sessionId}.jsonl.superseded-`);
      if (own) await fs.promises.rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
  for (const name of ["file-history", "session-env", "tasks", "image-cache", "debug"]) {
    const directory = path.join(session.configDirectory, name);
    try {
      const stat = await fs.promises.stat(directory);
      if (!stat.isDirectory()) throw new Error("Invalid Claude session data directory");
      await fs.promises.rm(path.join(directory, name === "debug" ? `${session.sessionId}.txt` : session.sessionId),
        { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export const claudeAdapter: AgentAdapter = {
  id: "claude", label: "Claude Code", supportsResume: true,
  discoverFeatures: noAgentFeatures,
  async prepare(context) {
    const saved = binding(context);
    if (context.nativeSessionId) {
      if (!saved || context.nativeSessionId !== saved.sessionId) throw httpError(409, "AGENT_NO_CONTEXT");
      const native = await this.findNativeSession(context);
      if (native.status === "unknown") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
      if (native.status !== "found") throw httpError(409, "AGENT_NO_CONTEXT");
    }
    if (saved) return;
    const session = hostSession(context);
    // Persist ownership before the CLI can create a transcript. A pre-existing
    // host conversation with this ID must never be adopted or deleted.
    try {
      if ((await inspectSession(session)).status !== "empty") throw new Error("Claude session already exists");
    } catch { throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED"); }
    await fs.promises.mkdir(context.stateDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(bindingFile(context), JSON.stringify(session), { flag: "wx", mode: 0o600 });
  },
  start(context) {
    const session = binding(context) ?? hostSession(context);
    const env: Record<string, string> = session.defaultHome === null ? { CLAUDE_CONFIG_DIR: session.configDirectory }
      : { HOME: session.defaultHome, ...(process.platform === "win32" ? { USERPROFILE: session.defaultHome } : {}) };
    return agentLaunch(context, ["--session-id", session.sessionId], { ...hostClaudeEnvironment(), ...env });
  },
  resume(context) {
    const session = binding(context);
    if (!session || session.sessionId !== context.nativeSessionId) throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
    return { ...this.start(context), args: ["--resume", session.sessionId] };
  },
  async findNativeSession(context) {
    try {
      const session = binding(context);
      if (!session || context.nativeSessionId && context.nativeSessionId !== session.sessionId) return { status: "unknown" };
      return await inspectSession(session);
    } catch { return { status: "unknown" }; }
  },
  async cleanup(context) {
    const session = binding(context);
    // The service invokes native cleanup only for tasks that have launched.
    // A lost ownership record must not silently orphan a shared conversation.
    if (!session) throw httpError(409, "AGENT_CLEANUP_FAILED");
    if (context.nativeSessionId && context.nativeSessionId !== session.sessionId) throw httpError(409, "AGENT_CLEANUP_FAILED");
    await removeSession(session);
    if ((await this.findNativeSession(context)).status !== "empty") throw httpError(409, "AGENT_CLEANUP_FAILED");
  }
};
