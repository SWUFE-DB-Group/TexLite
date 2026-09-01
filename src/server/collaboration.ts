import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates
} from "y-protocols/awareness";
import type { Config } from "./config.js";
import type { DatabaseConnection, UserRow } from "./db.js";
import { listProjectFilesAsync, outputRoot, resolveSourcePath, safeRelativePath, sourceRoot, type FileEntry } from "./files.js";
import {
  accessibleProjectFromStatement,
  canEdit,
  prepareAccessibleProjectStatement,
  type AccessibleProject
} from "./projects.js";
import { reanchorFileComments } from "./anchors.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_FLUSH = 4;
const MESSAGE_PROTOCOL = 5;
const MESSAGE_MAINTENANCE = 6;
const MESSAGE_PERMISSION = 7;
// A small, non-Yjs handshake message used for ephemeral compile metadata.
// Source text still uses the normal Yjs sync protocol; this message prevents
// an old IndexedDB metadata entry from being treated as an active compile.
const MESSAGE_COMPILE_STATES = 8;
// Ephemeral, per-file formatter leases. These are deliberately kept out of
// the Yjs document and source persistence state.
const MESSAGE_FORMAT_LEASE = 9;
/**
 * Increment this when a wire-level collaboration change cannot be decoded by
 * an older browser. The epoch marker is rotated at the same time, which makes
 * already-open older pages discard their local draft and reload safely.
 */
export const COLLABORATION_PROTOCOL_VERSION = 3;
const VERSIONED_EPOCH_PREFIX = `${COLLABORATION_PROTOCOL_VERSION}:`;
const SOURCE_PREFIX = "source:";
const MAX_PROJECT_SESSIONS = 10;
const MAX_COLLABORATIVE_FILE_BYTES = 5 * 1024 * 1024;
const DISK_ORIGIN = Symbol("disk");
const HTTP_ORIGIN = Symbol("http");
const META_ORIGIN = Symbol("meta");
const SAVE_DELAY_MS = 750;
const STATE_SAVE_DELAY_MS = 750;
const ROOM_IDLE_MS = 30_000;
const FORMAT_LEASE_TTL_MS = 45_000;
const MAX_FORMAT_LEASE_WAITERS = MAX_PROJECT_SESSIONS * 2;
// Completion notifications are useful only to browsers that were already
// present when the operation finished. The database and retained manifests
// are the authority for a later workspace open.
const COMPLETED_COMPILE_STATE_TTL_MS = 60_000;
const EPHEMERAL_META_KEYS = ["compileStates", "filesEvent", "commentsRevision", "dictionaryRevision"] as const;
const COLORS = [
  ["#1677c8", "#1677c833"], ["#d65745", "#d6574533"], ["#16866a", "#16866a33"],
  ["#9a58b5", "#9a58b533"], ["#d27b18", "#d27b1833"], ["#3f7d20", "#3f7d2033"],
  ["#be3e7b", "#be3e7b33"], ["#4964c6", "#4964c633"], ["#8a6a14", "#8a6a1433"],
  ["#087f8c", "#087f8c33"]
] as const;

interface Connection {
  socket: WebSocket;
  user: UserRow;
  awarenessClientId: number | null;
  protocolVerified: boolean;
  protocolTimer: NodeJS.Timeout | null;
}

interface FormatLease {
  path: string;
  token: string;
  requestId: string;
  connection: Connection;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface FormatLeaseWaiter {
  path: string;
  requestId: string;
  connection: Connection;
}

interface Room {
  projectId: string;
  doc: Y.Doc;
  awareness: Awareness;
  meta: Y.Map<unknown>;
  connections: Set<Connection>;
  awarenessOwners: Map<number, Connection>;
  allowedPaths: Set<string>;
  persistedContent: Map<string, string>;
  dirtyPaths: Set<string>;
  textObservers: Map<string, (event: Y.YTextEvent, transaction: Y.Transaction) => void>;
  saveTimer: NodeJS.Timeout | null;
  stateSaveTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  lastModifiedUserId: string | null;
  epoch: string;
  persistedRevision: number;
  persistedAt: string;
  maintenanceReason: string | null;
  snapshotBarrierDepth: number;
  snapshotFlushPending: boolean;
  pendingFlushes: Array<{ connection: Connection; requestId: string }>;
  rejectedPaths: Set<string>;
  compileMetaValidationPending: boolean;
  formatLeases: Map<string, FormatLease>;
  formatLeaseWaiters: Map<string, FormatLeaseWaiter[]>;
}

interface RoomBootstrap {
  doc: Y.Doc;
  recoveredState: boolean;
  epoch: string;
  files: Array<{ path: string; content: string }>;
}

export interface CollaborationSaveReceipt {
  revision: number;
  persistedAt: string;
  ok: boolean;
  failedPaths?: string[];
}

export interface CollaborationPersistEvent {
  projectId: string;
  userId: string | null;
  paths: string[];
  durationMs: number;
}

export interface SharedCompileState {
  mainFile: string;
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cleaned";
  cleanMode?: "cache" | "artifacts";
  /** The PDF was compiled from a consistent snapshot before newer edits arrived. */
  stale?: boolean;
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export class CollaborationService {
  private readonly rooms = new Map<string, Room>();
  private readonly maintenanceProjects = new Map<string, string>();
  private readonly roomInitializations = new Map<string, Promise<Room>>();
  private readonly projectGenerations = new Map<string, number>();
  private readonly snapshotBarriers = new Map<string, number>();
  private readonly pendingConnections = new Map<string, number>();
  private closed = false;
  private readonly userByIdStatement;
  private readonly accessibleProjectStatement;

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly onPersist?: (event: CollaborationPersistEvent) => void
  ) {
    this.userByIdStatement = db.prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?");
    this.accessibleProjectStatement = prepareAccessibleProjectStatement(db);
  }

  private lookupProjectAccess(projectId: string, user: UserRow): AccessibleProject | null {
    return accessibleProjectFromStatement(this.accessibleProjectStatement, projectId, user);
  }

  async connect(socket: WebSocket, projectId: string, user: UserRow): Promise<void> {
    if (this.closed) {
      socket.close(1012, "Collaboration service is shutting down");
      return;
    }
    const project = this.lookupProjectAccess(projectId, user);
    if (!project) {
      socket.close(1008, "Project access denied");
      return;
    }
    const maintenanceReason = this.maintenanceProjects.get(projectId);
    if (maintenanceReason) {
      socket.close(1013, `Project is temporarily unavailable: ${maintenanceReason}`);
      return;
    }
    const existing = this.rooms.get(projectId);
    if (existing) {
      this.attachConnection(existing, socket, user);
      return;
    }
    const generation = this.projectGeneration(projectId);
    const pendingKey = this.pendingConnectionKey(projectId, generation);
    const pending = this.pendingConnections.get(pendingKey) ?? 0;
    if (pending >= MAX_PROJECT_SESSIONS) {
      socket.close(1013, "Project collaboration room is full");
      return;
    }
    this.pendingConnections.set(pendingKey, pending + 1);
    const initialization = this.roomInitializations.get(projectId) ?? this.initializeRoom(projectId, generation);
    try {
      const room = await initialization;
      const currentMaintenance = this.maintenanceProjects.get(projectId);
      if (currentMaintenance) {
        this.disposeRoom(room);
        socket.close(1013, `Project is temporarily unavailable: ${currentMaintenance}`);
      } else if (this.projectGeneration(projectId) !== generation) {
        socket.close(1013, "Collaboration state changed; retry required");
      } else if (socket.readyState === WebSocket.OPEN) {
        this.attachConnection(room, socket, user);
      } else {
        socket.close(1000, "Collaboration connection closed during initialization");
      }
    } catch {
      socket.close(1011, "Unable to initialize collaboration room");
    } finally {
      const count = (this.pendingConnections.get(pendingKey) ?? 1) - 1;
      if (count > 0) this.pendingConnections.set(pendingKey, count);
      else this.pendingConnections.delete(pendingKey);
    }
  }

  /** Wait for an in-flight cold-room load before reading or replacing sources. */
  async waitForReady(projectId: string): Promise<void> {
    const initialization = this.roomInitializations.get(projectId);
    if (!initialization) return;
    try { await initialization; } catch { /* Source files remain authoritative if recovery fails. */ }
  }

  flushProject(projectId: string): CollaborationSaveReceipt | null {
    const room = this.rooms.get(projectId);
    return room ? this.flushRoom(room) : null;
  }

  /**
   * Prevent collaboration autosaves from changing the source tree while a
   * compiler is copying an immutable snapshot. Yjs updates remain accepted in
   * memory and are flushed when the outermost barrier is released.
   */
  beginSnapshotBarrier(projectId: string): void {
    const depth = (this.snapshotBarriers.get(projectId) ?? 0) + 1;
    this.snapshotBarriers.set(projectId, depth);
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.snapshotBarrierDepth = depth;
    if (depth === 1 && room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
  }

  /**
   * Release a snapshot barrier and persist edits that arrived while the
   * source tree was protected. The returned receipt describes the post-barrier
   * disk revision, allowing callers to label a snapshot that predates edits
   * without treating that consistent snapshot as invalid.
   */
  endSnapshotBarrier(projectId: string): CollaborationSaveReceipt | null {
    const depth = this.snapshotBarriers.get(projectId) ?? 0;
    if (depth <= 0) return this.rooms.get(projectId) ? this.currentReceipt(this.rooms.get(projectId)!) : null;
    const nextDepth = depth - 1;
    if (nextDepth > 0) {
      this.snapshotBarriers.set(projectId, nextDepth);
      const nestedRoom = this.rooms.get(projectId);
      if (nestedRoom) nestedRoom.snapshotBarrierDepth = nextDepth;
      return nestedRoom ? this.currentReceipt(nestedRoom) : null;
    }
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return null;
    room.snapshotBarrierDepth = 0;
    const shouldFlush = room.snapshotFlushPending || room.dirtyPaths.size > 0;
    room.snapshotFlushPending = false;
    let receipt: CollaborationSaveReceipt;
    try {
      receipt = shouldFlush ? this.flushRoom(room) : this.currentReceipt(room);
    } catch (error) {
      // A state-file or source-file I/O failure must still complete any
      // browser flush requests waiting behind the barrier. The caller should
      // receive the original server error, while editors receive a durable
      // negative receipt instead of timing out.
      receipt = this.currentReceipt(room, false, [...room.dirtyPaths]);
      if (room.dirtyPaths.size > 0) this.scheduleSave(room);
      this.resolvePendingFlushes(room, receipt);
      this.scheduleRoomCleanup(room);
      throw error;
    }
    this.resolvePendingFlushes(room, receipt);
    this.scheduleRoomCleanup(room);
    return receipt;
  }

  stats(): { rooms: number; sessions: number; dirtyFiles: number; initializing: number } {
    let sessions = 0;
    let dirtyFiles = 0;
    for (const room of this.rooms.values()) {
      sessions += room.connections.size;
      dirtyFiles += room.dirtyPaths.size;
    }
    return { rooms: this.rooms.size, sessions, dirtyFiles, initializing: this.roomInitializations.size };
  }

  updateFile(projectId: string, filePathInput: string, content: string, userId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    if (!isCollaborativeTextFile(filePathInput)) {
      this.invalidateProject(projectId);
      return;
    }
    const filePath = safeRelativePath(filePathInput);
    room.allowedPaths.add(filePath);
    room.persistedContent.set(filePath, content);
    room.doc.transact(() => replaceText(this.trackedText(room, filePath), content), HTTP_ORIGIN);
    room.lastModifiedUserId = userId;
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "update", path: filePath });
  }

  /**
   * Mark a project as undergoing an exclusive source-tree operation. Existing
   * clients are told to stop editing and are disconnected when the operation
   * completes by endMaintenance(), which forces a fresh Yjs epoch.
   */
  beginMaintenance(projectId: string, reason: string): void {
    const normalizedReason = reason.slice(0, 200);
    const existingMaintenance = this.maintenanceProjects.get(projectId);
    if (existingMaintenance) throw new Error("Project is already undergoing a maintenance operation");
    const room = this.rooms.get(projectId);
    if (room?.maintenanceReason) throw new Error("Project is already undergoing a maintenance operation");
    this.maintenanceProjects.set(projectId, normalizedReason);
    if (!room) return;
    room.maintenanceReason = normalizedReason;
    const message = maintenanceMessage(room.maintenanceReason);
    for (const connection of room.connections) {
      send(connection.socket, message);
      // Close immediately after the notice. This prevents local edits from
      // accumulating while a source-tree replacement is in flight; the epoch
      // reset in endMaintenance will make the client reload authoritative data.
      connection.socket.close(4002, `Project maintenance: ${normalizedReason}`);
    }
  }

  endMaintenance(projectId: string): void {
    this.maintenanceProjects.delete(projectId);
    const room = this.rooms.get(projectId);
    if (room) room.maintenanceReason = null;
    // A project-level replacement cannot safely merge edits made while the
    // operation was in flight. Resetting the epoch makes every client reload
    // the authoritative source tree instead of replaying stale local drafts.
    this.resetProject(projectId);
  }

  notifyPermissionChanged(projectId: string, userId: string, permission: "read" | "edit" | "owner" | "revoked"): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    if (permission === "read" || permission === "revoked") {
      const connectionIds = new Set([...room.connections].filter((connection) => connection.user.id === userId));
      for (const connection of connectionIds) this.releaseFormatLeasesForConnection(room, connection);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERMISSION);
    encoding.writeVarString(encoder, userId);
    encoding.writeVarString(encoder, permission);
    const message = encoding.toUint8Array(encoder);
    for (const connection of room.connections) {
      if (connection.user.id === userId) send(connection.socket, message);
    }
  }

  disconnectUser(userId: string, reason = "User access revoked"): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERMISSION);
    encoding.writeVarString(encoder, userId);
    encoding.writeVarString(encoder, "revoked");
    const message = encoding.toUint8Array(encoder);

    for (const room of this.rooms.values()) {
      for (const connection of [...room.connections]) {
        if (connection.user.id === userId) {
          send(connection.socket, message);
          connection.socket.close(1008, reason);
          this.disconnect(room, connection);
        }
      }
    }
  }

  currentRevision(projectId: string): number | null {
    return this.rooms.get(projectId)?.persistedRevision ?? null;
  }

  /** Return the durable collaborative text currently held by a live room. */
  fileContent(projectId: string, filePathInput: string): string | null {
    const room = this.rooms.get(projectId);
    if (!room) return null;
    const filePath = safeRelativePath(filePathInput);
    if (!room.allowedPaths.has(filePath)) return null;
    return this.trackedText(room, filePath).toString();
  }

  /**
   * Returns the current source-tree epoch.  Exclusive filesystem operations
   * increment this value, allowing callers to cheaply distinguish a request
   * admitted before and after a project replacement without reading files.
   */
  currentGeneration(projectId: string): number {
    return this.projectGeneration(projectId);
  }

  hasPendingChanges(projectId: string): boolean {
    return Boolean(this.rooms.get(projectId)?.dirtyPaths.size);
  }

  isMaintaining(projectId: string): boolean {
    return this.maintenanceProjects.has(projectId);
  }

  isStable(projectId: string, revision: number | null): boolean {
    const room = this.rooms.get(projectId);
    return room
      ? room.maintenanceReason === null && room.persistedRevision === revision && room.dirtyPaths.size === 0
      : revision === null;
  }

  movePath(projectId: string, sourceInput: string, destinationInput: string, userId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    this.flushRoom(room);
    const source = safeRelativePath(sourceInput);
    const destination = safeRelativePath(destinationInput);
    const moved = [...room.allowedPaths].filter((filePath) => filePath === source || filePath.startsWith(`${source}/`));
    room.doc.transact(() => {
      for (const oldPath of moved) {
        const nextPath = oldPath === source ? destination : `${destination}${oldPath.slice(source.length)}`;
        const content = this.trackedText(room, oldPath).toString();
        replaceText(this.trackedText(room, nextPath), content);
        replaceText(this.trackedText(room, oldPath), "");
        room.allowedPaths.delete(oldPath);
        room.allowedPaths.add(nextPath);
        room.persistedContent.delete(oldPath);
        room.persistedContent.set(nextPath, content);
      }
    }, HTTP_ORIGIN);
    room.lastModifiedUserId = userId;
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "move", source, destination });
  }

  removePath(projectId: string, filePathInput: string): void {
    const room = this.rooms.get(projectId);
    if (!room) {
      this.invalidateProject(projectId);
      return;
    }
    const filePath = safeRelativePath(filePathInput);
    const removed = [...room.allowedPaths].filter((candidate) => candidate === filePath || candidate.startsWith(`${filePath}/`));
    room.doc.transact(() => {
      for (const candidate of removed) {
        replaceText(this.trackedText(room, candidate), "");
        room.allowedPaths.delete(candidate);
        room.persistedContent.delete(candidate);
        room.dirtyPaths.delete(candidate);
      }
    }, HTTP_ORIGIN);
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    this.bumpFiles(room, { kind: "delete", path: filePath });
  }

  invalidateSourceTree(projectId: string, filePathInput?: string): void {
    this.invalidateProject(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return;
    const filePath = filePathInput ? safeRelativePath(filePathInput) : "";
    this.bumpFiles(room, { kind: "update", path: filePath });
  }

  signalComments(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.doc.transact(() => room.meta.set("commentsRevision", randomUUID()), META_ORIGIN);
  }

  signalDictionary(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.doc.transact(() => room.meta.set("dictionaryRevision", randomUUID()), META_ORIGIN);
  }

  signalCompileState(projectId: string, state: SharedCompileState): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const current = room.meta.get("compileStates");
    const states = current && typeof current === "object" && !Array.isArray(current)
      ? { ...current as Record<string, SharedCompileState> }
      : {};
    states[state.mainFile] = state;
    const retained = Object.fromEntries(Object.entries(states)
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, 20));
    room.doc.transact(() => room.meta.set("compileStates", retained), META_ORIGIN);
  }

  /**
   * Keep collaboration compile metadata strictly ephemeral and database
   * backed. A browser can replay old IndexedDB updates after reconnecting;
   * completed states must therefore not override the retained-PDF lookup for
   * a newly opened workspace.
   */
  private sanitizeCompileStates(room: Room): void {
    const current = room.meta.get("compileStates");
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      if (current !== undefined) room.doc.transact(() => room.meta.delete("compileStates"), META_ORIGIN);
      return;
    }
    const retained: Record<string, SharedCompileState> = {};
    let changed = false;
    const checkedAt = Date.now();
    const findRun = this.db.prepare(`SELECT id, status, main_file FROM compile_runs
      WHERE id = ? AND project_id = ?`);
    const findLatestRun = this.db.prepare(`SELECT id, status FROM compile_runs
      WHERE project_id = ? AND main_file = ? ORDER BY created_at DESC LIMIT 1`);
    for (const [mainFile, value] of Object.entries(current as Record<string, unknown>)) {
      if (!isSharedCompileState(mainFile, value)) {
        changed = true;
        continue;
      }
      if (value.status === "queued" || value.status === "running") {
        const run = findRun.get(value.runId, room.projectId) as {
          id: string; status: string; main_file: string;
        } | undefined;
        if (!run || run.main_file !== mainFile || (run.status !== "queued" && run.status !== "running")) {
          changed = true;
          continue;
        }
      } else {
        const updatedAt = Date.parse(value.updatedAt);
        const fresh = Number.isFinite(updatedAt)
          && updatedAt <= checkedAt + COMPLETED_COMPILE_STATE_TTL_MS
          && checkedAt - updatedAt <= COMPLETED_COMPILE_STATE_TTL_MS;
        if (!fresh) {
          changed = true;
          continue;
        }
        if (value.status !== "cleaned") {
          const run = findRun.get(value.runId, room.projectId) as {
            id: string; status: string; main_file: string;
          } | undefined;
          const latest = findLatestRun.get(room.projectId, mainFile) as {
            id: string; status: string;
          } | undefined;
          if (!run || run.main_file !== mainFile || run.status !== value.status
            || !latest || latest.id !== value.runId || latest.status !== value.status) {
            changed = true;
            continue;
          }
        }
      }
      retained[mainFile] = value;
    }
    if (!changed && Object.keys(retained).length === Object.keys(current).length) return;
    room.doc.transact(() => {
      if (Object.keys(retained).length) room.meta.set("compileStates", retained);
      else room.meta.delete("compileStates");
    }, META_ORIGIN);
  }

  private sendCompileStates(room: Room, socket: WebSocket): void {
    const payload = this.compileStatesForClient(room);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_COMPILE_STATES);
    encoding.writeVarString(encoder, JSON.stringify(payload));
    send(socket, encoding.toUint8Array(encoder));
  }

  /**
   * Include active database runs even when no live room existed when the run
   * was queued. This keeps the handshake authoritative without making every
   * compile request persist a duplicate Yjs metadata update.
   */
  private compileStatesForClient(room: Room): Record<string, SharedCompileState> {
    const current = room.meta.get("compileStates");
    const states: Record<string, SharedCompileState> = isCompileStateMap(current) ? { ...current } : {};
    const activeRuns = this.db.prepare(`SELECT run.id, run.main_file, run.status, run.requested_by,
      run.created_at, user.username AS requested_by_username, user.display_name AS requested_by_name
      FROM compile_runs run LEFT JOIN users user ON user.id = run.requested_by
      WHERE run.project_id = ? AND run.status IN ('queued', 'running')
      ORDER BY CASE run.status WHEN 'running' THEN 0 ELSE 1 END, run.created_at DESC`).all(room.projectId) as Array<{
        id: string; main_file: string; status: "queued" | "running"; requested_by: string | null;
        created_at: string; requested_by_username: string | null; requested_by_name: string | null;
      }>;
    for (const run of activeRuns) {
      if (states[run.main_file]?.status === "running" && run.status === "queued") continue;
      states[run.main_file] = {
        mainFile: run.main_file,
        runId: run.id,
        status: run.status,
        requestedBy: {
          id: run.requested_by ?? "deleted-user",
          username: run.requested_by_username ?? "deleted-user",
          name: run.requested_by_name ?? "Deleted User"
        },
        updatedAt: run.created_at
      };
    }
    return Object.fromEntries(Object.entries(states)
      .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
      .slice(0, 20));
  }

  private clearRecoveredMetadata(room: Room): boolean {
    let changed = false;
    room.doc.transact(() => {
      for (const key of EPHEMERAL_META_KEYS) {
        if (!room.meta.has(key)) continue;
        room.meta.delete(key);
        changed = true;
      }
    }, META_ORIGIN);
    return changed;
  }

  closeProject(projectId: string): void {
    this.invalidateProject(projectId);
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (!room) return;
    for (const connection of room.connections) connection.socket.close(1008, "Project closed");
    this.destroyRoom(room);
  }

  resetProject(projectId: string): void {
    this.invalidateProject(projectId);
    this.snapshotBarriers.delete(projectId);
    const room = this.rooms.get(projectId);
    if (room) {
      for (const connection of room.connections) connection.socket.close(4001, "Project version changed; reload required");
      this.destroyRoom(room, false);
    }
    fs.rmSync(collaborationStatePath(this.config, projectId), { force: true });
    fs.rmSync(collaborationEpochPath(this.config, projectId), { force: true });
  }

  destroy(): void {
    this.closed = true;
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
    this.roomInitializations.clear();
    this.snapshotBarriers.clear();
    this.pendingConnections.clear();
  }

  private initializeRoom(projectId: string, generation: number): Promise<Room> {
    const existing = this.rooms.get(projectId);
    if (existing) return Promise.resolve(existing);
    const pending = this.roomInitializations.get(projectId);
    if (pending) return pending;
    const request = this.loadRoomBootstrap(projectId)
      .then((bootstrap) => {
        if (this.closed || this.projectGeneration(projectId) !== generation) {
          bootstrap.doc.destroy();
          throw new Error("Collaboration room initialization was invalidated");
        }
        return this.createRoom(projectId, bootstrap);
      })
      .finally(() => {
        if (this.roomInitializations.get(projectId) === request) this.roomInitializations.delete(projectId);
      });
    this.roomInitializations.set(projectId, request);
    return request;
  }

  /** Read the potentially large source tree without blocking the event loop. */
  private async loadRoomBootstrap(projectId: string): Promise<RoomBootstrap> {
    let doc = new Y.Doc();
    try {
      let recoveredState = false;
      let persistedState: Buffer | null = null;
      try {
        persistedState = await fs.promises.readFile(collaborationStatePath(this.config, projectId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (persistedState) {
        try {
          Y.applyUpdate(doc, persistedState, DISK_ORIGIN);
          recoveredState = true;
        } catch {
          // Malformed Yjs data is recoverable because source files remain the
          // authority. Start with a pristine document in case applyUpdate()
          // partially mutated the original before rejecting the payload.
          doc.destroy();
          doc = new Y.Doc();
        }
      }
      const epoch = await collaborationEpochAsync(this.config, projectId, recoveredState);
      const files = await this.readCollaborativeFiles(projectId);
      return { doc, recoveredState, epoch, files };
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  /**
   * Recheck file metadata after reading. This closes the small race where an
   * upload or autosave changes a file while the cold room is being hydrated.
   */
  private async readCollaborativeFiles(projectId: string): Promise<Array<{ path: string; content: string }>> {
    const assertSourceRoot = async (): Promise<void> => {
      const stats = await fs.promises.lstat(sourceRoot(this.config, projectId));
      if (stats.isSymbolicLink()) throw new Error("Collaborative source root cannot be a symbolic link");
      if (!stats.isDirectory()) throw new Error("Collaborative source root is not a directory");
    };
    let lastFailure = "Unable to obtain a stable collaborative source snapshot";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assertSourceRoot();
      const entries = (await listProjectFilesAsync(this.config, projectId))
        .filter((entry) => entry.type === "file" && isCollaborativeTextFile(entry.path)
          && (entry.size ?? 0) <= maxCollaborativeFileBytes(this.config));
      const files: Array<{ path: string; content: string }> = [];
      const failedPaths: string[] = [];
      for (let offset = 0; offset < entries.length; offset += 8) {
        const batch = entries.slice(offset, offset + 8);
        const loaded = await Promise.all(batch.map(async (entry) => {
          try {
            return { path: entry.path, content: await fs.promises.readFile(resolveSourcePath(this.config, projectId, entry.path), "utf8") };
          } catch {
            failedPaths.push(entry.path);
            return null;
          }
        }));
        files.push(...loaded.filter((file): file is { path: string; content: string } => file !== null));
      }
      const currentEntries = (await listProjectFilesAsync(this.config, projectId))
        .filter((entry) => entry.type === "file" && isCollaborativeTextFile(entry.path)
          && (entry.size ?? 0) <= maxCollaborativeFileBytes(this.config));
      await assertSourceRoot();
      const before = entries.map(collaborativeEntrySignature).sort().join("\n");
      const after = currentEntries.map(collaborativeEntrySignature).sort().join("\n");
      if (before === after && failedPaths.length === 0) return files;
      if (failedPaths.length) lastFailure = `Unable to read collaborative source files: ${failedPaths.join(", ")}`;
    }
    throw new Error(lastFailure);
  }

  private createRoom(projectId: string, bootstrap: RoomBootstrap): Room {
    const existing = this.rooms.get(projectId);
    if (existing) {
      bootstrap.doc.destroy();
      return existing;
    }
    const room: Room = {
      projectId,
      doc: bootstrap.doc,
      awareness: new Awareness(bootstrap.doc),
      meta: bootstrap.doc.getMap("texlite:meta"),
      connections: new Set(),
      awarenessOwners: new Map(),
      allowedPaths: new Set(),
      persistedContent: new Map(),
      dirtyPaths: new Set(),
      textObservers: new Map(),
      saveTimer: null,
      stateSaveTimer: null,
      cleanupTimer: null,
      lastModifiedUserId: null,
      epoch: bootstrap.epoch,
      persistedRevision: 0,
      persistedAt: new Date().toISOString(),
      maintenanceReason: this.maintenanceProjects.get(projectId) ?? null,
      snapshotBarrierDepth: this.snapshotBarriers.get(projectId) ?? 0,
      snapshotFlushPending: false,
      pendingFlushes: [],
      rejectedPaths: new Set(),
      compileMetaValidationPending: false,
      formatLeases: new Map(),
      formatLeaseWaiters: new Map()
    };
    room.awareness.setLocalState(null);
    // A recovered Yjs document may contain metadata from a process that no
    // longer exists. The database/source tree are authoritative after a
    // restart; clear the markers before any browser can sync them back.
    const recoveredMetadataChanged = bootstrap.recoveredState && this.clearRecoveredMetadata(room);
    this.sanitizeCompileStates(room);
    let recoveredDirty = false;
    const diskPaths = new Set<string>();
    room.doc.transact(() => {
      for (const file of bootstrap.files) {
        diskPaths.add(file.path);
        room.allowedPaths.add(file.path);
        room.persistedContent.set(file.path, file.content);
        const name = typeName(file.path);
        // Yjs decodes top-level shared types lazily; the source: namespace is
        // the stable identifier before getText() materializes the public type.
        const hasRecoveredText = bootstrap.recoveredState && room.doc.share.has(name);
        const text = this.trackedText(room, file.path);
        if (hasRecoveredText && text.toString() !== file.content) {
          room.dirtyPaths.add(file.path);
          recoveredDirty = true;
        } else {
          replaceText(text, file.content);
        }
      }
      for (const name of room.doc.share.keys()) {
        if (!name.startsWith(SOURCE_PREFIX)) continue;
        const filePath = name.slice(SOURCE_PREFIX.length);
        if (!diskPaths.has(filePath)) replaceText(room.doc.getText(name), "");
      }
    }, DISK_ORIGIN);
    const rejectedRecoveredPaths = this.rejectOversizedTexts(room);
    recoveredDirty = room.dirtyPaths.size > 0;
    room.meta.observe((_event, transaction) => {
      if (isConnectionOrigin(transaction.origin)) room.compileMetaValidationPending = true;
    });
    room.doc.on("update", (update, origin) => {
      this.broadcast(room, syncUpdateMessage(update), origin instanceof Object && "socket" in origin ? origin as Connection : null);
      // Compile state, file-list revisions, and comment/dictionary revision
      // markers are ephemeral metadata. They are reconstructed from SQLite
      // and the source tree after a restart, so do not encode and synchronously
      // rewrite the complete Yjs document for every metadata-only event.
      if (origin !== META_ORIGIN) this.scheduleStateSave(room);
      if (room.compileMetaValidationPending) {
        room.compileMetaValidationPending = false;
        this.sanitizeCompileStates(room);
      }
      if (origin !== DISK_ORIGIN && origin !== HTTP_ORIGIN && origin !== META_ORIGIN) {
        if (origin && typeof origin === "object" && "user" in origin) {
          room.lastModifiedUserId = (origin as Connection).user.id;
        }
        this.scheduleSave(room);
      }
    });
    room.awareness.on("update", ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[];
    }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (!changed.length) return;
      this.broadcast(room, awarenessMessage(encodeAwarenessUpdate(room.awareness, changed)), null);
      if (origin && typeof origin === "object" && "socket" in origin) {
        const connection = origin as Connection;
        for (const clientId of [...added, ...updated]) room.awarenessOwners.set(clientId, connection);
        for (const clientId of removed) {
          if (room.awarenessOwners.get(clientId) === connection) room.awarenessOwners.delete(clientId);
        }
      }
    });
    try {
      // Persist a corrected state even when an oversized recovered document was
      // reverted to the source file and no source write remains dirty.
      if (recoveredDirty || rejectedRecoveredPaths.length > 0) this.flushRoom(room);
      else if (recoveredMetadataChanged) this.scheduleStateSave(room);
    } catch (error) {
      this.disposeRoom(room);
      throw error;
    }
    this.rooms.set(projectId, room);
    // A fresh room has no unsaved Yjs state yet. Delaying state persistence
    // avoids a large synchronous write on the first connection; subsequent
    // updates schedule the normal atomic save.
    return room;
  }

  private attachConnection(room: Room, socket: WebSocket, user: UserRow): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!this.lookupProjectAccess(room.projectId, user)) {
      socket.close(1008, "Project access denied");
      return;
    }
    const maintenanceReason = this.maintenanceProjects.get(room.projectId);
    if (maintenanceReason) {
      socket.close(1013, `Project is temporarily unavailable: ${maintenanceReason}`);
      return;
    }
    if (room.connections.size >= MAX_PROJECT_SESSIONS) {
      socket.close(1013, "Project collaboration room is full");
      return;
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
    const connection: Connection = {
      socket, user, awarenessClientId: null, protocolVerified: false, protocolTimer: null
    };
    room.connections.add(connection);
    socket.binaryType = "arraybuffer";
    socket.on("message", (data) => {
      try {
        this.handleMessage(room, connection, rawData(data));
      } catch {
        socket.close(1003, "Invalid collaboration message");
      }
    });
    socket.on("close", () => this.disconnect(room, connection));
    socket.on("error", () => this.disconnect(room, connection));
    connection.protocolTimer = setTimeout(() => {
      if (!connection.protocolVerified) socket.close(4001, "Reload required");
    }, 10_000);
    send(socket, protocolMessage(room.epoch));
  }

  private trackedText(room: Room, filePath: string): Y.Text {
    const text = room.doc.getText(typeName(filePath));
    if (room.textObservers.has(filePath)) return text;
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
      if (transaction.origin === DISK_ORIGIN || transaction.origin === HTTP_ORIGIN || transaction.origin === META_ORIGIN) return;
      if (!room.allowedPaths.has(filePath)) {
        // A client can still have the old Y.Text bound briefly after another
        // session deletes or moves a file. Correct any late update immediately;
        // otherwise the editor would appear writable even though the content
        // can no longer be persisted to a source path.
        room.doc.transact(() => replaceText(text, ""), DISK_ORIGIN);
        return;
      }
      room.dirtyPaths.add(filePath);
    };
    text.observe(observer);
    room.textObservers.set(filePath, observer);
    return text;
  }

  private handleMessage(room: Room, connection: Connection, bytes: Uint8Array): void {
    const refreshedUser = this.userByIdStatement.get(connection.user.id);
    if (!refreshedUser || refreshedUser.disabled) {
      connection.socket.close(1008, "Project access revoked");
      this.disconnect(room, connection);
      return;
    }
    connection.user = refreshedUser;
    const current = this.lookupProjectAccess(room.projectId, refreshedUser);
    if (!current) {
      connection.socket.close(1008, "Project access revoked");
      return;
    }
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (room.maintenanceReason && messageType !== MESSAGE_PROTOCOL && messageType !== MESSAGE_QUERY_AWARENESS) {
      return;
    }
    if (messageType === MESSAGE_PROTOCOL) {
      const epoch = decoding.readVarString(decoder);
      const clientProtocolVersion = decoding.hasContent(decoder)
        ? decoding.readVarUint(decoder)
        : null;
      if (epoch !== room.epoch) {
        connection.socket.close(4001, "Collaboration state changed; reload required");
        return;
      }
      // A pre-versioning client cannot safely decode the durable FLUSH
      // response introduced in the previous release. Send a protocol marker
      // that deliberately differs from the room epoch; the existing client
      // handler treats it as a state change and reloads before it can edit.
      // New clients append their version to the otherwise-compatible handshake.
      if (clientProtocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
        send(connection.socket, protocolMessage(`${room.epoch}:reload`));
        connection.socket.close(4001, "Collaboration protocol upgrade required");
        return;
      }
      if (!connection.protocolVerified) {
        connection.protocolVerified = true;
        if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
        connection.protocolTimer = null;
        this.sanitizeCompileStates(room);
        this.sendSyncStep1(room, connection.socket);
        this.sendCompileStates(room, connection.socket);
        this.sendAwareness(room, connection.socket);
        this.sendFormatLeaseStates(room, connection);
      }
      return;
    }
    if (!connection.protocolVerified) return;
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, encoder, room.doc);
      } else if (syncType === syncProtocol.messageYjsSyncStep2) {
        // Read-only browsers may still carry a stale IndexedDB document. Do
        // not apply their source updates, but always send the authoritative
        // ephemeral compile state back to them.
        if (canEdit(current)) syncProtocol.readSyncStep2(decoder, room.doc, connection);
        this.sanitizeCompileStates(room);
        this.sendCompileStates(room, connection.socket);
      } else if (canEdit(current)) {
        if (syncType === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(decoder, room.doc, connection);
      }
      if (encoding.length(encoder) > 1) send(connection.socket, encoding.toUint8Array(encoder));
      return;
    }
    if (messageType === MESSAGE_QUERY_AWARENESS) {
      this.sendAwareness(room, connection.socket);
      return;
    }
    if (messageType === MESSAGE_FLUSH) {
      const requestId = decoding.readVarString(decoder).slice(0, 128);
      if (!canEdit(current)) return;
      if (room.snapshotBarrierDepth > 0 || (this.snapshotBarriers.get(room.projectId) ?? 0) > 0) {
        // Do not report the intentionally deferred flush as a failure. The
        // request is completed by endSnapshotBarrier() after the source tree
        // is released and the pending edits have been persisted.
        room.pendingFlushes.push({ connection, requestId });
        room.snapshotFlushPending = room.dirtyPaths.size > 0 || room.snapshotFlushPending;
        return;
      }
      let receipt: CollaborationSaveReceipt;
      try {
        receipt = this.flushRoom(room);
      } catch {
        receipt = this.currentReceipt(room, false, [...room.dirtyPaths]);
        if (room.dirtyPaths.size > 0) this.scheduleSave(room);
      }
      this.sendFlushReceipt(connection, requestId, receipt);
      return;
    }
    if (messageType === MESSAGE_FORMAT_LEASE) {
      this.handleFormatLeaseMessage(room, connection, decoder, current);
      return;
    }
    if (messageType !== MESSAGE_AWARENESS) return;
    const update = decoding.readVarUint8Array(decoder);
    const clientIds = awarenessClientIds(update);
    if (clientIds.length !== 1) return;
    const clientId = clientIds[0];
    const owner = room.awarenessOwners.get(clientId);
    if ((connection.awarenessClientId !== null && connection.awarenessClientId !== clientId) || (owner && owner !== connection)) return;
    connection.awarenessClientId = clientId;
    const [color, colorLight] = COLORS[Math.abs(clientId) % COLORS.length];
    const sanitized = modifyAwarenessUpdate(update, (state) => state === null ? null : {
      cursor: state && typeof state === "object" ? state.cursor ?? null : null,
      filePath: state && typeof state.filePath === "string" ? state.filePath.slice(0, 1024) : "",
      user: {
        id: connection.user.id,
        username: connection.user.username,
        name: connection.user.display_name,
        color,
        colorLight,
        permission: current.permission,
        sessionId: String(clientId)
      }
    });
    applyAwarenessUpdate(room.awareness, sanitized, connection);
  }

  private disconnect(room: Room, connection: Connection): void {
    if (!room.connections.delete(connection)) return;
    this.releaseFormatLeasesForConnection(room, connection);
    room.pendingFlushes = room.pendingFlushes.filter((pending) => pending.connection !== connection);
    if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
    connection.protocolTimer = null;
    if (connection.awarenessClientId !== null) {
      removeAwarenessStates(room.awareness, [connection.awarenessClientId], connection);
      room.awarenessOwners.delete(connection.awarenessClientId);
    }
    this.scheduleRoomCleanup(room);
  }

  private sendSyncStep1(room: Room, socket: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(socket, encoding.toUint8Array(encoder));
  }

  private sendAwareness(room: Room, socket: WebSocket): void {
    const clients = [...room.awareness.getStates().keys()];
    if (clients.length) send(socket, awarenessMessage(encodeAwarenessUpdate(room.awareness, clients)));
  }

  private broadcast(room: Room, message: Uint8Array, except: Connection | null): void {
    for (const connection of room.connections) if (connection !== except) send(connection.socket, message);
  }

  /**
   * Serialize access to one source file while a browser-side formatter is
   * calculating and applying its replacement. This is intentionally an
   * in-memory room primitive: the lease is advisory to the live collaboration
   * room, while the Yjs update + flush ordering remains the authoritative
   * durability boundary. A disconnected holder can never keep a lease alive.
   */
  private handleFormatLeaseMessage(
    room: Room,
    connection: Connection,
    decoder: decoding.Decoder,
    currentProject: AccessibleProject
  ): void {
    const operation = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 16) : "";
    const requestId = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 128) : "";
    const rawPath = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : "";
    const token = decoding.hasContent(decoder) ? decoding.readVarString(decoder).slice(0, 128) : "";
    let filePath: string;
    try {
      filePath = safeRelativePath(rawPath);
    } catch {
      this.sendFormatLeaseResponse(connection, "denied", requestId, rawPath, "invalid path");
      return;
    }
    if (!requestId || !isCollaborativeTextFile(filePath) || !room.allowedPaths.has(filePath)) {
      this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "file is not format-able");
      return;
    }
    if (!canEdit(currentProject)) {
      this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "write permission is required");
      return;
    }
    if (operation === "acquire") {
      const current = this.activeFormatLease(room, filePath);
      if (!current) {
        // Expiring a lease may have immediately granted the next queued
        // request. Do not overwrite that grant with this new request.
        if (room.formatLeases.has(filePath)) {
          const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
          if (waiters.length >= MAX_FORMAT_LEASE_WAITERS) {
            this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "too many formatters are waiting");
            return;
          }
          waiters.push({ path: filePath, requestId, connection });
          room.formatLeaseWaiters.set(filePath, waiters);
          return;
        }
        this.grantFormatLease(room, { path: filePath, requestId, connection });
        return;
      }
      if (current.connection === connection) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "this session already holds the lease");
        return;
      }
      const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
      if (waiters.some((waiter) => waiter.connection === connection && waiter.requestId === requestId)) return;
      if (waiters.length >= MAX_FORMAT_LEASE_WAITERS) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "too many formatters are waiting");
        return;
      }
      waiters.push({ path: filePath, requestId, connection });
      room.formatLeaseWaiters.set(filePath, waiters);
      return;
    }
    if (operation === "renew") {
      const lease = this.activeFormatLease(room, filePath);
      if (!lease || lease.connection !== connection || lease.token !== token) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "format lease is no longer valid");
        return;
      }
      this.extendFormatLease(room, lease);
      this.sendFormatLeaseResponse(connection, "renewed", requestId, filePath, "", lease.expiresAt, lease.token);
      this.broadcastFormatLeaseState(room, lease);
      return;
    }
    if (operation === "release") {
      const lease = this.activeFormatLease(room, filePath);
      if (!lease || lease.connection !== connection || lease.token !== token) {
        this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "format lease is no longer valid");
        return;
      }
      this.releaseFormatLease(room, lease);
      this.sendFormatLeaseResponse(connection, "released", requestId, filePath);
      return;
    }
    if (operation === "cancel") {
      const waiters = room.formatLeaseWaiters.get(filePath) ?? [];
      const remaining = waiters.filter((waiter) => !(waiter.connection === connection && waiter.requestId === requestId));
      if (remaining.length) room.formatLeaseWaiters.set(filePath, remaining);
      else room.formatLeaseWaiters.delete(filePath);
      // A timeout may race with the server granting the request. In that
      // window the request is no longer in the waiter queue, so also revoke a
      // matching active lease instead of leaving it until the TTL expires.
      const active = this.activeFormatLease(room, filePath);
      if (active?.connection === connection && active.requestId === requestId) {
        this.releaseFormatLease(room, active);
      }
      this.sendFormatLeaseResponse(connection, "released", requestId, filePath);
      return;
    }
    this.sendFormatLeaseResponse(connection, "denied", requestId, filePath, "unknown format lease operation");
  }

  private activeFormatLease(room: Room, filePath: string): FormatLease | null {
    const lease = room.formatLeases.get(filePath);
    if (!lease) return null;
    if (lease.expiresAt > Date.now()) return lease;
    this.releaseFormatLease(room, lease);
    return null;
  }

  private grantFormatLease(room: Room, waiter: FormatLeaseWaiter): boolean {
    if (!room.connections.has(waiter.connection) || waiter.connection.socket.readyState !== WebSocket.OPEN) return false;
    const lease: FormatLease = {
      path: waiter.path,
      token: randomUUID(),
      requestId: waiter.requestId,
      connection: waiter.connection,
      expiresAt: Date.now() + FORMAT_LEASE_TTL_MS,
      timer: setTimeout(() => this.expireFormatLease(room, waiter.path), FORMAT_LEASE_TTL_MS + 25)
    };
    room.formatLeases.set(waiter.path, lease);
    this.sendFormatLeaseResponse(waiter.connection, "grant", waiter.requestId, lease.path, "", lease.expiresAt, lease.token);
    this.broadcastFormatLeaseState(room, lease);
    return true;
  }

  private extendFormatLease(room: Room, lease: FormatLease): void {
    clearTimeout(lease.timer);
    lease.expiresAt = Date.now() + FORMAT_LEASE_TTL_MS;
    lease.timer = setTimeout(() => this.expireFormatLease(room, lease.path), FORMAT_LEASE_TTL_MS + 25);
  }

  private expireFormatLease(room: Room, filePath: string): void {
    const lease = room.formatLeases.get(filePath);
    if (!lease) return;
    if (lease.expiresAt > Date.now()) {
      lease.timer = setTimeout(() => this.expireFormatLease(room, filePath), lease.expiresAt - Date.now() + 25);
      return;
    }
    this.releaseFormatLease(room, lease);
  }

  private releaseFormatLease(room: Room, lease: FormatLease): void {
    if (room.formatLeases.get(lease.path) !== lease) return;
    clearTimeout(lease.timer);
    room.formatLeases.delete(lease.path);
    this.broadcastFormatLeaseState(room, null, lease.path);
    this.grantNextFormatLease(room, lease.path);
  }

  private grantNextFormatLease(room: Room, filePath: string): void {
    if (room.formatLeases.has(filePath)) return;
    const waiters = room.formatLeaseWaiters.get(filePath);
    if (!waiters?.length) {
      room.formatLeaseWaiters.delete(filePath);
      return;
    }
    while (waiters.length) {
      const waiter = waiters.shift()!;
      if (!room.connections.has(waiter.connection) || waiter.connection.socket.readyState !== WebSocket.OPEN) continue;
      // Keep all later requests in the room queue while the first valid
      // waiter owns the lease. The previous implementation deleted the map
      // before granting and silently dropped every later waiter.
      if (waiters.length) room.formatLeaseWaiters.set(filePath, waiters);
      else room.formatLeaseWaiters.delete(filePath);
      if (this.grantFormatLease(room, waiter)) return;
    }
    room.formatLeaseWaiters.delete(filePath);
  }

  private releaseFormatLeasesForConnection(room: Room, connection: Connection): void {
    const pathsToGrant = new Set<string>();
    for (const [filePath, lease] of room.formatLeases) {
      if (lease.connection !== connection) continue;
      pathsToGrant.add(filePath);
      clearTimeout(lease.timer);
      room.formatLeases.delete(filePath);
      this.broadcastFormatLeaseState(room, null, filePath);
    }
    for (const [filePath, waiters] of room.formatLeaseWaiters) {
      const remaining = waiters.filter((waiter) => waiter.connection !== connection);
      if (remaining.length) room.formatLeaseWaiters.set(filePath, remaining);
      else room.formatLeaseWaiters.delete(filePath);
    }
    for (const filePath of pathsToGrant) this.grantNextFormatLease(room, filePath);
  }

  private sendFormatLeaseResponse(
    connection: Connection,
    status: "grant" | "renewed" | "released" | "denied",
    requestId: string,
    filePath: string,
    reason = "",
    expiresAt = 0,
    token = ""
  ): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FORMAT_LEASE);
    encoding.writeVarString(encoder, status);
    encoding.writeVarString(encoder, requestId);
    encoding.writeVarString(encoder, filePath);
    encoding.writeVarString(encoder, token);
    encoding.writeVarString(encoder, expiresAt > 0 ? String(expiresAt) : "");
    encoding.writeVarString(encoder, reason.slice(0, 256));
    send(connection.socket, encoding.toUint8Array(encoder));
  }

  private broadcastFormatLeaseState(room: Room, lease: FormatLease | null, filePath = lease?.path ?? ""): void {
    this.broadcast(room, formatLeaseStateMessage(lease, filePath), null);
  }

  private sendFormatLeaseStates(room: Room, connection: Connection): void {
    for (const lease of room.formatLeases.values()) {
      if (lease.expiresAt > Date.now()) send(connection.socket, formatLeaseStateMessage(lease, lease.path));
    }
  }

  private scheduleRoomCleanup(room: Room): void {
    if (room.connections.size === 0 && !room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => this.destroyRoom(room), ROOM_IDLE_MS);
    }
  }

  private scheduleSave(room: Room): void {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      try { this.flushRoom(room); }
      catch { room.saveTimer = null; /* The Yjs state remains durable and the next client flush retries. */ }
    }, SAVE_DELAY_MS);
  }

  private scheduleStateSave(room: Room): void {
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    room.stateSaveTimer = setTimeout(() => {
      try { this.persistRoomState(room); }
      catch { room.stateSaveTimer = null; /* A later source flush will retry state persistence. */ }
    }, STATE_SAVE_DELAY_MS);
  }

  private persistRoomState(room: Room): void {
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    room.stateSaveTimer = null;
    this.rejectOversizedTexts(room);
    const target = collaborationStatePath(this.config, room.projectId);
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, Y.encodeStateAsUpdate(room.doc), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private flushRoom(room: Room): CollaborationSaveReceipt {
    if (room.snapshotBarrierDepth > 0 || (this.snapshotBarriers.get(room.projectId) ?? 0) > 0) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.saveTimer = null;
      if (room.dirtyPaths.size > 0) room.snapshotFlushPending = true;
      return this.currentReceipt(room, room.dirtyPaths.size === 0, []);
    }
    const startedAt = performance.now();
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    this.rejectOversizedTexts(room);
    this.persistRoomState(room);
    let changed = false;
    const changedPaths: string[] = [];
    const failedPaths: string[] = [...room.rejectedPaths];
    const dirtyPaths = [...room.dirtyPaths];
    for (const filePath of dirtyPaths) {
      if (!room.allowedPaths.has(filePath)) {
        room.dirtyPaths.delete(filePath);
        continue;
      }
      const next = this.trackedText(room, filePath).toString();
      const previous = room.persistedContent.get(filePath) ?? "";
      if (next === previous) {
        room.dirtyPaths.delete(filePath);
        continue;
      }
      if (Buffer.byteLength(next, "utf8") > maxCollaborativeFileBytes(this.config)) {
        failedPaths.push(filePath);
        continue;
      }
      const absolute = resolveSourcePath(this.config, room.projectId, filePath);
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      } catch {
        failedPaths.push(filePath);
        continue;
      }
      const temporary = `${absolute}.collaboration-${process.pid}-${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, absolute);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        failedPaths.push(filePath);
        continue;
      }
      room.persistedContent.set(filePath, next);
      room.dirtyPaths.delete(filePath);
      try { reanchorFileComments(this.db, room.projectId, filePath, previous, next); }
      catch { /* Source durability is primary; comments can still be re-anchored by a later edit. */ }
      changed = true;
      changedPaths.push(filePath);
    }
    if (changed && room.lastModifiedUserId) {
      this.db.prepare("UPDATE projects SET updated_at = ?, last_modified_by = ? WHERE id = ?")
        .run(new Date().toISOString(), room.lastModifiedUserId, room.projectId);
    }
    if (changed) this.signalComments(room.projectId);
    if (changed && this.onPersist) {
      try { this.onPersist({ projectId: room.projectId, userId: room.lastModifiedUserId, paths: changedPaths, durationMs: performance.now() - startedAt }); }
      catch { /* Source durability must not depend on optional history bookkeeping. */ }
    }
    const ok = failedPaths.length === 0 && room.dirtyPaths.size === 0;
    if (changed) room.persistedRevision += 1;
    if (ok) {
      room.persistedAt = new Date().toISOString();
    } else if (!room.saveTimer && room.dirtyPaths.size > 0) {
      // Retry with backoff if dirty files remain unpersisted
      room.saveTimer = setTimeout(() => {
        try { this.flushRoom(room); }
        catch { room.saveTimer = null; }
      }, 2000);
    }
    const receipt = this.currentReceipt(room, ok, [...new Set(failedPaths)]);
    room.rejectedPaths.clear();
    return receipt;
  }

  private currentReceipt(room: Room, ok = true, failedPaths: string[] = []): CollaborationSaveReceipt {
    return {
      revision: room.persistedRevision,
      persistedAt: room.persistedAt,
      ok: ok && room.dirtyPaths.size === 0,
      failedPaths
    };
  }

  private bumpFiles(room: Room, event: Record<string, string>): void {
    room.doc.transact(() => room.meta.set("filesEvent", { ...event, revision: randomUUID() }), META_ORIGIN);
  }

  private destroyRoom(room: Room, persist = true): void {
    if (this.rooms.get(room.projectId) !== room) return;
    if (persist) {
      try { this.flushRoom(room); }
      catch { try { this.persistRoomState(room); } catch { /* Keep shutdown best-effort. */ } }
    }
    this.disposeRoom(room);
    this.rooms.delete(room.projectId);
  }

  private disposeRoom(room: Room): void {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    for (const connection of room.connections) {
      if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
      connection.protocolTimer = null;
    }
    room.connections.clear();
    for (const lease of room.formatLeases.values()) clearTimeout(lease.timer);
    room.formatLeases.clear();
    room.formatLeaseWaiters.clear();
    room.pendingFlushes.splice(0);
    room.rejectedPaths.clear();
    room.awarenessOwners.clear();
    for (const [filePath, observer] of room.textObservers) {
      room.doc.getText(typeName(filePath)).unobserve(observer);
    }
    room.awareness.destroy();
    room.doc.destroy();
  }

  private rejectOversizedTexts(room: Room): string[] {
    const rejected: string[] = [];
    const limit = maxCollaborativeFileBytes(this.config);
    for (const filePath of [...room.dirtyPaths]) {
      const text = this.trackedText(room, filePath);
      if (Buffer.byteLength(text.toString(), "utf8") <= limit) continue;
      const previous = room.persistedContent.get(filePath) ?? "";
      room.doc.transact(() => replaceText(text, previous), DISK_ORIGIN);
      room.dirtyPaths.delete(filePath);
      room.rejectedPaths.add(filePath);
      rejected.push(filePath);
    }
    return rejected;
  }

  private sendFlushReceipt(connection: Connection, requestId: string, receipt: CollaborationSaveReceipt): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    encoding.writeVarUint(encoder, receipt.ok ? 1 : 0);
    encoding.writeVarUint(encoder, receipt.revision);
    encoding.writeVarString(encoder, receipt.persistedAt);
    encoding.writeVarUint(encoder, receipt.failedPaths?.length ?? 0);
    for (const failed of receipt.failedPaths ?? []) encoding.writeVarString(encoder, failed);
    send(connection.socket, encoding.toUint8Array(encoder));
  }

  private resolvePendingFlushes(room: Room, receipt: CollaborationSaveReceipt): void {
    const pending = room.pendingFlushes.splice(0);
    for (const request of pending) {
      if (room.connections.has(request.connection)) this.sendFlushReceipt(request.connection, request.requestId, receipt);
    }
  }

  private projectGeneration(projectId: string): number {
    return this.projectGenerations.get(projectId) ?? 0;
  }

  private pendingConnectionKey(projectId: string, generation: number): string {
    return `${projectId}\0${generation}`;
  }

  private invalidateProject(projectId: string): void {
    this.projectGenerations.set(projectId, this.projectGeneration(projectId) + 1);
    this.roomInitializations.delete(projectId);
  }
}

export function collaborationStatePath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.bin");
}

export function collaborationEpochPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.epoch");
}

export function maxCollaborativeFileBytes(config: Config): number {
  return Math.min(config.maxUploadBytes, MAX_COLLABORATIVE_FILE_BYTES);
}

export function isCollaborativeTextFile(filePath: string): boolean {
  return /(?:\.tex|\.bib|\.sty|\.cls|\.txt|\.md|latexmkrc)$/i.test(filePath);
}

function collaborativeEntrySignature(entry: FileEntry): string {
  return `${entry.path}\0${entry.size ?? 0}\0${entry.mtimeMs ?? 0}`;
}

async function collaborationEpochAsync(config: Config, projectId: string, recoveredState: boolean): Promise<string> {
  const target = collaborationEpochPath(config, projectId);
  if (recoveredState) {
    try {
      const existing = (await fs.promises.readFile(target, "utf8")).trim();
      if (new RegExp(`^${COLLABORATION_PROTOCOL_VERSION}:[a-f0-9-]{36}$`, "i").test(existing)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Generate a fresh epoch when the previous marker is missing.
    }
  }
  const epoch = `${VERSIONED_EPOCH_PREFIX}${randomUUID()}`;
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(temporary, epoch, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return epoch;
}

function typeName(filePath: string): string {
  return `${SOURCE_PREFIX}${filePath}`;
}

function replaceText(text: Y.Text, content: string): void {
  if (text.toString() === content) return;
  if (text.length) text.delete(0, text.length);
  if (content) text.insert(0, content);
}

function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function protocolMessage(epoch: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PROTOCOL);
  encoding.writeVarString(encoder, epoch);
  return encoding.toUint8Array(encoder);
}

function isConnectionOrigin(origin: unknown): origin is Connection {
  return Boolean(origin && typeof origin === "object" && "socket" in origin);
}

function isSharedCompileState(mainFile: string, value: unknown): value is SharedCompileState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<SharedCompileState>;
  const requestedBy = state.requestedBy;
  return state.mainFile === mainFile
    && typeof state.runId === "string" && state.runId.length > 0
    && (state.status === "queued" || state.status === "running" || state.status === "succeeded"
      || state.status === "failed" || state.status === "cleaned")
    && (state.status !== "cleaned" || state.cleanMode === "cache" || state.cleanMode === "artifacts")
    && (state.stale === undefined || typeof state.stale === "boolean")
    && typeof state.updatedAt === "string"
    && Boolean(requestedBy && typeof requestedBy === "object"
      && typeof requestedBy.id === "string" && typeof requestedBy.username === "string"
      && typeof requestedBy.name === "string");
}

function isCompileStateMap(value: unknown): value is Record<string, SharedCompileState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([mainFile, state]) => isSharedCompileState(mainFile, state));
}

function maintenanceMessage(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_MAINTENANCE);
  encoding.writeVarString(encoder, reason);
  return encoding.toUint8Array(encoder);
}

function formatLeaseStateMessage(lease: FormatLease | null, filePath: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_FORMAT_LEASE);
  encoding.writeVarString(encoder, "state");
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, filePath);
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, lease ? String(lease.expiresAt) : "");
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, lease?.connection.user.id ?? "");
  encoding.writeVarString(encoder, lease?.connection.user.display_name ?? "");
  return encoding.toUint8Array(encoder);
}

function awarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return result;
}

function rawData(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(message);
}
