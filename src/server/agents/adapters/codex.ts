import os from "node:os";
import path from "node:path";
import { agentLaunch, copyAgentSetting, executeAgentCommand, inspectTranscriptSession, transcriptIds } from "./common.js";
import type { AgentAdapter } from "./types.js";

export const codexAdapter: AgentAdapter = {
  id: "codex", label: "Codex", supportsResume: true,
  async discoverFeatures(executable) {
    const { stdout } = await executeAgentCommand(executable, ["--help"], { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true });
    const features = new Set(stdout.includes("--no-daemon") ? ["no-daemon"] : []);
    if (/^\s+delete\s/m.test(stdout)) {
      try {
        const help = await executeAgentCommand(executable, ["delete", "--help"], { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true });
        if (help.stdout.includes("--force")) features.add("delete-force");
      } catch { /* Optional deletion support must not discard other detected flags. */ }
    }
    return features;
  },
  async prepare(context) {
    const host = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const target = path.join(context.stateDirectory, "codex");
    await copyAgentSetting(path.join(host, "auth.json"), path.join(target, "auth.json"));
    await copyAgentSetting(path.join(host, "config.toml"), path.join(target, "config.toml"));
  },
  start(context) {
    return agentLaunch(context, ["--no-alt-screen", ...(context.features.has("no-daemon") ? ["--no-daemon"] : [])],
      { CODEX_HOME: path.join(context.stateDirectory, "codex") });
  },
  resume(context) {
    const launch = this.start(context);
    return { ...launch, args: ["resume", context.nativeSessionId, ...launch.args] };
  },
  async findNativeSession(context) {
    return inspectTranscriptSession(path.join(context.stateDirectory, "codex"), ["sessions", "archived_sessions"]);
  },
  async cleanup(context) {
    if (context.nativeSessionId && context.executable && context.features.has("delete-force")) {
      const ids = await transcriptIds(path.join(context.stateDirectory, "codex", "sessions"));
      // A retry after native deletion has already succeeded is harmless.
      if (ids.has(context.nativeSessionId)) await executeAgentCommand(context.executable, ["delete", "--force", context.nativeSessionId], {
        env: this.start(context).env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
    }
    // The caller then removes this task's owned home, including older native
    // formats/CLI versions without a delete command. Shared host state is untouched.
  }
};
