import type { AgentId } from "../../../shared/agentProtocol.js";

export type NativeSessionStorage = "private" | "shared";

export interface AgentAdapterContext {
  taskId: string;
  stateDirectory: string;
  workingDirectory: string;
  nativeSessionId: string | null;
  nativeSessionStorage?: NativeSessionStorage | null;
  previouslyStarted?: boolean;
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
  isSupported?(): boolean;
  discoverFeatures(executable: string): Promise<ReadonlySet<string>>;
  /** An adapter that can use multiple stores reports the one it prepared. */
  prepare(context: AgentAdapterContext): Promise<void | NativeSessionStorage>;
  start(context: AgentAdapterContext): AgentLaunch;
  resume(context: AgentAdapterContext & { nativeSessionId: string }): AgentLaunch;
  findNativeSession(context: AgentAdapterContext): Promise<NativeSessionInspection>;
  /** Clean scoped native resources or throw; the caller then removes task-owned state. */
  cleanup(context: AgentAdapterContext): Promise<void>;
}
