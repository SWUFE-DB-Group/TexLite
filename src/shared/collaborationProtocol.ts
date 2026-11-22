/**
 * Wire-level constants and payload shapes shared by the browser and server.
 *
 * These values are part of the persisted collaboration contract. Do not
 * renumber a message or change existing fields in place: make an intentional
 * protocol-version migration instead. Trailing optional fields are compatible
 * when older readers ignore them and newer readers handle their absence.
 */
export const CollaborationMessageType = {
  Sync: 0,
  Awareness: 1,
  QueryAwareness: 3,
  Flush: 4,
  Protocol: 5,
  Maintenance: 6,
  Permission: 7,
  // A small, non-Yjs handshake message for ephemeral compile metadata.
  // Source text still uses the normal Yjs sync protocol.
  CompileStates: 8,
  // Ephemeral per-file formatter leases, intentionally outside Yjs state.
  // State packets may append the remaining lease duration in milliseconds.
  FormatLease: 9
} as const;

/** Increment only for an incompatible collaboration wire change. */
export const COLLABORATION_PROTOCOL_VERSION = 3;

const compileStatuses = ["queued", "running", "succeeded", "failed", "cleaned"] as const;
const cleanModes = ["cache", "artifacts"] as const;

export type CollaborationCompileStatus = (typeof compileStatuses)[number];
export type CollaborationCleanMode = (typeof cleanModes)[number];

export interface CollaborationSaveReceipt {
  revision: number;
  persistedAt: string;
  ok: boolean;
  failedPaths?: string[];
}

export interface SharedCompileState {
  mainFile: string;
  runId: string;
  status: CollaborationCompileStatus;
  cleanMode?: CollaborationCleanMode;
  /** The PDF was compiled from a consistent snapshot before newer edits arrived. */
  stale?: boolean;
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export type SharedCompileStates = Record<string, SharedCompileState>;

/** Ephemeral per-file formatter-lease state sent by the collaboration server. */
export interface FormatLeaseState {
  path: string;
  holderUserId: string;
  holderName: string;
  expiresAt: number;
}

export function isCollaborationCompileStatus(value: unknown): value is CollaborationCompileStatus {
  return typeof value === "string" && (compileStatuses as readonly string[]).includes(value);
}

export function isCollaborationCleanMode(value: unknown): value is CollaborationCleanMode {
  return typeof value === "string" && (cleanModes as readonly string[]).includes(value);
}
