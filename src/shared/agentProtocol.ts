/** Stable identities, rather than executable strings supplied by the browser. */
export const AGENT_IDS = ["codex", "opencode", "claude"] as const;
export type AgentId = typeof AGENT_IDS[number];
export const AGENT_LABELS: Record<AgentId, string> = { codex: "Codex", opencode: "OpenCode", claude: "Claude Code" };
export const AGENT_TASK_PAGE_SIZE = 50;
export const isAgentId = (value: unknown): value is AgentId => AGENT_IDS.includes(value as AgentId);

export interface AgentPolicy { allowed: AgentId[] }
export interface AgentInfo {
  id: AgentId;
  label: string;
  installed: boolean;
  enabled: boolean;
  version: string | null;
}
export type AgentExecutionState = "ready" | "starting" | "running" | "stopping" | "stopped" | "exited" | "interrupted" | "failed";
export interface AgentTask {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  userName: string;
  /** Current owner username, included in task listings; null for a deleted account. */
  userUsername?: string | null;
  agentId: AgentId;
  title: string;
  state: AgentExecutionState;
  cleanupState: "none" | "deleting" | "failed";
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  nativeSessionId: string | null;
  canResume: boolean;
}
export interface AgentCatalog { policy: AgentPolicy; agents: AgentInfo[]; ptyAvailable: boolean }
/** Counts always belong to the authenticated user, including administrators. */
export interface AgentAccess { visible: boolean; activeCount: number; /** An administrator allows at least one agent. */ enabled: boolean }
export interface AgentTaskPage { tasks: AgentTask[]; page: number; total: number; pageSize: number; activeTaskId?: string | null }
export type AgentClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "takeControl" };
export type AgentServerMessage =
  | { type: "size"; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "state"; task: AgentTask }
  | { type: "control"; writable: boolean }
  | { type: "error"; code: string };

const MAX_INPUT_CHARS = 64 * 1024;

/** Split large pastes into transport frames without splitting UTF-16 pairs. */
export function agentInputChunks(input: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < input.length;) {
    let end = Math.min(input.length, start + MAX_INPUT_CHARS);
    const last = input.charCodeAt(end - 1);
    if (end < input.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(input.slice(start, end)); start = end;
  }
  return chunks;
}

/** Keep terminal input and resize validation independent of the transport. */
export function parseAgentClientMessage(raw: string): AgentClientMessage | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "takeControl") return { type: "takeControl" };
  if (message.type === "input" && typeof message.data === "string" && message.data.length <= MAX_INPUT_CHARS) return { type: "input", data: message.data };
  if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)
    && Number(message.cols) >= 2 && Number(message.cols) <= 500 && Number(message.rows) >= 2 && Number(message.rows) <= 300) {
    return { type: "resize", cols: Number(message.cols), rows: Number(message.rows) };
  }
  return null;
}

/** A range of the current source. */
export interface AgentChangeRange { from: number; to: number }

/**
 * One reviewable change a coding agent made for the requesting user, mapped to
 * the current source. Nearby replacements from the same agent write are
 * grouped. `pieces` are the agent's surviving inserted text (later edits by
 * anyone trim them); `anchors` mark pure deletions. `before`/`after` are the
 * whole affected lines, for a diff; `before` is null when the change was
 * edited afterwards or is too large to reconstruct for preview.
 */
export interface AgentChange {
  id: string;
  /** Ids of the grouped replacements; review state is kept per id. */
  ids: string[];
  at: string;
  from: number;
  to: number;
  line: number;
  pieces: AgentChangeRange[];
  anchors: number[];
  before: string | null;
  after: string | null;
  /** Source offset where `after` starts (the start of the first affected line). */
  afterFrom: number;
}

export interface AgentChangeFile {
  path: string;
  /** SHA-256 of the source the ranges refer to. */
  sourceHash: string;
  changes: AgentChange[];
}
