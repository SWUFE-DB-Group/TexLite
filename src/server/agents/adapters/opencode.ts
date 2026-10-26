import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { agentLaunch, copyAgentSetting, executeAgentCommand } from "./common.js";
import type { AgentAdapter, AgentAdapterContext, NativeSessionInspection } from "./types.js";
import { httpError } from "../../http.js";

const validSessionId = (id: unknown): id is string => typeof id === "string" && /^ses_[\w-]+$/.test(id);
const privateDatabase = (context: AgentAdapterContext) => path.join(context.stateDirectory, "data", "opencode", "opencode.db");
const bindingFile = (context: AgentAdapterContext) => path.join(context.stateDirectory, "opencode-session.json");
const taskSessionId = (context: AgentAdapterContext) => `ses_texlite${context.taskId.replaceAll("-", "")}`;

interface SharedSession { database: string; sessionId: string }
type NativeState = (SharedSession & { shared: true; registered: boolean })
  | { shared: false; registered: false; database: string; sessionId: string | null };

function sharedSession(context: AgentAdapterContext): SharedSession | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(bindingFile(context), "utf8"));
    if (!value || typeof value !== "object" || !("database" in value) || typeof value.database !== "string"
      || !path.isAbsolute(value.database) || !("sessionId" in value) || value.sessionId !== taskSessionId(context)) {
      throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
    }
    return { database: value.database, sessionId: value.sessionId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
  }
}

function nativeState(context: AgentAdapterContext): NativeState {
  const binding = sharedSession(context);
  if (binding) return { shared: true, registered: true, ...binding };
  // Keep existing private conversations where they were created. Empty private
  // stores can be upgraded in prepare(), but are never silently abandoned.
  if (!context.features.has("standalone") || fs.existsSync(privateDatabase(context))) {
    return { shared: false, registered: false, database: privateDatabase(context), sessionId: context.nativeSessionId };
  }
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return { shared: true, registered: false, database: process.env.OPENCODE_DB ?? path.join(data, "opencode", "opencode.db"), sessionId: taskSessionId(context) };
}

function inspectDatabase(filename: string, expectedId: string | null): NativeSessionInspection {
  const db = new Database(filename, { readonly: true });
  try {
    // V2 may retain the legacy table after migration. Its current projection is
    // authoritative: a deleted V2 session must not reappear from a legacy row.
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')
      ORDER BY CASE name WHEN 'session_v2' THEN 0 ELSE 1 END LIMIT 1`).get() as { name: "session_v2" | "session" } | undefined;
    if (!table) return { status: "unknown" };
    if (expectedId) {
      const found = db.prepare(`SELECT id FROM ${table.name} WHERE id = ?`).get(expectedId) as { id: string } | undefined;
      return found && validSessionId(found.id) ? { status: "found", id: found.id } : { status: "empty" };
    }
    const rows = db.prepare(`SELECT id FROM ${table.name} LIMIT 2`).all() as { id: unknown }[];
    if (rows.length === 0) return { status: "empty" };
    return rows.length === 1 && validSessionId(rows[0].id) ? { status: "found", id: rows[0].id } : { status: "unknown" };
  }
  finally { db.close(); }
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode", label: "OpenCode", supportsResume: true,
  async discoverFeatures(executable) {
    const { stdout } = await executeAgentCommand(executable, ["--help"], { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true });
    return new Set(/(?:^|\s)--standalone(?:\s|$)/m.test(stdout) ? ["standalone"] : []);
  },
  async prepare(context) {
    if (context.nativeSessionId) {
      // Newer CLIs can CREATE a conversation for an unknown --session ID.
      // Verify it first so a missing saved conversation is never replaced.
      const native = await this.findNativeSession(context);
      if (native.status === "unknown") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
      if (native.status !== "found" || native.id !== context.nativeSessionId) throw httpError(409, "AGENT_NO_CONTEXT");
    }
    const state = nativeState(context);
    if (state.shared && !context.features.has("standalone")) throw httpError(409, "AGENT_UNAVAILABLE");
    if (state.shared && state.registered) return;
    if (!state.shared && (context.nativeSessionId || !context.features.has("standalone"))) {
      const host = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode");
      await copyAgentSetting(path.join(host, "auth.json"), path.join(context.stateDirectory, "data", "opencode", "auth.json"));
      return;
    }
    if (!state.shared && (await this.findNativeSession(context)).status !== "empty") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");

    // Ask the native CLI, rather than guessing release-channel/platform paths.
    // Authentication stays entirely in the host database; no credentials are copied.
    const env = agentLaunch(context, []).env;
    if (process.env.OPENCODE_DB) env.OPENCODE_DB = process.env.OPENCODE_DB;
    let database: string;
    try {
      const { stdout } = await executeAgentCommand(context.executable, ["debug", "paths", "db"], {
        cwd: context.workingDirectory, env, timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
      database = stdout.trim();
    } catch { throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED"); }
    if (!path.isAbsolute(database) || /[\r\n\0]/.test(database)) throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
    const sessionId = taskSessionId(context);
    // Register ownership before launching, and never claim an existing native
    // conversation merely because it is the newest/only one in the database.
    if (fs.existsSync(database) && inspectDatabase(database, sessionId).status !== "empty") throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
    await fs.promises.mkdir(context.stateDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(bindingFile(context), JSON.stringify({ database, sessionId }), { flag: "wx", mode: 0o600 });
  },
  start(context) {
    const state = nativeState(context);
    const args = context.features.has("standalone") ? ["--standalone"] : [];
    return state.shared
      ? agentLaunch(context, [...args, "--session", state.sessionId], { OPENCODE_DB: state.database })
      : agentLaunch(context, args, { OPENCODE_DB: state.database, XDG_DATA_HOME: path.join(context.stateDirectory, "data"),
        XDG_STATE_HOME: path.join(context.stateDirectory, "runtime") });
  },
  resume(context) {
    const state = nativeState(context);
    if (state.shared && (!state.registered || state.sessionId !== context.nativeSessionId)) throw httpError(409, "AGENT_CONTEXT_CHECK_FAILED");
    const launch = this.start(context);
    return state.shared ? launch : { ...launch, args: [...launch.args, "--session", context.nativeSessionId] };
  },
  async findNativeSession(context) {
    try {
      // The list command may create a database itself. A missing task database
      // must never be mistaken for a verified empty one after state loss.
      const state = nativeState(context);
      if (state.shared && (!state.registered || (context.nativeSessionId && context.nativeSessionId !== state.sessionId))) return { status: "unknown" };
      if (!(await fs.promises.stat(state.database)).isFile()) return { status: "unknown" };
      // A shared database is queried by this task's registered ID only.
      try { return inspectDatabase(state.database, state.shared ? state.sessionId : context.nativeSessionId); }
      catch { /* Other native versions/formats can still be identified by the CLI. */ }
      if (state.shared || context.features.has("standalone")) return { status: "unknown" };
      const launch = this.start(context);
      const { stdout } = await executeAgentCommand(context.executable, ["session", "list", "--format", "json"], {
        // OpenCode resolves project sessions from cwd as well as its state DB.
        cwd: context.workingDirectory, env: launch.env, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const records: unknown = JSON.parse(stdout);
      if (Array.isArray(records) && records.length === 0) return { status: "empty" };
      if (Array.isArray(records) && records.length === 1 && validSessionId(records[0]?.id)) return { status: "found", id: records[0].id };
    } catch { /* Version-dependent management capability. */ }
    return { status: "unknown" };
  },
  async cleanup(context) {
    const state = nativeState(context);
    if (state.shared) {
      if (!state.registered || (context.nativeSessionId && context.nativeSessionId !== state.sessionId)) throw httpError(409, "AGENT_CLEANUP_FAILED");
      const native = await this.findNativeSession(context);
      if (native.status === "unknown") throw httpError(409, "AGENT_CLEANUP_FAILED");
      if (native.status === "empty") return; // An exact-ID deletion already succeeded.
      await executeAgentCommand(context.executable, ["session", "delete", state.sessionId, "--standalone"], {
        cwd: context.workingDirectory, env: this.start(context).env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
      if ((await this.findNativeSession(context)).status !== "empty") throw httpError(409, "AGENT_CLEANUP_FAILED");
      return;
    }
    // Private state can be removed with the task after its process tree stops.
    if (context.features.has("standalone")) return;
    const native = context.nativeSessionId && context.executable ? await this.findNativeSession(context) : null;
    if (native?.status === "found" && native.id === context.nativeSessionId) await executeAgentCommand(context.executable, ["session", "delete", native.id], {
      cwd: context.workingDirectory, env: this.start(context).env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
  }
};
