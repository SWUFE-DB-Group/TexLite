import os from "node:os";
import path from "node:path";
import { agentLaunch, copyAgentSetting, executeAgentCommand, noAgentFeatures } from "./common.js";
import type { AgentAdapter } from "./types.js";

export const opencodeAdapter: AgentAdapter = {
  id: "opencode", label: "OpenCode", supportsResume: true,
  discoverFeatures: noAgentFeatures,
  async prepare(context) {
    const host = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode");
    await copyAgentSetting(path.join(host, "auth.json"), path.join(context.stateDirectory, "data", "opencode", "auth.json"));
  },
  start(context) {
    return agentLaunch(context, [], { OPENCODE_DB: path.join(context.stateDirectory, "data", "opencode", "opencode.db"), XDG_DATA_HOME: path.join(context.stateDirectory, "data"),
      XDG_STATE_HOME: path.join(context.stateDirectory, "runtime"), XDG_CACHE_HOME: path.join(context.stateDirectory, "cache") });
  },
  resume(context) { return { ...this.start(context), args: ["--session", context.nativeSessionId] }; },
  async findNativeSession(context) {
    try {
      const { stdout } = await executeAgentCommand(context.executable, ["session", "list", "--format", "json"], {
        // OpenCode resolves project sessions from cwd as well as its state DB.
        cwd: context.workingDirectory, env: this.start(context).env, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const records: unknown = JSON.parse(stdout);
      if (Array.isArray(records) && records.length === 1 && typeof records[0]?.id === "string" && /^ses_[\w-]+$/.test(records[0].id)) return records[0].id;
    } catch { /* Version-dependent management capability. */ }
    return null;
  },
  async cleanup(context) {
    if (context.nativeSessionId && context.executable && await this.findNativeSession(context) === context.nativeSessionId) await executeAgentCommand(context.executable, ["session", "delete", context.nativeSessionId], {
      cwd: context.workingDirectory, env: this.start(context).env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
  }
};
