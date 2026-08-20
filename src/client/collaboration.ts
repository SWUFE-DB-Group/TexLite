import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { encodeAwarenessUpdate, type Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Project, User } from "./types";

const COLORS = [
  ["#1677c8", "#1677c833"], ["#d65745", "#d6574533"], ["#16866a", "#16866a33"],
  ["#9a58b5", "#9a58b533"], ["#d27b18", "#d27b1833"], ["#3f7d20", "#3f7d2033"],
  ["#be3e7b", "#be3e7b33"], ["#4964c6", "#4964c633"], ["#8a6a14", "#8a6a1433"],
  ["#087f8c", "#087f8c33"]
] as const;
const MESSAGE_FLUSH = 4;
const MESSAGE_PROTOCOL = 5;
const MESSAGE_MAINTENANCE = 6;
const MESSAGE_PERMISSION = 7;
const MESSAGE_COMPILE_STATES = 8;
const COLLABORATION_PROTOCOL_VERSION = 2;

export type CollaborationStatus = "connecting" | "connected" | "disconnected";

export interface ActiveSession {
  clientId: number;
  userId: string;
  username: string;
  name: string;
  color: string;
  colorLight: string;
  permission: Project["permission"];
  filePath: string;
  editing: boolean;
  local: boolean;
}

export interface FilesEvent {
  kind: "update" | "move" | "delete";
  path?: string;
  source?: string;
  destination?: string;
  revision: string;
}

export interface SharedCompileState {
  mainFile: string;
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cleaned";
  cleanMode?: "cache" | "artifacts";
  stale?: boolean;
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export interface CollaborationSaveReceipt {
  revision: number;
  persistedAt: string;
  ok: boolean;
  failedPaths?: string[];
}

export function sharedCompileState(value: unknown): SharedCompileState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SharedCompileState>;
  const requestedBy = candidate.requestedBy;
  if (typeof candidate.mainFile !== "string" || typeof candidate.runId !== "string"
    || !["queued", "running", "succeeded", "failed", "cleaned"].includes(candidate.status ?? "")
    || (candidate.status === "cleaned" && candidate.cleanMode !== "cache" && candidate.cleanMode !== "artifacts")
    || (candidate.stale !== undefined && typeof candidate.stale !== "boolean")
    || typeof candidate.updatedAt !== "string"
    || !requestedBy || typeof requestedBy.id !== "string"
    || typeof requestedBy.username !== "string" || typeof requestedBy.name !== "string") return null;
  return candidate as SharedCompileState;
}

export function sharedCompileStates(value: unknown): Record<string, SharedCompileState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, SharedCompileState> = {};
  for (const [mainFile, state] of Object.entries(value)) {
    const parsed = sharedCompileState(state);
    if (parsed && parsed.mainFile === mainFile) result[mainFile] = parsed;
  }
  return result;
}

export class ProjectCollaboration {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  readonly awareness: Awareness;
  readonly persistence: IndexeddbPersistence;
  private permission: Project["permission"] = "read";
  private activeFile = "";
  private epoch: string | null = null;
  private destroyed = false;
  private localDraftReady = false;
  private readonly draftListeners = new Set<() => void>();
  private readonly permissionListeners = new Set<(permission: Project["permission"] | "revoked") => void>();
  private readonly compileStateListeners = new Set<() => void>();
  private readonly flushRequests = new Map<string, { resolve: (receipt: CollaborationSaveReceipt) => void; reject: (error: Error) => void; timer: number }>();
  /**
   * CodeMirror remounts when the active file changes (for example when tabs
   * are enabled). Keep one undo manager per shared text instead of creating a
   * new manager for every editor mount. Apart from preserving undo history,
   * this prevents abandoned managers from retaining Yjs observers and stack
   * items for the lifetime of the project page.
   */
  private readonly undoManagers = new Map<string, Y.UndoManager>();
  private authoritativeCompileStates: Record<string, SharedCompileState> | null = null;
  private readonly metaObserver: (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => void;

  constructor(readonly projectId: string, private readonly user: User) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.persistence = new IndexeddbPersistence(`texlite:${user.id}:${projectId}`, this.doc);
    this.persistence.on("synced", () => {
      this.localDraftReady = true;
      for (const listener of this.draftListeners) listener();
    });
    this.provider = new WebsocketProvider(
      `${protocol}//${window.location.host}/api/collaboration`,
      projectId,
      this.doc,
      // Project metadata and the retained PDF are loaded before opening the
      // collaboration room. Rebuilding a cold Yjs room can read many source
      // files synchronously on the server, so it must not delay the first
      // preview request.
      { connect: false, disableBc: true, maxBackoffTime: 2500 }
    );
    this.awareness = this.provider.awareness;
    const meta = this.doc.getMap("texlite:meta");
    this.metaObserver = (event, transaction) => {
      // A server-originated compile-state update supersedes the one-shot
      // handshake snapshot. Local IndexedDB updates deliberately do not clear
      // it, otherwise an old offline metadata entry could win the race.
      if (transaction.origin === this.provider && event.keysChanged.has("compileStates")) {
        this.authoritativeCompileStates = null;
        this.notifyCompileStateListeners();
      }
    };
    meta.observe(this.metaObserver);
    this.provider.messageHandlers[MESSAGE_FLUSH] = (_encoder, decoder) => {
      const requestId = decoding.readVarString(decoder);
      const pending = this.flushRequests.get(requestId);
      if (!pending) return;
      const ok = decoding.readVarUint(decoder) === 1;
      const revision = decoding.readVarUint(decoder);
      const persistedAt = decoding.readVarString(decoder);
      const failedCount = decoding.readVarUint(decoder);
      const failedPaths: string[] = [];
      for (let i = 0; i < failedCount; i++) {
        failedPaths.push(decoding.readVarString(decoder));
      }
      window.clearTimeout(pending.timer);
      this.flushRequests.delete(requestId);
      if (!ok) {
        const error = Object.assign(
          new Error(failedPaths.length ? `保存失败：${failedPaths.join(", ")}` : "源码保存到服务器磁盘失败"),
          { failedPaths }
        );
        pending.reject(error);
      } else {
        pending.resolve({ revision, persistedAt, ok: true, failedPaths: [] });
      }
    };
    this.provider.messageHandlers[MESSAGE_PROTOCOL] = (_encoder, decoder) => {
      const epoch = decoding.readVarString(decoder);
      const epochKey = this.epochStorageKey();
      const storedEpoch = safeLocalStorageGet(epochKey);
      if ((this.epoch && this.epoch !== epoch) || (storedEpoch && storedEpoch !== epoch)) {
        this.provider.disconnect();
        this.rejectFlushes(new Error("Collaboration state changed"));
        // A protocol migration is not a source-tree replacement. Preserve an
        // offline IndexedDB draft while reloading so a server upgrade cannot
        // discard edits that had not reached the server yet. Epoch changes
        // generated by checkout/history/maintenance retain the old behavior:
        // the server tree is authoritative and the local draft is cleared.
        const incomingProtocolVersion = /^([0-9]+):/.exec(epoch)?.[1] ?? null;
        const storedProtocolVersion = storedEpoch ? /^([0-9]+):/.exec(storedEpoch)?.[1] ?? null : null;
        const protocolMigration = epoch.endsWith(":reload")
          || (incomingProtocolVersion !== null && incomingProtocolVersion !== storedProtocolVersion);
        const reload = () => {
          safeLocalStorageSet(epochKey, epoch.replace(/:reload$/, ""));
          window.location.reload();
        };
        if (protocolMigration) reload();
        else void this.persistence.clearData().then(reload);
        return;
      }
      this.epoch = epoch;
      safeLocalStorageSet(epochKey, epoch);
      const socket = this.provider.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const acknowledgement = encoding.createEncoder();
      encoding.writeVarUint(acknowledgement, MESSAGE_PROTOCOL);
      encoding.writeVarString(acknowledgement, epoch);
      encoding.writeVarUint(acknowledgement, COLLABORATION_PROTOCOL_VERSION);
      socket.send(encoding.toUint8Array(acknowledgement));
      const sync = encoding.createEncoder();
      encoding.writeVarUint(sync, 0);
      syncProtocol.writeSyncStep1(sync, this.doc);
      socket.send(encoding.toUint8Array(sync));
      const awareness = encoding.createEncoder();
      encoding.writeVarUint(awareness, 1);
      encoding.writeVarUint8Array(awareness, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      socket.send(encoding.toUint8Array(awareness));
    };
    this.provider.messageHandlers[MESSAGE_PERMISSION] = (_encoder, decoder) => {
      const userId = decoding.readVarString(decoder);
      const permission = decoding.readVarString(decoder);
      if (userId !== this.user.id) return;
      if (permission === "revoked") {
        this.rejectFlushes(new Error("Project access revoked"));
        this.provider.disconnect();
        for (const listener of this.permissionListeners) listener("revoked");
        return;
      }
      if (permission !== "read" && permission !== "edit" && permission !== "owner") return;
      const previous = this.permission;
      this.setPermission(permission, true);
      if (previous !== permission && permission === "read") {
        // A draft created while the user had write access must not be replayed
        // after a permission downgrade. Reload after removing that local data
        // so the server's current source tree becomes authoritative.
        void this.persistence.clearData().finally(() => window.location.reload());
      }
    };
    this.provider.messageHandlers[MESSAGE_MAINTENANCE] = (_encoder, decoder) => {
      // The server closes the socket immediately after this notice. Consuming
      // the message avoids y-websocket treating the custom protocol as an
      // unknown packet while the page transitions to a fresh epoch.
      decoding.readVarString(decoder);
    };
    this.provider.messageHandlers[MESSAGE_COMPILE_STATES] = (_encoder, decoder) => {
      let states: Record<string, SharedCompileState> = {};
      try {
        states = sharedCompileStates(JSON.parse(decoding.readVarString(decoder)));
      } catch {
        // A malformed optional metadata packet must never prevent source
        // editing; treating it as an empty snapshot is the safe fallback.
      }
      this.authoritativeCompileStates = states;
      this.notifyCompileStateListeners();
    };
    this.provider.on("status", ({ status }) => {
      if (status === "disconnected") {
        this.authoritativeCompileStates = null;
        this.notifyCompileStateListeners();
        this.rejectFlushes(new Error("Collaboration connection closed"));
      }
    });
    this.updateLocalAwareness();
  }

  connect(): void {
    if (this.destroyed) return;
    this.provider.connect();
    this.updateLocalAwareness();
  }

  getText(filePath: string): Y.Text {
    return this.doc.getText(`source:${filePath}`);
  }

  getUndoManager(filePath: string): Y.UndoManager {
    const existing = this.undoManagers.get(filePath);
    if (existing) return existing;
    const manager = new Y.UndoManager(this.getText(filePath));
    this.undoManagers.set(filePath, manager);
    return manager;
  }

  applyTextEdits(filePath: string, edits: ReadonlyArray<{ from: number; to: number; replacement: string }>): void {
    if (this.permission === "read") throw new Error("Read-only collaborators cannot edit source files");
    const text = this.getText(filePath);
    let previousTo = 0;
    for (const edit of edits) {
      if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < previousTo
        || edit.to < edit.from || edit.to > text.length) throw new RangeError("Invalid collaborative text edits");
      previousTo = edit.to;
    }
    this.doc.transact(() => {
      for (let index = edits.length - 1; index >= 0; index -= 1) {
        const edit = edits[index];
        if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
        if (edit.replacement) text.insert(edit.from, edit.replacement);
      }
    });
  }

  get meta(): Y.Map<unknown> {
    return this.doc.getMap("texlite:meta");
  }

  /** Return server-validated compile states when the handshake supplied one. */
  compileStates(): Record<string, SharedCompileState> {
    return this.authoritativeCompileStates ?? sharedCompileStates(this.meta.get("compileStates"));
  }

  onCompileStates(listener: () => void): () => void {
    this.compileStateListeners.add(listener);
    return () => this.compileStateListeners.delete(listener);
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  get connected(): boolean {
    return this.provider.wsconnected;
  }

  get draftReady(): boolean {
    return this.localDraftReady;
  }

  get currentPermission(): Project["permission"] {
    return this.permission;
  }

  onDraftReady(listener: () => void): () => void {
    this.draftListeners.add(listener);
    if (this.localDraftReady) listener();
    return () => this.draftListeners.delete(listener);
  }

  onPermissionChanged(listener: (permission: Project["permission"] | "revoked") => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  setPermission(permission: Project["permission"], notify = false): void {
    this.permission = permission;
    if (permission === "read") this.destroyUndoManagers();
    this.updateLocalAwareness();
    if (notify) for (const listener of this.permissionListeners) listener(permission);
  }

  setActiveFile(filePath: string): void {
    if (this.activeFile === filePath) return;
    this.activeFile = filePath;
    this.awareness.setLocalStateField("cursor", null);
    this.updateLocalAwareness();
  }

  sessions(): ActiveSession[] {
    const sessions: ActiveSession[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      const remoteUser = state?.user;
      if (!remoteUser || typeof remoteUser.id !== "string" || typeof remoteUser.name !== "string") return;
      sessions.push({
        clientId,
        userId: remoteUser.id,
        username: typeof remoteUser.username === "string" ? remoteUser.username : remoteUser.name,
        name: remoteUser.name,
        color: typeof remoteUser.color === "string" ? remoteUser.color : "#1677c8",
        colorLight: typeof remoteUser.colorLight === "string" ? remoteUser.colorLight : "#1677c833",
        permission: remoteUser.permission === "owner" || remoteUser.permission === "edit" ? remoteUser.permission : "read",
        filePath: typeof state.filePath === "string" ? state.filePath : "",
        editing: Boolean(state.cursor),
        local: clientId === this.doc.clientID
      });
    });
    return sessions.sort((left, right) => Number(right.local) - Number(left.local) || left.name.localeCompare(right.name));
  }

  flush(): Promise<CollaborationSaveReceipt> {
    const socket = this.provider.ws;
    if (!this.provider.synced || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Collaboration connection is unavailable"));
    }
    const requestId = crypto.randomUUID();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.flushRequests.delete(requestId);
        reject(new Error("Collaboration save timed out"));
      }, 5000);
      this.flushRequests.set(requestId, { resolve, reject, timer });
      socket.send(encoding.toUint8Array(encoder));
    });
  }

  /** Retry a failed websocket handshake without discarding the local Yjs doc. */
  reconnect(): void {
    if (this.destroyed) return;
    this.rejectFlushes(new Error("Collaboration connection reset"));
    this.provider.disconnect();
    this.provider.connect();
    this.updateLocalAwareness();
  }

  destroy(): void {
    this.destroyed = true;
    this.rejectFlushes(new Error("Collaboration connection closed"));
    this.provider.destroy();
    this.persistence.destroy();
    this.draftListeners.clear();
    this.compileStateListeners.clear();
    this.meta.unobserve(this.metaObserver);
    this.destroyUndoManagers();
    this.doc.destroy();
  }

  private destroyUndoManagers(): void {
    for (const manager of this.undoManagers.values()) manager.destroy();
    this.undoManagers.clear();
  }

  private notifyCompileStateListeners(): void {
    for (const listener of this.compileStateListeners) listener();
  }

  private rejectFlushes(error: Error): void {
    for (const pending of this.flushRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.flushRequests.clear();
  }

  private updateLocalAwareness(): void {
    const [color, colorLight] = COLORS[Math.abs(this.doc.clientID) % COLORS.length];
    this.awareness.setLocalStateField("user", {
      id: this.user.id,
      username: this.user.username,
      name: this.user.displayName,
      color,
      colorLight,
      permission: this.permission,
      sessionId: String(this.doc.clientID)
    });
    this.awareness.setLocalStateField("filePath", this.activeFile);
  }

  private epochStorageKey(): string {
    return `texlite:collaboration-epoch:${this.user.id}:${this.projectId}`;
  }
}

function safeLocalStorageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* IndexedDB still retains the draft. */ }
}

export function avatarInitial(name: string, username: string): string {
  return Array.from(name.trim() || username.trim() || "?")[0]?.toLocaleUpperCase() ?? "?";
}
