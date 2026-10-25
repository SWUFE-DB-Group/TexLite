import fs from "node:fs";
import path from "node:path";
import { AGENT_IDS, type AgentId, type AgentInfo, type AgentPolicy } from "../../shared/agentProtocol.js";
import { executeAgentCommand } from "./adapters/common.js";
import { codexAdapter } from "./adapters/codex.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { claudeAdapter } from "./adapters/claude.js";
import type { AgentAdapter, AgentAdapterContext } from "./adapters/types.js";

export interface DetectedAgent { executable: string | null; version: string | null; features: ReadonlySet<string> }
export function findAgentExecutable(name: string): string | null {
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

/** Registration/discovery only: native flags belong in individual adapters. */
export class AgentRegistry {
  private detected = new Map<AgentId, Promise<DetectedAgent>>();
  private adapters: Map<AgentId, AgentAdapter>;
  constructor(private readonly resolveExecutable = findAgentExecutable,
    adapters: readonly AgentAdapter[] = [codexAdapter, opencodeAdapter, claudeAdapter]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }
  adapter(id: AgentId): AgentAdapter { return this.adapters.get(id)!; }
  refresh(): void { this.detected.clear(); }
  detect(id: AgentId): Promise<DetectedAgent> {
    let result = this.detected.get(id);
    if (!result) { result = this.probe(id); this.detected.set(id, result); }
    return result;
  }
  async catalog(policy: AgentPolicy): Promise<AgentInfo[]> {
    return Promise.all(AGENT_IDS.map(async (id) => {
      const detected = await this.detect(id);
      const adapter = this.adapter(id);
      return { id, label: adapter.label, installed: detected.executable !== null,
        version: detected.version, enabled: policy.allowed.includes(id) };
    }));
  }
  async context(id: AgentId, taskId: string, root: string, nativeSessionId: string | null, workingDirectory: string): Promise<AgentAdapterContext> {
    const detected = await this.detect(id);
    return { taskId, stateDirectory: path.join(root, "state"), workingDirectory,
      nativeSessionId, executable: detected.executable ?? "", features: detected.features };
  }
  private async probe(id: AgentId): Promise<DetectedAgent> {
    const executable = this.resolveExecutable(id);
    if (!executable) return { executable: null, version: null, features: new Set() };
    let version: string | null = null;
    let features: ReadonlySet<string> = new Set();
    try {
      const { stdout } = await executeAgentCommand(executable, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
      version = stdout.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1] ?? null;
    } catch { /* Installed agents need not implement --version. */ }
    try { features = await this.adapter(id).discoverFeatures(executable); } catch { /* Optional capabilities. */ }
    return { executable, version, features };
  }
}
