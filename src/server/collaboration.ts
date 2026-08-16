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
import { listProjectFiles, outputRoot, resolveSourcePath, safeRelativePath } from "./files.js";
import { accessibleProject, canEdit } from "./projects.js";
import { reanchorFileComments } from "./anchors.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_FLUSH = 4;
const MESSAGE_PROTOCOL = 5;
const SOURCE_PREFIX = "source:";
const MAX_PROJECT_SESSIONS = 10;
const MAX_COLLABORATIVE_FILE_BYTES = 5 * 1024 * 1024;
const DISK_ORIGIN = Symbol("disk");
const HTTP_ORIGIN = Symbol("http");
const META_ORIGIN = Symbol("meta");
const SAVE_DELAY_MS = 750;
const STATE_SAVE_DELAY_MS = 750;
const ROOM_IDLE_MS = 30_000;
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
}

export interface CollaborationSaveReceipt {
  revision: number;
  persistedAt: string;
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
  requestedBy: { id: string; username: string; name: string };
  updatedAt: string;
}

export class CollaborationService {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly onPersist?: (event: CollaborationPersistEvent) => void
  ) {}

  connect(socket: WebSocket, projectId: string, user: UserRow): void {
    const project = accessibleProject(this.db, projectId, user);
    if (!project) {
      socket.close(1008, "Project access denied");
      return;
    }
    const room = this.getRoom(projectId);
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

  flushProject(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (room) this.flushRoom(room);
  }

  stats(): { rooms: number; sessions: number; dirtyFiles: number } {
    let sessions = 0;
    let dirtyFiles = 0;
    for (const room of this.rooms.values()) {
      sessions += room.connections.size;
      dirtyFiles += room.dirtyPaths.size;
    }
    return { rooms: this.rooms.size, sessions, dirtyFiles };
  }

  updateFile(projectId: string, filePathInput: string, content: string, userId: string): void {
    const room = this.rooms.get(projectId);
    if (!room || !isCollaborativeTextFile(filePathInput)) return;
    const filePath = safeRelativePath(filePathInput);
    room.allowedPaths.add(filePath);
    room.persistedContent.set(filePath, content);
    room.doc.transact(() => replaceText(this.trackedText(room, filePath), content), HTTP_ORIGIN);
    room.lastModifiedUserId = userId;
    this.bumpFiles(room, { kind: "update", path: filePath });
  }

  movePath(projectId: string, sourceInput: string, destinationInput: string, userId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
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
    this.bumpFiles(room, { kind: "move", source, destination });
  }

  removePath(projectId: string, filePathInput: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
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
    this.bumpFiles(room, { kind: "delete", path: filePath });
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

  closeProject(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    for (const connection of room.connections) connection.socket.close(1008, "Project closed");
    this.destroyRoom(room);
  }

  resetProject(projectId: string): void {
    const room = this.rooms.get(projectId);
    if (room) {
      for (const connection of room.connections) connection.socket.close(4001, "Project version changed; reload required");
      this.destroyRoom(room, false);
    }
    fs.rmSync(collaborationStatePath(this.config, projectId), { force: true });
    fs.rmSync(collaborationEpochPath(this.config, projectId), { force: true });
  }

  destroy(): void {
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
  }

  private getRoom(projectId: string): Room {
    const existing = this.rooms.get(projectId);
    if (existing) return existing;
    const doc = new Y.Doc();
    const room: Room = {
      projectId,
      doc,
      awareness: new Awareness(doc),
      meta: doc.getMap("texlite:meta"),
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
      epoch: "",
      persistedRevision: 0,
      persistedAt: new Date().toISOString()
    };
    room.awareness.setLocalState(null);
    const persistedState = collaborationStatePath(this.config, projectId);
    let recoveredState = false;
    let recoveredDirty = false;
    if (fs.existsSync(persistedState)) {
      try {
        Y.applyUpdate(doc, fs.readFileSync(persistedState), DISK_ORIGIN);
        recoveredState = true;
      } catch {
        // A corrupt state file is ignored; the source files remain authoritative.
      }
    }
    room.epoch = collaborationEpoch(this.config, projectId, recoveredState);
    const diskPaths = new Set<string>();
    doc.transact(() => {
      for (const entry of listProjectFiles(this.config, projectId)) {
        if (entry.type !== "file" || !isCollaborativeTextFile(entry.path) || (entry.size ?? 0) > MAX_COLLABORATIVE_FILE_BYTES) continue;
        const content = fs.readFileSync(resolveSourcePath(this.config, projectId, entry.path), "utf8");
        diskPaths.add(entry.path);
        room.allowedPaths.add(entry.path);
        room.persistedContent.set(entry.path, content);
        const name = typeName(entry.path);
        // Yjs decodes top-level shared types lazily as AbstractType instances;
        // the stable source: namespace identifies text more reliably than
        // instanceof before getText() materializes the public type.
        const hasRecoveredText = recoveredState && doc.share.has(name);
        const text = this.trackedText(room, entry.path);
        if (hasRecoveredText && text.toString() !== content) {
          room.dirtyPaths.add(entry.path);
          recoveredDirty = true;
        } else {
          replaceText(text, content);
        }
      }
      for (const name of doc.share.keys()) {
        if (!name.startsWith(SOURCE_PREFIX)) continue;
        const filePath = name.slice(SOURCE_PREFIX.length);
        if (!diskPaths.has(filePath)) replaceText(doc.getText(name), "");
      }
    }, DISK_ORIGIN);
    doc.on("update", (update, origin) => {
      this.broadcast(room, syncUpdateMessage(update), origin instanceof Object && "socket" in origin ? origin as Connection : null);
      this.scheduleStateSave(room);
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
    this.rooms.set(projectId, room);
    if (recoveredDirty) this.flushRoom(room);
    else this.persistRoomState(room);
    return room;
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
    const current = accessibleProject(this.db, room.projectId, connection.user);
    if (!current) {
      connection.socket.close(1008, "Project access revoked");
      return;
    }
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_PROTOCOL) {
      const epoch = decoding.readVarString(decoder);
      if (epoch !== room.epoch) {
        connection.socket.close(4001, "Collaboration state changed; reload required");
        return;
      }
      if (!connection.protocolVerified) {
        connection.protocolVerified = true;
        if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
        connection.protocolTimer = null;
        this.sendSyncStep1(room, connection.socket);
        this.sendAwareness(room, connection.socket);
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
      } else if (canEdit(current)) {
        if (syncType === syncProtocol.messageYjsSyncStep2) syncProtocol.readSyncStep2(decoder, room.doc, connection);
        else if (syncType === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(decoder, room.doc, connection);
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
      const receipt = this.flushRoom(room);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_FLUSH);
      encoding.writeVarString(encoder, requestId);
      encoding.writeVarUint(encoder, receipt.revision);
      encoding.writeVarString(encoder, receipt.persistedAt);
      send(connection.socket, encoding.toUint8Array(encoder));
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
    if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
    connection.protocolTimer = null;
    if (connection.awarenessClientId !== null) {
      removeAwarenessStates(room.awareness, [connection.awarenessClientId], connection);
      room.awarenessOwners.delete(connection.awarenessClientId);
    }
    if (room.connections.size === 0 && !room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => this.destroyRoom(room), ROOM_IDLE_MS);
    }
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
    const target = collaborationStatePath(this.config, room.projectId);
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, Y.encodeStateAsUpdate(room.doc), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private flushRoom(room: Room): CollaborationSaveReceipt {
    const startedAt = performance.now();
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    this.persistRoomState(room);
    let changed = false;
    const changedPaths: string[] = [];
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
      if (Buffer.byteLength(next, "utf8") > this.config.maxUploadBytes) throw new Error(`Collaborative file exceeds upload limit: ${filePath}`);
      const absolute = resolveSourcePath(this.config, room.projectId, filePath);
      if (!fs.existsSync(absolute)) throw new Error(`Collaborative source path disappeared: ${filePath}`);
      const temporary = `${absolute}.collaboration-${process.pid}-${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, absolute);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
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
    room.persistedRevision += 1;
    room.persistedAt = new Date().toISOString();
    return { revision: room.persistedRevision, persistedAt: room.persistedAt };
  }

  private bumpFiles(room: Room, event: Record<string, string>): void {
    room.doc.transact(() => room.meta.set("filesEvent", { ...event, revision: randomUUID() }), META_ORIGIN);
  }

  private destroyRoom(room: Room, persist = true): void {
    if (this.rooms.get(room.projectId) !== room) return;
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    for (const connection of room.connections) {
      if (connection.protocolTimer) clearTimeout(connection.protocolTimer);
      connection.protocolTimer = null;
    }
    if (persist) {
      try { this.flushRoom(room); }
      catch { try { this.persistRoomState(room); } catch { /* Keep shutdown best-effort. */ } }
    } else {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      if (room.stateSaveTimer) clearTimeout(room.stateSaveTimer);
    }
    for (const [filePath, observer] of room.textObservers) {
      room.doc.getText(typeName(filePath)).unobserve(observer);
    }
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(room.projectId);
  }
}

export function collaborationStatePath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.bin");
}

export function collaborationEpochPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "collaboration.epoch");
}

function collaborationEpoch(config: Config, projectId: string, recoveredState: boolean): string {
  const target = collaborationEpochPath(config, projectId);
  if (recoveredState && fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8").trim();
    if (/^[a-f0-9-]{36}$/i.test(existing)) return existing;
  }
  const epoch = randomUUID();
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, epoch, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return epoch;
}

function isCollaborativeTextFile(filePath: string): boolean {
  return /(?:\.tex|\.bib|\.sty|\.cls|\.txt|\.md|latexmkrc)$/i.test(filePath);
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
