import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app";
import { CollaborationService } from "../src/server/collaboration";
import { openDatabase, type DatabaseConnection } from "../src/server/db";
import { createSessionToken } from "../src/server/security";
import { sourceRoot } from "../src/server/files";
import { httpError } from "../src/server/http";
import { DRAWIO_LOCK_HEADER, EMPTY_DRAWIO, type DrawioDocument } from "../src/shared/drawio";
import { createTestConfig } from "./helpers/testConfig";
import { once } from "node:events";
import { Socket } from "node:net";
import type WebSocket from "ws";

const { render, close } = vi.hoisted(() => ({ render: vi.fn(), close: vi.fn() }));
vi.mock("../src/server/drawioPdf", () => ({ DrawioPdfRenderer: class { render = render; close = close; } }));
const changed = EMPTY_DRAWIO.replace("Page-1", "Changed");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>';

describe("draw.io project files and PDF export", () => {
  let root: string, app: FastifyInstance, db: DatabaseConnection, id: string;
  let lease: { socket: WebSocket; token: string; user: string } | null = null;
  const cookies = new Map<string, string>();
  const config = () => createTestConfig(root, { basePath: "/tools/texlite" });
  const request = (method: "GET" | "PUT" | "POST", endpoint = "", payload?: object, user = "owner") => app.inject({
    method, url: `/tools/texlite/api/projects/${id}/drawio${endpoint}${method === "GET" ? "?path=figures%2Fdiagram.drawio" : ""}`,
    headers: { cookie: cookies.get(user) ?? "" }, payload: payload ? { lockToken: lease?.token, ...payload } : undefined
  });
  const document = async () => (await request("GET")).json<DrawioDocument>();
  const absolute = (name = "diagram.drawio") => path.join(sourceRoot(config(), id), "figures", name);
  const release = async () => {
    if (!lease) return;
    const socket = lease.socket; lease = null;
    if (socket.readyState === 3) return;
    const closed = once(socket, "close");
    if (socket.readyState === 1) socket.send("release"); else socket.close();
    await closed;
  };
  const acquire = async (user = "owner") => {
    await release();
    const messages: Array<{ type: string; token: string }> = [];
    const socket = await app.injectWS(`/tools/texlite/api/projects/${id}/drawio/lock?path=figures%2Fdiagram.drawio`, {
      headers: { cookie: cookies.get(user)!, host: "localhost", origin: "http://localhost" }, socket: new Socket()
    }, { onInit: (client) => client.on("message", (raw) => messages.push(JSON.parse(raw.toString()))) });
    await vi.waitFor(() => expect(messages[0]?.type).toBe("acquired"));
    lease = { socket, token: messages[0].token, user };
    return lease;
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-drawio-")); db = openDatabase(config());
    const time = new Date().toISOString();
    for (const user of ["owner", "writer", "reader", "outsider"]) {
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, must_change_password, created_at)
        VALUES (?, ?, ?, 'hash', 'user', 1, 0, ?)`).run(user, user, user, time);
      const session = createSessionToken();
      db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, '2099-01-01', ?)").run(session.digest, user, time);
      cookies.set(user, `texlite_session=${session.token}`);
    }
    app = await buildApp(config(), db, { logger: false });
    const created = await app.inject({ method: "POST", url: "/tools/texlite/api/projects", headers: { cookie: cookies.get("owner")! }, payload: { name: "Diagrams" } });
    expect(created.statusCode).toBe(201); id = created.json().project.id;
    for (const [user, permission] of [["reader", "read"], ["writer", "edit"]]) {
      db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)").run(id, user, permission, time);
    }
    // The normal creation route must also create the missing figures/ directory.
  });
  beforeEach(async () => {
    await release();
    render.mockReset().mockResolvedValue(Buffer.from("%PDF-1.4\nfixture")); close.mockReset();
    // Use the normal file routes to keep collaboration's persisted state in sync.
    const exists = fs.existsSync(absolute());
    if (!exists) {
      expect((await app.inject({ method: "POST", url: `/tools/texlite/api/projects/${id}/file`, headers: { cookie: cookies.get("owner")! },
        payload: { path: "figures/diagram.drawio", content: EMPTY_DRAWIO } })).statusCode).toBe(201);
    } else {
      await acquire();
      const before = await document();
      expect((await request("PUT", "", { path: "figures/diagram.drawio", content: EMPTY_DRAWIO, revision: before.revision })).statusCode).toBe(200);
    }
    if (!lease) await acquire();
    fs.rmSync(absolute("diagram.pdf"), { force: true });
  });
  afterAll(async () => { await release(); await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("opens tracked .drawio text without running a browser, and saves with writer attribution", async () => {
    await acquire("writer");
    const before = (await request("GET", "", undefined, "reader")).json<DrawioDocument>();
    expect(before).toMatchObject({ content: EMPTY_DRAWIO, pdfRevision: null });
    expect(render).not.toHaveBeenCalled();
    const result = await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: changed }, "writer");
    expect(result.statusCode).toBe(200); expect(result.json().revision).not.toBe(before.revision);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
    expect(db.prepare("SELECT last_modified_by FROM projects WHERE id = ?").get(id)).toEqual({ last_modified_by: "writer" });
    const snapshots = () => db.prepare("SELECT id FROM project_history_versions WHERE project_id = ? AND reason = 'autosave'").all(id);
    const first = snapshots();
    expect(first.length).toBeGreaterThan(0);
    const newer = changed.replace("Changed", "Even newer");
    expect(newer).not.toBe(changed);
    expect((await request("PUT", "", { path: "figures/diagram.drawio", revision: result.json().revision, content: newer }, "writer")).statusCode).toBe(200);
    expect(snapshots()).toEqual(first); // Nearby autosaves coalesce like source edits.
  });

  it("reads diagrams behind the filesystem barrier without waiting for Yjs hydration", async () => {
    const hydration = vi.spyOn(CollaborationService.prototype, "waitForReady").mockRejectedValue(new Error("Room is still loading"));
    const flush = vi.spyOn(CollaborationService.prototype, "flushProject");
    try {
      const response = await request("GET", "", undefined, "reader");
      expect(response.statusCode).toBe(200);
      expect(response.json().content).toBe(EMPTY_DRAWIO);
      expect(hydration).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledWith(id);
    } finally { hydration.mockRestore(); flush.mockRestore(); }
  });

  it("rejects stale saves and never recreates a deleted diagram", async () => {
    const before = await document();
    const payload = { path: "figures/diagram.drawio", revision: before.revision, content: changed };
    const saved = await request("PUT", "", payload);
    expect(saved.statusCode).toBe(200);
    const retried = await request("PUT", "", payload);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(saved.json());
    expect((await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: EMPTY_DRAWIO })).statusCode).toBe(409);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
    expect((await request("PUT", "", { path: "figures/missing.drawio", revision: before.revision, content: changed })).statusCode).toBe(409);
    expect(fs.existsSync(absolute("missing.drawio"))).toBe(false);
  });

  it("forbids anonymous/outsider access and read-only source or host execution, before invoking the browser", async () => {
    const before = await document();
    const payload = { path: "figures/diagram.drawio", content: changed, revision: before.revision, pdfRevision: null, svg };
    for (const [user, expected] of [["anonymous", 401], ["outsider", 404], ["reader", 403]] as const) {
      expect((await request("PUT", "", payload, user)).statusCode).toBe(expected);
      expect((await request("POST", "/pdf", payload, user)).statusCode).toBe(expected);
    }
    expect((await request("GET", "", undefined, "anonymous")).statusCode).toBe(401);
    expect((await request("GET", "", undefined, "outsider")).statusCode).toBe(404);
    expect(render).not.toHaveBeenCalled();
  });

  it("writes PDF beside the diagram, requires an explicit current output revision to replace it, and refreshes the source tree", async () => {
    await acquire("writer");
    const before = await document();
    const payload = { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg };
    const result = await request("POST", "/pdf", payload, "writer");
    expect(result.statusCode).toBe(200); expect(result.json().path).toBe("figures/diagram.pdf");
    expect(fs.readFileSync(absolute("diagram.pdf"), "utf8")).toContain("%PDF-");
    expect(render).toHaveBeenCalledWith(svg, undefined, expect.any(AbortSignal));
    expect((await request("POST", "/pdf", payload, "writer")).statusCode).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
    expect((await request("POST", "/pdf", { ...payload, pdfRevision: result.json().pdfRevision }, "writer")).statusCode).toBe(200);
  });

  it("rechecks source/output revisions and membership after rendering, leaving existing PDFs untouched", async () => {
    const before = await document();
    const payload = { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg };
    render.mockImplementationOnce(async () => {
      fs.writeFileSync(absolute("diagram.pdf"), "external PDF");
      return Buffer.from("%PDF-fixture");
    });
    expect((await request("POST", "/pdf", payload)).statusCode).toBe(409);
    expect(fs.readFileSync(absolute("diagram.pdf"), "utf8")).toBe("external PDF");
    const current = await document();
    await acquire("writer");
    render.mockImplementationOnce(async () => {
      db.prepare("UPDATE project_members SET permission = 'read' WHERE project_id = ? AND user_id = 'writer'").run(id);
      return Buffer.from("%PDF-fixture");
    });
    try {
      expect((await request("POST", "/pdf", { ...payload, pdfRevision: current.pdfRevision }, "writer")).statusCode).toBe(403);
      expect(fs.readFileSync(absolute("diagram.pdf"), "utf8")).toBe("external PDF");
    } finally { db.prepare("UPDATE project_members SET permission = 'edit' WHERE project_id = ? AND user_id = 'writer'").run(id); }
  });

  it("reports an optional missing browser and supports retry without changing the source", async () => {
    const before = await document();
    render.mockRejectedValueOnce(httpError(503, "DRAWIO_BROWSER_UNAVAILABLE"));
    const payload = { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg };
    const failed = await request("POST", "/pdf", payload);
    expect(failed.statusCode).toBe(503); expect(failed.json().code).toBe("DRAWIO_BROWSER_UNAVAILABLE");
    expect(fs.existsSync(absolute("diagram.pdf"))).toBe(false);
    expect((await request("POST", "/pdf", payload)).statusCode).toBe(200);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(EMPTY_DRAWIO);
  });

  it("allows ordinary text edits during rendering, but refuses a PDF after an external diagram change", async () => {
    const before = await document();
    render.mockImplementationOnce(async () => {
      const edit = await app.inject({ method: "PUT", url: `/tools/texlite/api/projects/${id}/file`, headers: { cookie: cookies.get("writer")! }, payload: { path: "main.tex", content: "text during diagram export" } });
      expect(edit.statusCode).toBe(200);
      fs.writeFileSync(absolute(), changed); // An external host tool does not use TexLite's lease.
      return Buffer.from("%PDF-fixture");
    });
    const result = await request("POST", "/pdf", { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg });
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe("DRAWIO_CONFLICT");
    expect(fs.existsSync(absolute("diagram.pdf"))).toBe(false);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
  });

  it("rejects traversal, non-diagrams, malformed XML and invalid SVG payloads", async () => {
    const before = await document();
    for (const file of ["../private.drawio", "figures/diagram.pdf", ".git/test.drawio"]) {
      expect((await request("PUT", "", { path: file, content: changed, revision: before.revision })).statusCode).toBe(400);
    }
    for (const content of ["", "<script/>", "<!DOCTYPE x><mxfile/>", "<mxfile>\0</mxfile>"]) {
      expect((await request("PUT", "", { path: "figures/diagram.drawio", content, revision: before.revision })).statusCode).toBe(400);
    }
    expect((await request("POST", "/pdf", { path: "figures/diagram.drawio", svg: "https://localhost/", revision: before.revision, pdfRevision: null })).statusCode).toBe(400);
    expect(render).not.toHaveBeenCalled();
  });

  it("requires the live connection's token and refuses a second tab, even for the same user", async () => {
    const before = await document(), oldToken = lease!.token;
    const messages: Array<{ type: string; name: string }> = [];
    const second = await app.injectWS(`/tools/texlite/api/projects/${id}/drawio/lock?path=figures/diagram.drawio`, {
      headers: { cookie: cookies.get("owner")!, host: "localhost", origin: "http://localhost" }, socket: new Socket()
    }, { onInit: (client) => client.on("message", (raw) => messages.push(JSON.parse(raw.toString()))) });
    await vi.waitFor(() => expect(messages[0]).toEqual({ type: "busy", name: "owner" }));
    await vi.waitFor(() => expect(second.readyState).toBe(3));
    for (const lockToken of [undefined, "forged"]) {
      expect((await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision, lockToken })).json().code).toBe("DRAWIO_LOCK_LOST");
    }
    await acquire();
    expect(lease!.token).not.toBe(oldToken);
    expect((await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision, lockToken: oldToken })).statusCode).toBe(409);
    expect((await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision })).statusCode).toBe(200);
  });

  it("rejects read-only, anonymous and cross-origin lock connections without disturbing the owner", async () => {
    for (const [user, origin] of [["reader", "http://localhost"], ["anonymous", "http://localhost"], ["owner", "http://evil.test"]]) {
      const denied = await app.injectWS(`/tools/texlite/api/projects/${id}/drawio/lock?path=figures/diagram.drawio`, {
        headers: { cookie: cookies.get(user) ?? "", host: "localhost", origin }, socket: new Socket()
      });
      await vi.waitFor(() => expect(denied.readyState).toBe(3));
    }
    const before = await document();
    expect((await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision })).statusCode).toBe(200);
  });

  it("blocks generic XML writes, moving/deleting locked files or their parent, and overwrite uploads", async () => {
    const prefix = `/tools/texlite/api/projects/${id}`, headers = { cookie: cookies.get("owner")! };
    for (const target of ["figures", "figures/diagram.drawio", "figures/diagram.pdf"]) {
      const result = await app.inject({ method: "DELETE", url: `${prefix}/file?path=${encodeURIComponent(target)}`, headers });
      expect(result.statusCode).toBe(409); expect(result.json().code).toBe("DRAWIO_LOCKED");
    }
    expect((await app.inject({ method: "PATCH", url: `${prefix}/path`, headers, payload: { source: "figures", destinationDirectory: "", destinationName: "moved" } })).json().code).toBe("DRAWIO_LOCKED");
    expect((await app.inject({ method: "PUT", url: `${prefix}/file`, headers, payload: { path: "figures/diagram.drawio", content: changed } })).statusCode).toBe(400);
    const boundary = "drawio-upload";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="diagram.drawio"\r\nContent-Type: application/xml\r\n\r\n${changed}\r\n--${boundary}--\r\n`;
    const upload = () => app.inject({ method: "POST", url: `${prefix}/upload?directory=figures&overwrite=1`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect((await upload()).json().code).toBe("DRAWIO_LOCKED");
    expect(fs.readFileSync(absolute(), "utf8")).toBe(EMPTY_DRAWIO);
    await release();
    expect((await upload()).statusCode).toBe(201);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
  });

  it("cannot publish a late PDF after its lease was released and a successor acquired the same file", async () => {
    const before = await document(), oldToken = lease!.token;
    render.mockImplementationOnce(async () => { await acquire("writer"); return Buffer.from("%PDF-late"); });
    const result = await request("POST", "/pdf", { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg, lockToken: oldToken });
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe("DRAWIO_LOCK_LOST");
    expect(fs.existsSync(absolute("diagram.pdf"))).toBe(false);
    expect((await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision }, "writer")).statusCode).toBe(200);
  });

  it.each(["figures/diagram.drawio", "figures"])("deletes %s with the originating writer's live lease and fences late autosaves", async (target) => {
    const { token, socket } = await acquire("writer");
    const before = await document();
    fs.writeFileSync(absolute("diagram.pdf"), "%PDF-fixture");
    const remove = (user: string, lockToken: string, file = target) => app.inject({
      method: "DELETE", url: `/tools/texlite/api/projects/${id}/file?path=${encodeURIComponent(file)}`,
      headers: { cookie: cookies.get(user)!, [DRAWIO_LOCK_HEADER]: lockToken }
    });
    expect((await remove("reader", token)).statusCode).toBe(403);
    expect((await remove("owner", token)).json().code).toBe("DRAWIO_LOCKED");
    expect((await remove("writer", "stale-token")).json().code).toBe("DRAWIO_LOCKED");
    expect((await remove("writer", token, "figures/diagram.pdf")).json().code).toBe("DRAWIO_LOCKED");
    expect(fs.existsSync(absolute())).toBe(true);
    const closed = once(socket, "close");
    expect((await remove("writer", token)).statusCode).toBe(200);
    await closed;
    expect((await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: changed }, "writer")).json().code).toBe("DRAWIO_LOCK_LOST");
    expect(fs.existsSync(absolute())).toBe(false);
    expect(fs.existsSync(absolute("diagram.pdf"))).toBe(target !== "figures");
  });

  it("closes active lock sockets on server shutdown, and accepts only new ownership after restart", async () => {
    const socket = lease!.socket, oldToken = lease!.token;
    const closed = once(socket, "close");
    await app.close(); await closed; lease = null;
    app = await buildApp(config(), db, { logger: false });
    const before = await document();
    const stale = await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision, lockToken: oldToken });
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("DRAWIO_LOCK_LOST");
    await acquire(); expect(lease!.token).not.toBe(oldToken);
  });
});
