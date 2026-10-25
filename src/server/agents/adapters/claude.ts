import os from "node:os";
import path from "node:path";
import { agentLaunch, copyAgentSetting, noAgentFeatures, transcriptIds } from "./common.js";
import type { AgentAdapter } from "./types.js";

export const claudeAdapter: AgentAdapter = {
  id: "claude", label: "Claude Code", supportsResume: true,
  discoverFeatures: noAgentFeatures,
  async prepare(context) {
    const host = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const target = path.join(context.stateDirectory, "claude");
    await copyAgentSetting(path.join(host, ".credentials.json"), path.join(target, ".credentials.json"));
    await copyAgentSetting(path.join(host, "settings.json"), path.join(target, "settings.json"));
  },
  start(context) { return agentLaunch(context, ["--session-id", context.taskId], { CLAUDE_CONFIG_DIR: path.join(context.stateDirectory, "claude") }); },
  resume(context) { return { ...this.start(context), args: ["--resume", context.nativeSessionId] }; },
  async findNativeSession(context) {
    const ids = await transcriptIds(path.join(context.stateDirectory, "claude", "projects"));
    return ids.has(context.taskId) ? context.taskId : null;
  },
  async cleanup() { /* Native state is confined to the task-owned directory. */ }
};
