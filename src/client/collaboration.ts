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
const MESSAGE_FORMAT_LEASE = 9;
const COLLABORATION_PROTOCOL_VERSION = 3;
const FORMAT_LEASE_REQUEST_TIMEOUT_MS = 60_000;
const WRITABLE_DRAFT_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const WRITABLE_DRAFT_HEARTBEAT_MS = 15_000;
// Background tabs can throttle timers heavily. Keep enough margin to avoid
// treating an open, temporarily suspended tab as abandoned; pagehide releases
// the lease immediately during an ordinary close or navigation.
const WRITABLE_DRAFT_ACTIVE_MAX_AGE_MS = 5 * 60_000;

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

export interface FormatLeaseState {
  path: string;
  holderUserId: string;
  holderName: string;
  expiresAt: number;
}

export interface FormatLease {
  path: string;
  token: string;
  expiresAt: number;
  confirm(): Promise<void>;
  renew(): Promise<void>;
  release(): Promise<void>;
}

interface FormatLeaseResponse {
  status: string;
  filePath: string;
  token: string;
  expiresAt: number;
}

interface WritableDraftMarker {
  generation: number;
  updatedAt: number;
  activeAt: number;
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

export function writableDraftCoveredByFlush(
  markerGeneration: number,
  currentGeneration: number,
  flushedGeneration: number
): boolean {
  return markerGeneration <= flushedGeneration && currentGeneration <= flushedGeneration;
}

export function writableDraftAvailability(
  markers: ReadonlyArray<{ tabId: string; activeAt: number }>,
  currentTabId: string,
  now: number
): { recoverable: boolean; otherActive: boolean } {
  const active = (activeAt: number) => activeAt > 0 && now - activeAt <= WRITABLE_DRAFT_ACTIVE_MAX_AGE_MS;
  return {
    // An inactive marker still identifies a draft in the shared IndexedDB,
    // but no live tab owns it, so the current tab may explicitly discard it.
    recoverable: markers.some((marker) => marker.tabId === currentTabId || !active(marker.activeAt)),
    otherActive: markers.some((marker) => marker.tabId !== currentTabId && active(marker.activeAt))
  };
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
  private readonly permissionListeners = new Set<(
    permission: Project["permission"] | "revoked",
    previous: Project["permission"]
  ) => void>();
  private readonly protocolUpgradeListeners = new Set<() => void>();
  private readonly compileStateListeners = new Set<() => void>();
  private readonly flushRequests = new Map<string, {
    resolve: (receipt: CollaborationSaveReceipt) => void;
    reject: (error: Error) => void;
    timer: number;
    draftGeneration: number;
  }>();
  private readonly formatLeaseRequests = new Map<string, { resolve: (value: FormatLeaseResponse) => void; reject: (error: Error) => void; timer: number }>();
  private readonly formatLeaseListeners = new Set<(state: FormatLeaseState | null) => void>();
  private readonly formatLeaseStatesByPath = new Map<string, FormatLeaseState>();
  private readonly formatLeaseExpiryTimers = new Map<string, number>();
  private readonly draftTabId: string;
  private draftGeneration = 0;
  private draftUpdatedAt = 0;
  private draftMarkerPresent = false;
  private draftHeartbeatTimer: number | null = null;
  private readonly markDraftTabInactive: () => void;
  private readonly markDraftTabActive: () => void;
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
  private readonly localDraftTransactionObserver: (transaction: Y.Transaction) => void;

  constructor(readonly projectId: string, private readonly user: User) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.draftTabId = getOrCreateDraftTabId(`texlite:collaboration-tab:${user.id}:${projectId}`);
    const storedDraft = this.readOwnWritableDraftMarker();
    this.draftGeneration = storedDraft?.generation ?? 0;
    this.draftUpdatedAt = storedDraft?.updatedAt ?? 0;
    this.draftMarkerPresent = storedDraft !== null;
    this.markDraftTabInactive = () => this.setOwnDraftActivity(false);
    this.markDraftTabActive = () => this.resumeOwnDraftActivity();
    window.addEventListener("pagehide", this.markDraftTabInactive);
    window.addEventListener("pageshow", this.markDraftTabActive);
    if (storedDraft) {
      this.setOwnDraftActivity(true);
      this.startDraftHeartbeat();
    }
    this.persistence = new IndexeddbPersistence(`texlite:${user.id}:${projectId}`, this.doc);
    this.localDraftTransactionObserver = (transaction) => {
      if (!transaction.local) return;
      // CodeMirror's yCollab binding writes directly to Y.Text. Keep the
      // protection marker at this layer so ordinary typing, undo/redo, and
      // programmatic edits all follow the same permission-downgrade path.
      for (const [name, sharedType] of this.doc.share) {
        if (!name.startsWith("source:")) continue;
        if (transaction.changed.has(sharedType) || transaction.changedParentTypes.has(sharedType)) {
          this.markWritableDraft();
          return;
        }
      }
    };
    this.doc.on("afterTransaction", this.localDraftTransactionObserver);
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
        this.clearOwnWritableDraftMarker(pending.draftGeneration);
        pending.resolve({ revision, persistedAt, ok: true, failedPaths: [] });
      }
    };
    this.provider.messageHandlers[MESSAGE_PROTOCOL] = (_encoder, decoder) => {
      const epoch = decoding.readVarString(decoder);
      const epochKey = this.epochStorageKey();
      const storedEpoch = safeLocalStorageGet(epochKey);
      const incomingProtocolVersion = /^([0-9]+):/.exec(epoch)?.[1] ?? null;
      const storedProtocolVersion = storedEpoch ? /^([0-9]+):/.exec(storedEpoch)?.[1] ?? null : null;
      // After the user explicitly refreshes into a compatible new bundle, the
      // only mismatch is its old protocol epoch in localStorage. Accept the
      // server's new epoch in place and keep the IndexedDB draft: treating it
      // as a source-tree replacement here would erase exactly the draft the
      // update banner was intended to protect.
      const acceptsRetainedProtocolUpgrade = !this.epoch
        && incomingProtocolVersion === String(COLLABORATION_PROTOCOL_VERSION)
        && storedProtocolVersion !== null
        && storedProtocolVersion !== incomingProtocolVersion;
      if (((this.epoch && this.epoch !== epoch) || (storedEpoch && storedEpoch !== epoch))
        && !acceptsRetainedProtocolUpgrade) {
        this.provider.disconnect();
        this.rejectFlushes(new Error("Collaboration state changed"));
        // A protocol migration is not a source-tree replacement. Preserve an
        // offline IndexedDB draft so a server upgrade cannot discard edits
        // that had not reached the server yet. Epoch changes generated by
        // checkout/history/maintenance retain the old behavior: the server
        // tree is authoritative and the local draft is cleared.
        // An older browser cannot safely continue a changed wire protocol,
        // but immediately reloading it can interrupt a writer in the middle
        // of a sentence. Keep its IndexedDB draft intact and let the
        // workspace present an explicit, non-dismissible refresh action.
        // Compare against this bundle's protocol version rather than the
        // cached epoch: after the user refreshes into the new bundle, a stale
        // stored epoch must not trigger the same upgrade notice forever.
        const protocolMigration = epoch.endsWith(":reload")
          || (incomingProtocolVersion !== null
            && incomingProtocolVersion !== String(COLLABORATION_PROTOCOL_VERSION));
        const reload = () => {
          safeLocalStorageSet(epochKey, epoch.replace(/:reload$/, ""));
          window.location.reload();
        };
        if (protocolMigration) {
          for (const listener of this.protocolUpgradeListeners) listener();
        }
        else void this.persistence.clearData().then(() => {
          this.clearWritableDraftMarkers();
          reload();
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
        for (const listener of this.permissionListeners) listener("revoked", this.permission);
        return;
      }
      if (permission !== "read" && permission !== "edit" && permission !== "owner") return;
      const previous = this.permission;
      this.setPermission(permission);
      if (previous !== permission) {
        if (permission === "read") this.rejectFlushes(new Error("Project permission changed to read-only"));
        // Do not destroy an offline draft as a side effect of a permission
        // change. The workspace presents an explicit choice: keep the draft
        // visible in this tab (read-only), or discard it and reload the
        // authoritative server tree. This is important when a collaborator
        // is downgraded while disconnected or while a local edit is pending.
        for (const listener of this.permissionListeners) listener(permission, previous);
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
    this.provider.messageHandlers[MESSAGE_FORMAT_LEASE] = (_encoder, decoder) => {
      const status = decoding.readVarString(decoder);
      const requestId = decoding.readVarString(decoder);
      const filePath = decoding.readVarString(decoder);
      const token = decoding.readVarString(decoder);
      const expiresAtText = decoding.readVarString(decoder);
      const reason = decoding.readVarString(decoder);
      if (status === "state") {
        const holderUserId = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : "";
        const holderName = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : "";
        const expiresAt = Number(expiresAtText);
        if (!holderUserId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          this.removeFormatLeaseState(filePath);
          this.notifyFormatLeaseListeners(null);
        } else {
          const state = { path: filePath, holderUserId, holderName, expiresAt };
          this.formatLeaseStatesByPath.set(filePath, state);
          const previousTimer = this.formatLeaseExpiryTimers.get(filePath);
          if (previousTimer !== undefined) window.clearTimeout(previousTimer);
          const timer = window.setTimeout(() => {
            const current = this.formatLeaseStatesByPath.get(filePath);
            if (!current || current.expiresAt > Date.now()) return;
            this.removeFormatLeaseState(filePath);
            this.notifyFormatLeaseListeners(null);
          }, Math.max(0, expiresAt - Date.now()) + 25);
          this.formatLeaseExpiryTimers.set(filePath, timer);
          this.notifyFormatLeaseListeners(state);
        }
        return;
      }
      const pending = this.formatLeaseRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.formatLeaseRequests.delete(requestId);
      if (status === "denied") pending.reject(new Error(reason || "Format lease request was denied"));
      else pending.resolve({ status, filePath, token, expiresAt: Number(expiresAtText) });
    };
    this.provider.on("status", ({ status }) => {
      if (status === "disconnected") {
        this.authoritativeCompileStates = null;
        this.notifyCompileStateListeners();
        this.rejectFlushes(new Error("Collaboration connection closed"));
        this.rejectFormatLeaseRequests(new Error("Collaboration connection closed"));
        this.clearFormatLeaseStates();
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

  onPermissionChanged(listener: (
    permission: Project["permission"] | "revoked",
    previous: Project["permission"]
  ) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  /**
   * The server rejected this bundle's collaboration protocol. The listener
   * keeps the page usable enough for the writer to choose when to reload;
   * IndexedDB retains any local Yjs draft until that explicit refresh.
   */
  onProtocolUpgrade(listener: () => void): () => void {
    this.protocolUpgradeListeners.add(listener);
    return () => this.protocolUpgradeListeners.delete(listener);
  }

  /** Explicitly discard the local IndexedDB draft after a permission change. */
  async discardLocalDraft(): Promise<boolean> {
    // IndexedDB is shared by every tab for this user/project. Never let one
    // tab erase a draft that another live browser tab still owns.
    if (this.hasOtherWritableDraft) return false;
    await this.persistence.clearData();
    this.localDraftReady = false;
    this.clearWritableDraftMarkers();
    return true;
  }

  /** Whether IndexedDB contains a draft that this tab may recover or discard. */
  get hasWritableDraft(): boolean {
    const markers = this.readWritableDraftMarkers();
    return writableDraftAvailability(
      markers.map(({ tabId, marker }) => ({ tabId, activeAt: marker.activeAt })),
      this.draftTabId,
      Date.now()
    ).recoverable;
  }

  /** Whether another browser tab has a pending draft in the shared IndexedDB. */
  get hasOtherWritableDraft(): boolean {
    const markers = this.readWritableDraftMarkers();
    return writableDraftAvailability(
      markers.map(({ tabId, marker }) => ({ tabId, activeAt: marker.activeAt })),
      this.draftTabId,
      Date.now()
    ).otherActive;
  }

  setPermission(permission: Project["permission"], notify = false): void {
    const previous = this.permission;
    this.permission = permission;
    if (permission === "read") {
      if (previous !== "read") this.rejectFlushes(new Error("Project permission changed to read-only"));
      this.destroyUndoManagers();
      this.clearFormatLeaseStates();
    }
    this.updateLocalAwareness();
    if (notify && previous !== permission) for (const listener of this.permissionListeners) listener(permission, previous);
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
    const draftGeneration = this.draftGeneration;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.flushRequests.delete(requestId);
        reject(new Error("Collaboration save timed out"));
      }, 5000);
      this.flushRequests.set(requestId, { resolve, reject, timer, draftGeneration });
      socket.send(encoding.toUint8Array(encoder));
    });
  }

  onFormatLeaseState(listener: (state: FormatLeaseState | null) => void): () => void {
    this.formatLeaseListeners.add(listener);
    for (const state of this.formatLeaseStatesByPath.values()) listener(state);
    return () => this.formatLeaseListeners.delete(listener);
  }

  formatLeaseStates(): FormatLeaseState[] {
    const now = Date.now();
    for (const [filePath, state] of this.formatLeaseStatesByPath) {
      if (state.expiresAt <= now) this.removeFormatLeaseState(filePath);
    }
    return [...this.formatLeaseStatesByPath.values()];
  }

  async acquireFormatLease(filePath: string): Promise<FormatLease> {
    if (this.permission === "read") throw new Error("Formatting requires write permission");
    const grant = await this.requestFormatLease("acquire", filePath);
    if (grant.status !== "grant" || !grant.token || !Number.isFinite(grant.expiresAt)) {
      throw new Error("Format lease was not granted");
    }
    let token = grant.token;
    let expiresAt = grant.expiresAt;
    let released = false;
    const renew = async (): Promise<void> => {
      if (released) throw new Error("Format lease has already been released");
      const renewed = await this.requestFormatLease("renew", filePath, token);
      if (renewed.status !== "renewed" || !Number.isFinite(renewed.expiresAt)) throw new Error("Format lease renewal failed");
      token = renewed.token || token;
      expiresAt = renewed.expiresAt;
    };
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      const socket = this.provider.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try { await this.requestFormatLease("release", filePath, token); }
      catch { /* Disconnect/expiry already releases the in-memory lease. */ }
    };
    return {
      path: filePath,
      get token() { return token; },
      get expiresAt() { return expiresAt; },
      confirm: renew,
      renew,
      release
    };
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
    this.setOwnDraftActivity(false);
    this.stopDraftHeartbeat();
    window.removeEventListener("pagehide", this.markDraftTabInactive);
    window.removeEventListener("pageshow", this.markDraftTabActive);
    this.rejectFlushes(new Error("Collaboration connection closed"));
    this.provider.destroy();
    this.persistence.destroy();
    this.draftListeners.clear();
    this.protocolUpgradeListeners.clear();
    this.compileStateListeners.clear();
    this.rejectFormatLeaseRequests(new Error("Collaboration connection closed"));
    this.clearFormatLeaseStates();
    this.formatLeaseListeners.clear();
    this.meta.unobserve(this.metaObserver);
    this.doc.off("afterTransaction", this.localDraftTransactionObserver);
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

  private requestFormatLease(
    operation: "acquire" | "renew" | "release" | "cancel",
    filePath: string,
    token = ""
  ): Promise<FormatLeaseResponse> {
    const socket = this.provider.ws;
    if (!this.provider.synced || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Collaboration connection is unavailable"));
    }
    const requestId = crypto.randomUUID();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FORMAT_LEASE);
    encoding.writeVarString(encoder, operation);
    encoding.writeVarString(encoder, requestId);
    encoding.writeVarString(encoder, filePath);
    encoding.writeVarString(encoder, token);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.formatLeaseRequests.delete(requestId);
        if (operation === "acquire") {
          const cancelSocket = this.provider.ws;
          if (cancelSocket?.readyState === WebSocket.OPEN) {
            const cancel = encoding.createEncoder();
            encoding.writeVarUint(cancel, MESSAGE_FORMAT_LEASE);
            encoding.writeVarString(cancel, "cancel");
            encoding.writeVarString(cancel, requestId);
            encoding.writeVarString(cancel, filePath);
            encoding.writeVarString(cancel, "");
            cancelSocket.send(encoding.toUint8Array(cancel));
          }
        }
        reject(new Error("Format lease request timed out"));
      }, operation === "acquire" ? FORMAT_LEASE_REQUEST_TIMEOUT_MS : 5_000);
      this.formatLeaseRequests.set(requestId, { resolve, reject, timer });
      socket.send(encoding.toUint8Array(encoder));
    });
  }

  private rejectFormatLeaseRequests(error: Error): void {
    for (const pending of this.formatLeaseRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.formatLeaseRequests.clear();
  }

  private clearFormatLeaseStates(): void {
    for (const timer of this.formatLeaseExpiryTimers.values()) window.clearTimeout(timer);
    this.formatLeaseExpiryTimers.clear();
    if (!this.formatLeaseStatesByPath.size) return;
    this.formatLeaseStatesByPath.clear();
    this.notifyFormatLeaseListeners(null);
  }

  private removeFormatLeaseState(filePath: string): void {
    const timer = this.formatLeaseExpiryTimers.get(filePath);
    if (timer !== undefined) window.clearTimeout(timer);
    this.formatLeaseExpiryTimers.delete(filePath);
    this.formatLeaseStatesByPath.delete(filePath);
  }

  private notifyFormatLeaseListeners(state: FormatLeaseState | null): void {
    for (const listener of this.formatLeaseListeners) listener(state);
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

  private writableDraftStoragePrefix(): string {
    return `texlite:collaboration-writable:${this.user.id}:${this.projectId}:`;
  }

  private ownWritableDraftStorageKey(): string {
    return `${this.writableDraftStoragePrefix()}${this.draftTabId}`;
  }

  private markWritableDraft(): void {
    this.draftGeneration += 1;
    this.draftUpdatedAt = Date.now();
    // Persist immediately for the first edit, then let the heartbeat coalesce
    // subsequent keystrokes into one small localStorage write every 15s.
    if (!this.draftMarkerPresent) this.writeOwnWritableDraftMarker(true);
    this.startDraftHeartbeat();
  }

  private clearWritableDraftMarkers(): void {
    for (const { key } of this.readWritableDraftMarkers()) safeLocalStorageRemove(key);
    this.draftMarkerPresent = false;
    this.stopDraftHeartbeat();
    // Clean up the short-lived map format used by the initial implementation.
    safeLocalStorageRemove(this.writableDraftStoragePrefix().slice(0, -1));
  }

  private clearOwnWritableDraftMarker(flushedGeneration: number): void {
    const marker = this.readOwnWritableDraftMarker();
    if (!marker || !writableDraftCoveredByFlush(marker.generation, this.draftGeneration, flushedGeneration)) return;
    safeLocalStorageRemove(this.ownWritableDraftStorageKey());
    this.draftMarkerPresent = false;
    this.stopDraftHeartbeat();
  }

  private readOwnWritableDraftMarker(): WritableDraftMarker | null {
    return this.readWritableDraftMarker(this.ownWritableDraftStorageKey());
  }

  private readWritableDraftMarkers(): Array<{ key: string; tabId: string; marker: WritableDraftMarker }> {
    const prefix = this.writableDraftStoragePrefix();
    const markers: Array<{ key: string; tabId: string; marker: WritableDraftMarker }> = [];
    for (const key of safeLocalStorageKeys()) {
      if (!key.startsWith(prefix)) continue;
      const marker = this.readWritableDraftMarker(key);
      if (marker) markers.push({ key, tabId: key.slice(prefix.length), marker });
    }
    return markers;
  }

  private readWritableDraftMarker(key: string): WritableDraftMarker | null {
    const raw = safeLocalStorageGet(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const candidate = parsed as Partial<WritableDraftMarker>;
      const now = Date.now();
      if (!Number.isInteger(candidate.generation) || (candidate.generation ?? 0) < 0
        || typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)
        || candidate.updatedAt <= 0 || now - candidate.updatedAt > WRITABLE_DRAFT_MARKER_MAX_AGE_MS) {
        safeLocalStorageRemove(key);
        return null;
      }
      const activeAt = typeof candidate.activeAt === "number" && Number.isFinite(candidate.activeAt)
        ? Math.max(0, candidate.activeAt)
        : 0;
      return { generation: candidate.generation!, updatedAt: candidate.updatedAt, activeAt };
    } catch {
      safeLocalStorageRemove(key);
      return null;
    }
  }

  private writeOwnWritableDraftMarker(active: boolean): void {
    if (!this.draftMarkerPresent && this.draftUpdatedAt <= 0) return;
    const marker: WritableDraftMarker = {
      generation: this.draftGeneration,
      updatedAt: this.draftUpdatedAt || Date.now(),
      activeAt: active ? Date.now() : 0
    };
    safeLocalStorageSet(this.ownWritableDraftStorageKey(), JSON.stringify(marker));
    this.draftMarkerPresent = true;
  }

  private setOwnDraftActivity(active: boolean): void {
    if (!this.draftMarkerPresent) return;
    this.writeOwnWritableDraftMarker(active);
    if (active) this.startDraftHeartbeat();
    else this.stopDraftHeartbeat();
  }

  private resumeOwnDraftActivity(): void {
    // Another tab may have explicitly discarded the shared IndexedDB draft
    // while this page was suspended in the back-forward cache. Do not revive
    // a marker that no longer exists when pageshow restores this instance.
    const marker = this.readOwnWritableDraftMarker();
    if (!marker) {
      this.draftMarkerPresent = false;
      this.stopDraftHeartbeat();
      return;
    }
    this.draftGeneration = Math.max(this.draftGeneration, marker.generation);
    this.draftUpdatedAt = marker.updatedAt;
    this.draftMarkerPresent = true;
    this.setOwnDraftActivity(true);
  }

  private startDraftHeartbeat(): void {
    if (this.draftHeartbeatTimer !== null || !this.draftMarkerPresent) return;
    this.draftHeartbeatTimer = window.setInterval(() => {
      this.writeOwnWritableDraftMarker(true);
    }, WRITABLE_DRAFT_HEARTBEAT_MS);
  }

  private stopDraftHeartbeat(): void {
    if (this.draftHeartbeatTimer === null) return;
    window.clearInterval(this.draftHeartbeatTimer);
    this.draftHeartbeatTimer = null;
  }
}

function safeLocalStorageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* IndexedDB still retains the draft. */ }
}

function safeLocalStorageRemove(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* Best-effort marker cleanup. */ }
}

function safeLocalStorageKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function safeSessionStorageGet(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function safeSessionStorageSet(key: string, value: string): void {
  try { window.sessionStorage.setItem(key, value); } catch { /* IndexedDB still retains the draft. */ }
}

function getOrCreateDraftTabId(key: string): string {
  const existing = safeSessionStorageGet(key);
  if (existing) return existing;
  const created = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  safeSessionStorageSet(key, created);
  return created;
}

export function avatarInitial(name: string, username: string): string {
  return Array.from(name.trim() || username.trim() || "?")[0]?.toLocaleUpperCase() ?? "?";
}
