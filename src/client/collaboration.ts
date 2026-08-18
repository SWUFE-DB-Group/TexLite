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
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export interface CollaborationSaveReceipt {
  revision: number;
  persistedAt: string;
}

export function sharedCompileState(value: unknown): SharedCompileState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SharedCompileState>;
  const requestedBy = candidate.requestedBy;
  if (typeof candidate.mainFile !== "string" || typeof candidate.runId !== "string"
    || !["queued", "running", "succeeded", "failed", "cleaned"].includes(candidate.status ?? "")
    || (candidate.status === "cleaned" && candidate.cleanMode !== "cache" && candidate.cleanMode !== "artifacts")
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
  private readonly flushRequests = new Map<string, { resolve: (receipt: CollaborationSaveReceipt) => void; reject: (error: Error) => void; timer: number }>();

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
    this.provider.messageHandlers[MESSAGE_FLUSH] = (_encoder, decoder) => {
      const requestId = decoding.readVarString(decoder);
      const pending = this.flushRequests.get(requestId);
      if (!pending) return;
      const revision = decoding.readVarUint(decoder);
      const persistedAt = decoding.readVarString(decoder);
      window.clearTimeout(pending.timer);
      this.flushRequests.delete(requestId);
      pending.resolve({ revision, persistedAt });
    };
    this.provider.messageHandlers[MESSAGE_PROTOCOL] = (_encoder, decoder) => {
      const epoch = decoding.readVarString(decoder);
      const epochKey = this.epochStorageKey();
      const storedEpoch = safeLocalStorageGet(epochKey);
      if ((this.epoch && this.epoch !== epoch) || (storedEpoch && storedEpoch !== epoch)) {
        this.provider.disconnect();
        this.rejectFlushes(new Error("Collaboration state changed"));
        void this.persistence.clearData().then(() => {
          safeLocalStorageSet(epochKey, epoch);
          window.location.reload();
        });
        return;
      }
      this.epoch = epoch;
      safeLocalStorageSet(epochKey, epoch);
      const socket = this.provider.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const acknowledgement = encoding.createEncoder();
      encoding.writeVarUint(acknowledgement, MESSAGE_PROTOCOL);
      encoding.writeVarString(acknowledgement, epoch);
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
    this.provider.on("status", ({ status }) => {
      if (status === "disconnected") this.rejectFlushes(new Error("Collaboration connection closed"));
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

  get synced(): boolean {
    return this.provider.synced;
  }

  get connected(): boolean {
    return this.provider.wsconnected;
  }

  get draftReady(): boolean {
    return this.localDraftReady;
  }

  onDraftReady(listener: () => void): () => void {
    this.draftListeners.add(listener);
    if (this.localDraftReady) listener();
    return () => this.draftListeners.delete(listener);
  }

  setPermission(permission: Project["permission"]): void {
    this.permission = permission;
    this.updateLocalAwareness();
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
    this.doc.destroy();
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
