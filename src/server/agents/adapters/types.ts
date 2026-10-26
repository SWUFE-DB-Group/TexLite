import type { AgentId } from "../../../shared/agentProtocol.js";

export interface AgentAdapterContext {
  taskId: string;
  stateDirectory: string;
  workingDirectory: string;
  nativeSessionId: string | null;
  executable: string;
  features: ReadonlySet<string>;
}
export interface AgentLaunch { executable: string; args: string[]; env: Record<string, string> }

/** Empty verifies no conversation for this task, not missing storage or a failed lookup. */
export type NativeSessionInspection =
  | { status: "found"; id: string }
  | { status: "empty" }
  | { status: "unknown" };

/** Native operations. PTY lifecycle and task ownership live in the session service. */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly supportsResume: boolean;
  discoverFeatures(executable: string): Promise<ReadonlySet<string>>;
  prepare(context: AgentAdapterContext): Promise<void>;
  start(context: AgentAdapterContext): AgentLaunch;
  resume(context: AgentAdapterContext & { nativeSessionId: string }): AgentLaunch;
  findNativeSession(context: AgentAdapterContext): Promise<NativeSessionInspection>;
  /** Clean scoped native resources or throw; the caller then removes task-owned state. */
  cleanup(context: AgentAdapterContext): Promise<void>;
}
