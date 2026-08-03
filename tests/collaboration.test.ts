import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { buildApp } from "../src/server/app.js";
import { collaborationStatePath } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";

const REMOTE_ORIGIN = Symbol("remote");
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_FLUSH = 4;
const MESSAGE_PROTOCOL = 5;

describe("project collaboration", () => {
  let root: string;
  let config: Config;
  let db: DatabaseConnection;
  let app: FastifyInstance;
  let adminId: string;
  let adminCookie: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-collaboration-"));
    config = {
      configPath: path.join(root, "config.json"), siteName: "Collaborative texLite", adminEmail: "admin@example.test",
      host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "missing-client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "pdflatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
      maxUploadBytes: 50 * 1024 * 1024
    };
    db = openDatabase(config);
    adminId = randomUUID();
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'admin', 'Administrator', ?, 'admin', 0, 0, 1, ?)`) 
      .run(adminId, await hashPassword("administrator password"), new Date().toISOString());
    app = await buildApp(config, db, { logger: false });
    await app.ready();
    adminCookie = await login(app, "admin", "administrator password");
  });

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges concurrent edits, persists them, exposes each active session and rejects read-only writes", async () => {
    const editor = await createUser(app, adminCookie, "collab-editor", "Collaborative Editor");
    const reader = await createUser(app, adminCookie, "collab-reader", "Collaborative Reader");
    const editorCookie = await login(app, "collab-editor", "editor-password");
    const readerCookie = await login(app, "collab-reader", "reader-password");
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Concurrent paper" }
    });
    const projectId = created.json().project.id as string;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${editor.id}`,
      headers: { cookie: adminCookie }, payload: { permission: "edit" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${reader.id}`,
      headers: { cookie: adminCookie }, payload: { permission: "read" }
    });

    const peers = await Promise.all([
      TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" }),
      TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" }),
      TestPeer.connect(app, projectId, editorCookie, { id: editor.id, username: "collab-editor", name: "Collaborative Editor" }),
      TestPeer.connect(app, projectId, readerCookie, { id: reader.id, username: "collab-reader", name: "Collaborative Reader" })
    ]);
    const [owner, secondOwnerSession, editingPeer, readPeer] = peers;
    try {
      await waitFor(() => owner.awareness.getStates().size === 4);
      const sessions = [...owner.awareness.getStates().values()];
      expect(sessions.filter((state) => state.user?.id === adminId)).toHaveLength(2);
      expect(sessions.find((state) => state.user?.id === editor.id)?.user).toMatchObject({
        username: "collab-editor", name: "Collaborative Editor", permission: "edit"
      });
      readPeer.awareness.setLocalStateField("cursor", { anchor: {}, head: {} });
      await waitFor(() => [...owner.awareness.getStates().values()].some((state) => state.user?.id === reader.id && state.cursor));

      const ownerText = owner.doc.getText("source:main.tex");
      const editorText = editingPeer.doc.getText("source:main.tex");
      owner.pauseUpdates = true;
      editingPeer.pauseUpdates = true;
      ownerText.insert(0, "% owner session\n");
      editorText.insert(0, "% editor session\n");
      owner.resumeUpdates();
      editingPeer.resumeUpdates();
      await waitFor(() => ownerText.toString() === editorText.toString()
        && secondOwnerSession.doc.getText("source:main.tex").toString() === ownerText.toString());
      expect(ownerText.toString()).toContain("% owner session");
      expect(ownerText.toString()).toContain("% editor session");

      await owner.flush();
      const diskContent = fs.readFileSync(path.join(config.projectsDir, projectId, "source", "main.tex"), "utf8");
      expect(diskContent).toBe(ownerText.toString());
      const persistedDoc = new Y.Doc();
      Y.applyUpdate(persistedDoc, fs.readFileSync(collaborationStatePath(config, projectId)));
      expect(persistedDoc.getText("source:main.tex").toString()).toBe(diskContent);
      persistedDoc.destroy();

      const acceptedContent = ownerText.toString();
      readPeer.doc.getText("source:main.tex").insert(0, "% forbidden read-only edit\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ownerText.toString()).toBe(acceptedContent);
      expect(editingPeer.doc.getText("source:main.tex").toString()).toBe(acceptedContent);

      const [ownerCompile, editorCompile] = await Promise.all([
        app.inject({ method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie: adminCookie } }),
        app.inject({ method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie: editorCookie } })
      ]);
      expect(ownerCompile.json()).toMatchObject({ ok: true });
      expect(editorCompile.json()).toMatchObject({ ok: true, runId: ownerCompile.json().runId });
      await waitFor(() => {
        const state = owner.doc.getMap("texlite:meta").get("compileState") as { status?: string; runId?: string } | undefined;
        return state?.status === "succeeded" && state.runId === ownerCompile.json().runId;
      });
    } finally {
      for (const peer of peers) peer.destroy();
    }
  });
});

interface PeerUser { id: string; username: string; name: string }

class TestPeer {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  pauseUpdates = false;
  private socket: WebSocket | null = null;
  private readonly queuedUpdates: Uint8Array[] = [];
  private syncResolve: (() => void) | null = null;
  private readonly synced = new Promise<void>((resolve) => { this.syncResolve = resolve; });
  private readonly flushRequests = new Map<string, () => void>();

  private constructor(private readonly user: PeerUser) {
    this.doc.on("update", (update, origin) => {
      if (origin === REMOTE_ORIGIN) return;
      if (this.pauseUpdates) this.queuedUpdates.push(update);
      else this.send(syncUpdate(update));
    });
    this.awareness.on("update", ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[];
    }, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length) this.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, changed)));
    });
  }

  static async connect(app: FastifyInstance, projectId: string, cookie: string, user: PeerUser): Promise<TestPeer> {
    const peer = new TestPeer(user);
    const socket = await app.injectWS(
      `/api/collaboration/${projectId}`,
      { headers: { cookie } },
      {
        onInit: (created) => peer.attach(created),
        onOpen: () => peer.start()
      }
    );
    peer.socket = socket;
    await peer.synced;
    return peer;
  }

  resumeUpdates(): void {
    this.pauseUpdates = false;
    for (const update of this.queuedUpdates.splice(0)) this.send(syncUpdate(update));
  }

  flush(): Promise<void> {
    const requestId = randomUUID();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("flush timeout")), 2000);
      this.flushRequests.set(requestId, () => { clearTimeout(timer); resolve(); });
      this.send(encoding.toUint8Array(encoder));
    });
  }

  destroy(): void {
    this.awareness.destroy();
    this.socket?.terminate();
    this.doc.destroy();
  }

  private attach(socket: WebSocket): void {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.on("message", (data) => this.receive(rawData(data)));
  }

  private start(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
    this.awareness.setLocalState({
      filePath: "main.tex", cursor: null,
      user: { id: this.user.id, username: this.user.username, name: this.user.name }
    });
  }

  private receive(bytes: Uint8Array): void {
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      if (syncType === syncProtocol.messageYjsSyncStep2) this.syncResolve?.();
    } else if (messageType === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), REMOTE_ORIGIN);
    } else if (messageType === MESSAGE_FLUSH) {
      const requestId = decoding.readVarString(decoder);
      this.flushRequests.get(requestId)?.();
      this.flushRequests.delete(requestId);
    } else if (messageType === MESSAGE_PROTOCOL) {
      const epoch = decoding.readVarString(decoder);
      const acknowledgement = encoding.createEncoder();
      encoding.writeVarUint(acknowledgement, MESSAGE_PROTOCOL);
      encoding.writeVarString(acknowledgement, epoch);
      this.send(encoding.toUint8Array(acknowledgement));
      const sync = encoding.createEncoder();
      encoding.writeVarUint(sync, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(sync, this.doc);
      this.send(encoding.toUint8Array(sync));
      this.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
    }
  }

  private send(message: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
  }
}

async function createUser(app: FastifyInstance, cookie: string, username: string, displayName: string) {
  const response = await app.inject({
    method: "POST", url: "/api/admin/users", headers: { cookie },
    payload: { username, displayName, password: username === "collab-editor" ? "editor-password" : "reader-password" }
  });
  expect(response.statusCode).toBe(201);
  return response.json().user as { id: string };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.headers["set-cookie"]!.split(";")[0];
}

function syncUpdate(update: Uint8Array): Uint8Array {
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

function rawData(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for collaboration state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
