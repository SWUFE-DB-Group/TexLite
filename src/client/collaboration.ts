import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { encodeAwarenessUpdate, type Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
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
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export function sharedCompileState(value: unknown): SharedCompileState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SharedCompileState>;
  const requestedBy = candidate.requestedBy;
  if (typeof candidate.runId !== "string"
    || !["queued", "running", "succeeded", "failed"].includes(candidate.status ?? "")
    || typeof candidate.updatedAt !== "string"
    || !requestedBy || typeof requestedBy.id !== "string"
    || typeof requestedBy.username !== "string" || typeof requestedBy.name !== "string") return null;
  return candidate as SharedCompileState;
}

export class ProjectCollaboration {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  readonly awareness: Awareness;
  private permission: Project["permission"] = "read";
  private activeFile = "";
  private epoch: string | null = null;
  private destroyed = false;
  private readonly flushRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: number }>();

  constructor(readonly projectId: string, private readonly user: User) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.provider = new WebsocketProvider(
      `${protocol}//${window.location.host}/api/collaboration`,
      projectId,
      this.doc,
      { disableBc: true, maxBackoffTime: 2500 }
    );
    this.awareness = this.provider.awareness;
    this.provider.messageHandlers[MESSAGE_FLUSH] = (_encoder, decoder) => {
      const requestId = decoding.readVarString(decoder);
      const pending = this.flushRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.flushRequests.delete(requestId);
      pending.resolve();
    };
    this.provider.messageHandlers[MESSAGE_PROTOCOL] = (_encoder, decoder) => {
      const epoch = decoding.readVarString(decoder);
      if (this.epoch && this.epoch !== epoch) {
        window.location.reload();
        return;
      }
      this.epoch = epoch;
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

  getText(filePath: string): Y.Text {
    return this.doc.getText(`source:${filePath}`);
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

  flush(): Promise<void> {
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
}

export function avatarInitial(name: string, username: string): string {
  return Array.from(name.trim() || username.trim() || "?")[0]?.toLocaleUpperCase() ?? "?";
}
