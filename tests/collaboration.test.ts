import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { buildApp } from "../src/server/app.js";
import { CollaborationService, collaborationEpochPath, collaborationStatePath, maxCollaborativeFileBytes } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection, type UserRow } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";

const REMOTE_ORIGIN = Symbol("remote");
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_FLUSH = 4;
const MESSAGE_PROTOCOL = 5;
const MESSAGE_PERMISSION = 7;

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
      maxUploadBytes: 50 * 1024 * 1024, historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
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
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie: adminCookie },
      payload: { path: "appendix.tex", content: "\\section{Appendix}\n" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie: adminCookie },
      payload: {
        path: "standalone.tex",
        content: "\\documentclass{article}\n\\begin{document}\nStandalone.\n\\end{document}\n"
      }
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

      const receipt = await owner.flush();
      expect(receipt.revision).toBeGreaterThan(0);
      expect(new Date(receipt.persistedAt).toISOString()).toBe(receipt.persistedAt);
      const repeatedReceipt = await owner.flush();
      expect(repeatedReceipt.revision).toBe(receipt.revision);
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

      const permissionChange = await app.inject({
        method: "PUT", url: `/api/projects/${projectId}/members/${editor.id}`,
        headers: { cookie: adminCookie }, payload: { permission: "read" }
      });
      expect(permissionChange.statusCode).toBe(200);
      await waitFor(() => editingPeer.permissionChanges.includes("read"));
      const permissionRestore = await app.inject({
        method: "PUT", url: `/api/projects/${projectId}/members/${editor.id}`,
        headers: { cookie: adminCookie }, payload: { permission: "edit" }
      });
      expect(permissionRestore.statusCode).toBe(200);
      await waitFor(() => editingPeer.permissionChanges.includes("edit"));

      const staleAppendix = owner.doc.getText("source:appendix.tex");
      expect(staleAppendix.toString()).toContain("Appendix");
      const deleted = await app.inject({
        method: "DELETE", url: `/api/projects/${projectId}/file?path=appendix.tex`, headers: { cookie: adminCookie }
      });
      expect(deleted.statusCode).toBe(200);
      await waitFor(() => staleAppendix.toString() === "");
      staleAppendix.insert(0, "% late edit after deletion\n");
      await waitFor(() => staleAppendix.toString() === "");
      await owner.flush();
      expect(fs.existsSync(path.join(config.projectsDir, projectId, "source", "appendix.tex"))).toBe(false);

      const [ownerCompile, editorCompile] = await Promise.all([
        app.inject({ method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie: adminCookie } }),
        app.inject({ method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie: editorCookie } })
      ]);
      expect(ownerCompile.json()).toMatchObject({ ok: true });
      expect(editorCompile.json()).toMatchObject({ ok: true, runId: ownerCompile.json().runId });
      await waitFor(() => {
        const states = owner.doc.getMap("texlite:meta").get("compileStates") as Record<string, { status?: string; runId?: string }> | undefined;
        const state = states?.["main.tex"];
        return state?.status === "succeeded" && state.runId === ownerCompile.json().runId;
      });
      const standaloneCompile = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie: editorCookie },
        payload: { mainFile: "standalone.tex" }
      });
      expect(standaloneCompile.json()).toMatchObject({ ok: true, mainFile: "standalone.tex" });
      await waitFor(() => {
        const states = owner.doc.getMap("texlite:meta").get("compileStates") as Record<string, { status?: string; runId?: string }> | undefined;
        return states?.["main.tex"]?.runId === ownerCompile.json().runId
          && states?.["standalone.tex"]?.status === "succeeded"
          && states["standalone.tex"].runId === standaloneCompile.json().runId;
      });
      const cleanCache = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile/clean`, headers: { cookie: adminCookie },
        payload: { mainFile: "main.tex", mode: "cache" }
      });
      expect(cleanCache.json()).toMatchObject({ ok: true, mode: "cache", retainedPdf: true });
      await waitFor(() => {
        const states = owner.doc.getMap("texlite:meta").get("compileStates") as Record<string, { status?: string; cleanMode?: string }> | undefined;
        return states?.["main.tex"]?.status === "cleaned" && states["main.tex"]?.cleanMode === "cache";
      });
      const cleanArtifacts = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile/clean`, headers: { cookie: adminCookie },
        payload: { mainFile: "main.tex", mode: "artifacts" }
      });
      expect(cleanArtifacts.json()).toMatchObject({ ok: true, mode: "artifacts", retainedPdf: false });
      await waitFor(() => {
        const states = owner.doc.getMap("texlite:meta").get("compileStates") as Record<string, { status?: string; cleanMode?: string }> | undefined;
        return states?.["main.tex"]?.status === "cleaned" && states["main.tex"]?.cleanMode === "artifacts";
      });
    } finally {
      for (const peer of peers) peer.destroy();
    }
  });

  it("recovers a Yjs update that was durable before its source-file rename", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Crash recovery paper" }
    });
    const projectId = created.json().project.id as string;
    const recoveredContent = "\\documentclass{article}\n\\begin{document}\nRecovered draft.\n\\end{document}\n";
    const persisted = new Y.Doc();
    persisted.getText("source:main.tex").insert(0, recoveredContent);
    const statePath = collaborationStatePath(config, projectId);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, Y.encodeStateAsUpdate(persisted));
    fs.writeFileSync(collaborationEpochPath(config, projectId), randomUUID());
    persisted.destroy();

    const peer = await TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" });
    try {
      await waitFor(() => peer.doc.getText("source:main.tex").toString() === recoveredContent);
      await waitFor(() => fs.readFileSync(path.join(config.projectsDir, projectId, "source", "main.tex"), "utf8") === recoveredContent);
      const receipt = await peer.flush();
      expect(receipt.revision).toBeGreaterThan(0);
    } finally { peer.destroy(); }
  });

  it("repairs an oversized recovered Yjs text from the authoritative source file", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Oversized recovery" }
    });
    const projectId = created.json().project.id as string;
    const sourcePath = path.join(config.projectsDir, projectId, "source", "main.tex");
    const sourceContent = fs.readFileSync(sourcePath, "utf8");
    const persisted = new Y.Doc();
    persisted.getText("source:main.tex").insert(0, "x".repeat(maxCollaborativeFileBytes(config) + 1));
    fs.mkdirSync(path.dirname(collaborationStatePath(config, projectId)), { recursive: true });
    fs.writeFileSync(collaborationStatePath(config, projectId), Y.encodeStateAsUpdate(persisted));
    fs.writeFileSync(collaborationEpochPath(config, projectId), randomUUID());
    persisted.destroy();

    const peer = await TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" });
    try {
      await waitFor(() => peer.doc.getText("source:main.tex").toString() === sourceContent);
      const repaired = new Y.Doc();
      Y.applyUpdate(repaired, fs.readFileSync(collaborationStatePath(config, projectId)));
      expect(repaired.getText("source:main.tex").toString()).toBe(sourceContent);
      repaired.destroy();
    } finally { peer.destroy(); }
  });

  it("rejects an oversized live edit and restores the last persisted source", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Oversized live edit" }
    });
    const projectId = created.json().project.id as string;
    const sourcePath = path.join(config.projectsDir, projectId, "source", "main.tex");
    const sourceContent = fs.readFileSync(sourcePath, "utf8");
    const peer = await TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" });
    try {
      const text = peer.doc.getText("source:main.tex");
      peer.doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, "x".repeat(maxCollaborativeFileBytes(config) + 1));
      });
      await peer.flush();
      await waitFor(() => text.toString() === sourceContent, 10_000);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceContent);
    } finally { peer.destroy(); }
  }, 15_000);

  it("disconnects a user's active WebSocket connection across rooms when disabled by admin", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Disabled user disconnect" }
    });
    const projectId = created.json().project.id as string;
    const user = await createUser(app, adminCookie, "ws-disabled-user", "Disabled User");
    const userCookie = await login(app, "ws-disabled-user", "reader-password");

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${user.id}`, headers: { cookie: adminCookie },
      payload: { permission: "edit" }
    });

    const peer = await TestPeer.connect(app, projectId, userCookie, { id: user.id, username: "ws-disabled-user", name: "Disabled User" });
    try {
      expect(peer.connected).toBe(true);

      // Disable the user via admin API
      const patchRes = await app.inject({
        method: "PATCH", url: `/api/admin/users/${user.id}`, headers: { cookie: adminCookie },
        payload: { disabled: true }
      });
      expect(patchRes.statusCode).toBe(200);

      await waitFor(() => !peer.connected, 3000);
      expect(peer.connected).toBe(false);
    } finally {
      peer.destroy();
    }
  });

  it("rejects flush and identifies failed paths when a dirty file fails to write to disk", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Flush Error Project" }
    });
    const projectId = created.json().project.id as string;
    const adminUser = db.prepare("SELECT * FROM users WHERE id = ?").get(adminId) as UserRow;
    const peer = await TestPeer.connect(app, projectId, adminCookie, {
      id: adminUser.id, username: adminUser.username, name: adminUser.display_name, permission: "owner"
    });
    try {
      const text = peer.doc.getText("source:main.tex");
      text.insert(0, "New dirty text\n");

      // Spy on writeFileSync to fail for main.tex temporary file
      const originalWriteFileSync = fs.writeFileSync.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
        if (String(file).includes("main.tex.collaboration")) {
          throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
        }
        return originalWriteFileSync(file, data, options as any);
      }) as typeof fs.writeFileSync);

      try {
        await expect(peer.flush()).rejects.toThrow(/Failed to persist|main\.tex/);
      } finally {
        writeSpy.mockRestore();
      }

      // After restoring writeFileSync, a subsequent flush succeeds
      const successfulReceipt = await peer.flush();
      expect(successfulReceipt.ok).toBe(true);
      expect(successfulReceipt.failedPaths).toEqual([]);
    } finally {
      peer.destroy();
    }
  });

  it("does not create a room when a collaborative source file cannot be read", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Unreadable source" }
    });
    const projectId = created.json().project.id as string;
    const sourcePath = path.join(config.projectsDir, projectId, "source", "main.tex");
    const service = new CollaborationService(config, db);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(adminId) as UserRow;
    let closeCode: number | null = null;
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(file)) === path.resolve(sourcePath)) {
        return Promise.reject(Object.assign(new Error("simulated read failure"), { code: "EIO" }));
      }
      return (originalReadFile as (...parameters: unknown[]) => unknown)(file, ...args);
    }) as never);
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        close: (code: number) => { closeCode = code; }
      } as unknown as WebSocket;
      await service.connect(socket, projectId, user);
      expect(closeCode).toBe(1011);
      expect(service.stats()).toMatchObject({ rooms: 0, initializing: 0 });
    } finally {
      vi.restoreAllMocks();
      service.destroy();
    }
  });

  it("does not treat a missing source root as an empty collaborative project", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Missing source root" }
    });
    const projectId = created.json().project.id as string;
    const rootPath = path.join(config.projectsDir, projectId, "source");
    const hiddenPath = `${rootPath}-temporarily-missing`;
    const recovered = new Y.Doc();
    recovered.getText("source:main.tex").insert(0, "recovered draft must remain durable");
    fs.mkdirSync(path.dirname(collaborationStatePath(config, projectId)), { recursive: true });
    const durableState = Buffer.from(Y.encodeStateAsUpdate(recovered));
    fs.writeFileSync(collaborationStatePath(config, projectId), durableState);
    fs.writeFileSync(collaborationEpochPath(config, projectId), randomUUID());
    recovered.destroy();
    const service = new CollaborationService(config, db);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(adminId) as UserRow;
    let closeCode: number | null = null;
    fs.renameSync(rootPath, hiddenPath);
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        close: (code: number) => { closeCode = code; }
      } as unknown as WebSocket;
      await service.connect(socket, projectId, user);
      expect(closeCode).toBe(1011);
      expect(service.stats()).toMatchObject({ rooms: 0, initializing: 0 });
      expect(fs.readFileSync(collaborationStatePath(config, projectId))).toEqual(durableState);
    } finally {
      fs.renameSync(hiddenPath, rootPath);
      service.destroy();
    }
  });

  it("fails cold initialization on a collaboration-state I/O error", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "State read failure" }
    });
    const projectId = created.json().project.id as string;
    const statePath = collaborationStatePath(config, projectId);
    const service = new CollaborationService(config, db);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(adminId) as UserRow;
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(file)) === path.resolve(statePath)) {
        return Promise.reject(Object.assign(new Error("simulated state I/O failure"), { code: "EIO" }));
      }
      return (originalReadFile as (...parameters: unknown[]) => unknown)(file, ...args);
    }) as never);
    let closeCode: number | null = null;
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        close: (code: number) => { closeCode = code; }
      } as unknown as WebSocket;
      await service.connect(socket, projectId, user);
      expect(closeCode).toBe(1011);
      expect(service.stats()).toMatchObject({ rooms: 0, initializing: 0 });
    } finally {
      vi.restoreAllMocks();
      service.destroy();
    }
  });

  it("invalidates a room initialization that races with project reset", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Initialization race" }
    });
    const projectId = created.json().project.id as string;
    const service = new CollaborationService(config, db);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(adminId) as UserRow;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loadStarted = new Promise<void>((resolve) => { started = resolve; });
    const originalLoad = (service as unknown as { loadRoomBootstrap: (id: string) => Promise<unknown> }).loadRoomBootstrap.bind(service);
    vi.spyOn(service as unknown as { loadRoomBootstrap: (id: string) => Promise<unknown> }, "loadRoomBootstrap")
      .mockImplementation(async (id) => {
        started();
        await gate;
        return originalLoad(id);
      });
    let closeCode: number | null = null;
    const socket = {
      readyState: WebSocket.OPEN,
      close: (code: number) => { closeCode = code; }
    } as unknown as WebSocket;
    try {
      const connecting = service.connect(socket, projectId, user);
      await loadStarted;
      service.resetProject(projectId);
      release();
      await connecting;
      expect(closeCode).toBe(1011);
      expect(service.stats()).toMatchObject({ rooms: 0, initializing: 0 });
    } finally {
      vi.restoreAllMocks();
      service.destroy();
    }
  });

  it("closes active sessions while a project-wide replacement replaces the source tree", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Exclusive replacement" }
    });
    const projectId = created.json().project.id as string;
    const peer = await TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" });
    try {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/search/replace`, headers: { cookie: adminCookie },
        payload: { query: "Start writing", replacement: "Start collaborating" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ replacements: 1, files: ["main.tex"] });
      await waitFor(() => !peer.connected);
      expect(fs.readFileSync(path.join(config.projectsDir, projectId, "source", "main.tex"), "utf8"))
        .toContain("Start collaborating");
    } finally { peer.destroy(); }
  });

  it("keeps active sessions connected when an exclusive move fails validation", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: "Invalid move" }
    });
    const projectId = created.json().project.id as string;
    const peer = await TestPeer.connect(app, projectId, adminCookie, { id: adminId, username: "admin", name: "Administrator" });
    try {
      const response = await app.inject({
        method: "PATCH", url: `/api/projects/${projectId}/path`, headers: { cookie: adminCookie },
        payload: { source: "missing.tex", destinationDirectory: "" }
      });
      expect(response.statusCode).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(peer.connected).toBe(true);
    } finally { peer.destroy(); }
  });
});

interface PeerUser { id: string; username: string; name: string }

class TestPeer {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  pauseUpdates = false;
  readonly permissionChanges: string[] = [];
  private socket: WebSocket | null = null;
  private readonly queuedUpdates: Uint8Array[] = [];
  private syncResolve: (() => void) | null = null;
  private readonly synced = new Promise<void>((resolve) => { this.syncResolve = resolve; });
  private readonly flushRequests = new Map<string, { resolve: (receipt: { revision: number; persistedAt: string; ok: boolean; failedPaths: string[] }) => void; reject: (err: Error) => void }>();

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

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

  flush(): Promise<{ revision: number; persistedAt: string; ok: boolean; failedPaths: string[] }> {
    const requestId = randomUUID();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_FLUSH);
    encoding.writeVarString(encoder, requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("flush timeout")), 2000);
      this.flushRequests.set(requestId, {
        resolve: (receipt) => { clearTimeout(timer); resolve(receipt); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
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
      const ok = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) === 1 : true;
      const revision = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : 0;
      const persistedAt = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : new Date(0).toISOString();
      const failedCount = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : 0;
      const failedPaths: string[] = [];
      for (let i = 0; i < failedCount; i++) {
        failedPaths.push(decoding.readVarString(decoder));
      }
      const pending = this.flushRequests.get(requestId);
      if (pending) {
        this.flushRequests.delete(requestId);
        if (!ok) {
          pending.reject(Object.assign(new Error(failedPaths.length ? `Failed to persist: ${failedPaths.join(", ")}` : "Save failed"), { failedPaths }));
        } else {
          pending.resolve({ revision, persistedAt, ok: true, failedPaths: [] });
        }
      }
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
    } else if (messageType === MESSAGE_PERMISSION) {
      const userId = decoding.readVarString(decoder);
      const permission = decoding.readVarString(decoder);
      if (userId === this.user.id) this.permissionChanges.push(permission);
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
