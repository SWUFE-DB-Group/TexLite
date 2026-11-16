import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app";
import { openDatabase, type DatabaseConnection } from "../src/server/db";
import { createSessionToken } from "../src/server/security";
import { sourceRoot } from "../src/server/files";
import { httpError } from "../src/server/http";
import { EMPTY_DRAWIO, type DrawioDocument } from "../src/shared/drawio";
import { createTestConfig } from "./helpers/testConfig";

const { render, close } = vi.hoisted(() => ({ render: vi.fn(), close: vi.fn() }));
vi.mock("../src/server/drawioPdf", () => ({ DrawioPdfRenderer: class { render = render; close = close; } }));
const changed = EMPTY_DRAWIO.replace("Page-1", "Changed");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>';

describe("draw.io project files and PDF export", () => {
  let root: string, app: FastifyInstance, db: DatabaseConnection, id: string;
  const cookies = new Map<string, string>();
  const config = () => createTestConfig(root, { basePath: "/tools/texlite" });
  const request = (method: "GET" | "PUT" | "POST", endpoint = "", payload?: object, user = "owner") => app.inject({
    method, url: `/tools/texlite/api/projects/${id}/drawio${endpoint}${method === "GET" ? "?path=figures%2Fdiagram.drawio" : ""}`,
    headers: { cookie: cookies.get(user) ?? "" }, payload
  });
  const document = async () => (await request("GET")).json<DrawioDocument>();
  const absolute = (name = "diagram.drawio") => path.join(sourceRoot(config(), id), "figures", name);

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
    fs.mkdirSync(path.dirname(absolute()), { recursive: true });
  });
  beforeEach(async () => {
    render.mockReset().mockResolvedValue(Buffer.from("%PDF-1.4\nfixture")); close.mockReset();
    // Use the normal file routes to keep collaboration's persisted state in sync.
    const exists = fs.existsSync(absolute());
    if (!exists) {
      expect((await app.inject({ method: "POST", url: `/tools/texlite/api/projects/${id}/file`, headers: { cookie: cookies.get("owner")! },
        payload: { path: "figures/diagram.drawio", content: EMPTY_DRAWIO } })).statusCode).toBe(201);
    } else {
      const before = await document();
      expect((await request("PUT", "", { path: "figures/diagram.drawio", content: EMPTY_DRAWIO, revision: before.revision })).statusCode).toBe(200);
    }
    fs.rmSync(absolute("diagram.pdf"), { force: true });
  });
  afterAll(async () => { await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("opens tracked .drawio text without running a browser, and saves with writer attribution", async () => {
    const before = (await request("GET", "", undefined, "reader")).json<DrawioDocument>();
    expect(before).toMatchObject({ content: EMPTY_DRAWIO, pdfRevision: null });
    expect(render).not.toHaveBeenCalled();
    const result = await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: changed }, "writer");
    expect(result.statusCode).toBe(200); expect(result.json().revision).not.toBe(before.revision);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
    expect(db.prepare("SELECT last_modified_by FROM projects WHERE id = ?").get(id)).toEqual({ last_modified_by: "writer" });
  });

  it("rejects stale saves and never recreates a deleted diagram", async () => {
    const before = await document();
    expect((await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: changed })).statusCode).toBe(200);
    expect((await request("PUT", "", { path: "figures/diagram.drawio", revision: before.revision, content: EMPTY_DRAWIO })).statusCode).toBe(409);
    expect(fs.readFileSync(absolute(), "utf8")).toBe(changed);
    expect((await request("PUT", "", { path: "figures/missing.drawio", revision: before.revision, content: changed })).statusCode).toBe(404);
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
    const before = await document();
    const payload = { path: "figures/diagram.drawio", revision: before.revision, pdfRevision: null, svg };
    const result = await request("POST", "/pdf", payload, "writer");
    expect(result.statusCode).toBe(200); expect(result.json().path).toBe("figures/diagram.pdf");
    expect(fs.readFileSync(absolute("diagram.pdf"), "utf8")).toContain("%PDF-");
    expect(render).toHaveBeenCalledWith(svg, undefined, expect.any(AbortSignal));
    expect((await request("POST", "/pdf", payload)).statusCode).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
    expect((await request("POST", "/pdf", { ...payload, pdfRevision: result.json().pdfRevision })).statusCode).toBe(200);
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

  it("allows edits during rendering, but refuses to publish a PDF for an obsolete source revision", async () => {
    const before = await document();
    render.mockImplementationOnce(async () => {
      const edit = await request("PUT", "", { path: "figures/diagram.drawio", content: changed, revision: before.revision }, "writer");
      expect(edit.statusCode).toBe(200);
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
});
