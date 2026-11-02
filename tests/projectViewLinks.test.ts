import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { buildApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { createSessionToken } from "../src/server/security.js";
import { sourceRoot } from "../src/server/files.js";
import { captureCompileSnapshot, publishCompileArtifacts } from "../src/server/compiler.js";
import { CollaborationService } from "../src/server/collaboration.js";
import { ProjectMutationCoordinator } from "../src/server/projectMutations.js";
import { VIEW_LINK_KEY_FILE } from "../src/server/viewLinkTokens.js";
import type { CreatedProjectViewLink, SharedProjectData } from "../src/shared/projectViewLinks.js";

let root: string, config: Config, db: DatabaseConnection, app: FastifyInstance, projectId: string;
const prefix = "/tools/texlite";
const sessions = new Map<string, string>();
const source = "\\documentclass{article}\n\\begin{document}Hello.\\end{document}\n";
const ownerUrl = (suffix = "") => `${prefix}/api/projects/${projectId}/view-links${suffix}`;
function call(method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie = "", payload?: unknown) {
  return app.inject({ method, url, headers: { cookie }, payload: payload as object });
}
async function create(payload?: object, targetProjectId = projectId): Promise<CreatedProjectViewLink> {
  const response = await call("POST", `${prefix}/api/projects/${targetProjectId}/view-links`, sessions.get("owner"), payload ?? {});
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}
async function otherProject(): Promise<string> {
  const result = await call("POST", `${prefix}/api/projects`, sessions.get("owner"), { name: "Other project" });
  expect(result.statusCode).toBe(201);
  return result.json().project.id;
}
function parts(link: CreatedProjectViewLink) {
  return { token: link.path.split("#")[1], url: `${prefix}/api/shared/${link.link.id}` };
}
async function grant(link: CreatedProjectViewLink): Promise<string> {
  const { token, url } = parts(link);
  const access = await call("POST", `${url}/access`, "", { token });
  expect(access.statusCode, access.body).toBe(200);
  const cookie = access.headers["set-cookie"];
  return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}
async function publish(text = "%PDF-1.4\nshared PDF\n"): Promise<string> {
  const run = randomUUID(), time = new Date().toISOString();
  db.prepare(`INSERT INTO compile_runs (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
    VALUES (?, ?, 'owner', 'main.tex', 'succeeded', 'compile log secret', ?, ?)`).run(run, projectId, time, time);
  const snapshot = await captureCompileSnapshot(config, projectId, run, { mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: [] });
  const pdf = path.join(snapshot.outputDir, "main.pdf"); fs.writeFileSync(pdf, text);
  publishCompileArtifacts(config, projectId, snapshot, { ok: true, log: "ok", diagnostics: { warnings: [], errors: [] }, pdfPath: pdf, synctexPath: null });
  return run;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-view-links-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ storage: { dataDir: path.join(root, "data") }, server: { basePath: prefix }, updates: { enabled: false } }));
  config = loadConfig(file); config.clientDir = path.join(root, "client"); db = openDatabase(config); sessions.clear();
  fs.mkdirSync(config.clientDir, { recursive: true });
  fs.writeFileSync(path.join(config.clientDir, "index.html"), "<html><head></head><body>TexLite</body></html>");
  for (const id of ["owner", "writer", "reader", "admin"]) {
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, created_at) VALUES (?, ?, ?, 'hash', ?, 1, ?)")
      .run(id, id, id, id === "admin" || id === "owner" ? "admin" : "user", new Date().toISOString());
    const session = createSessionToken();
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, '2099-01-01', ?)").run(session.digest, id, new Date().toISOString());
    sessions.set(id, `texlite_session=${session.token}`);
  }
  app = await buildApp(config, db, { logger: false }); await app.ready();
  const response = await call("POST", `${prefix}/api/projects`, sessions.get("owner"), { name: "Shared paper" });
  expect(response.statusCode, response.body).toBe(201); projectId = response.json().project.id;
  for (const [id, permission] of [["writer", "edit"], ["reader", "read"]]) {
    db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)").run(projectId, id, permission, new Date().toISOString());
  }
  fs.writeFileSync(path.join(sourceRoot(config, projectId), "main.tex"), source);
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("anonymous project reading", () => {
  it("creates unpredictable fragment tokens, stores recoverable secrets encrypted and leaves memberships unchanged", async () => {
    const usersBefore = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    const sessionsBefore = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    const a = await create({ label: "Reviewer" }), b = await create({}, await otherProject());
    expect(a.path).toMatch(new RegExp(`^${prefix}/share/${a.link.id}#[A-Za-z0-9_-]{43}$`));
    expect(parts(a).token).not.toBe(parts(b).token);
    expect(Date.parse(a.link.expiresAt!) - Date.now()).toBeGreaterThan(6.99 * 24 * 3600_000);
    const listed = await call("GET", ownerUrl(), sessions.get("owner"));
    expect(listed.json().links).toHaveLength(1);
    expect(listed.json().links.find((link: { id: string }) => link.id === a.link.id).path).toBe(a.path);
    expect(listed.body).not.toContain("token_hash");
    expect(listed.body).not.toContain("token_ciphertext");
    expect(JSON.stringify(db.prepare("SELECT * FROM project_view_links").all())).not.toContain(parts(a).token);
    await grant(a); await grant(b);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual(usersBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(sessionsBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").get(projectId)).toEqual({ n: 2 });
  });

  it("lets only the owner repeatedly copy an unchanged link, including after a server restart", async () => {
    const link = await create();
    const before = db.prepare("SELECT * FROM project_view_links WHERE id = ?").get(link.link.id);
    const keyPath = path.join(config.dataDir, VIEW_LINK_KEY_FILE), key = fs.readFileSync(keyPath);
    expect(key.length).toBe(32);
    if (process.platform !== "win32") expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    for (let attempt = 0; attempt < 2; attempt++) {
      const listed = await call("GET", ownerUrl(), sessions.get("owner"));
      expect(listed.json().links[0].path).toBe(link.path);
      expect(db.prepare("SELECT * FROM project_view_links WHERE id = ?").get(link.link.id)).toEqual(before);
    }
    await app.close(); app = await buildApp(config, db, { logger: false }); await app.ready();
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).json().links[0].path).toBe(link.path);
    expect(fs.readFileSync(keyPath)).toEqual(key);
    expect((await call("GET", parts(link).url, await grant(link))).statusCode).toBe(200);
    expect((await call("GET", ownerUrl(), sessions.get("reader"))).statusCode).toBe(403);
  });

  it("creates only one active link for concurrent requests and leaves it unchanged on retries", async () => {
    const results = await Promise.all([
      call("POST", ownerUrl(), sessions.get("owner"), { label: "First" }),
      call("POST", ownerUrl(), sessions.get("owner"), { label: "Second", expiresAt: null })
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json().code).toBe("VIEW_LINK_EXISTS");
    const created = results.find((result) => result.statusCode === 201)!.json<CreatedProjectViewLink>();
    const before = db.prepare("SELECT * FROM project_view_links WHERE project_id = ?").all(projectId);
    expect(before).toHaveLength(1);
    const retry = await call("POST", ownerUrl(), sessions.get("owner"), { expiresAt: null });
    expect(retry.statusCode).toBe(409);
    expect(db.prepare("SELECT * FROM project_view_links WHERE project_id = ?").all(projectId)).toEqual(before);
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).json().links).toEqual([created.link]);
    expect((await call("GET", parts(created).url, await grant(created))).statusCode).toBe(200);
  });

  it("treats a non-expiring link as active until deletion", async () => {
    const forever = await create({ expiresAt: null });
    expect((await call("POST", ownerUrl(), sessions.get("owner"), {})).statusCode).toBe(409);
    await call("DELETE", ownerUrl(`/${forever.link.id}`), sessions.get("owner"));
    const next = await create();
    expect(next.path).not.toBe(forever.path);
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).json().links).toEqual([next.link]);
  });

  it("allows a replacement after expiry but does not let the expired row hide the new active link", async () => {
    const expired = await create();
    db.prepare("UPDATE project_view_links SET expires_at = ? WHERE id = ?").run(new Date().toISOString(), expired.link.id);
    const current = await create();
    expect(current.path).not.toBe(expired.path);
    expect((await call("POST", ownerUrl(), sessions.get("owner"), {})).statusCode).toBe(409);
    const listed = (await call("GET", ownerUrl(), sessions.get("owner"))).json().links;
    expect(listed).toHaveLength(2);
    expect(listed.find((item: { id: string }) => item.id === current.link.id).path).toBe(current.path);
  });

  it("preserves non-recoverable links and keeps deletion available without changing their credentials", async () => {
    const legacy = await create(), other = await create({}, await otherProject()), cookie = await grant(legacy);
    const originalCiphertext = (db.prepare("SELECT token_ciphertext FROM project_view_links WHERE id = ?").get(legacy.link.id) as { token_ciphertext: string }).token_ciphertext;
    const otherCiphertext = (db.prepare("SELECT token_ciphertext FROM project_view_links WHERE id = ?").get(other.link.id) as { token_ciphertext: string }).token_ciphertext;
    db.prepare("UPDATE project_view_links SET token_ciphertext = NULL WHERE id = ?").run(legacy.link.id);
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).json().links.find((item: { id: string }) => item.id === legacy.link.id).path).toBeNull();
    expect((await call("GET", parts(legacy).url, cookie)).statusCode).toBe(200);
    db.prepare("UPDATE project_view_links SET token_ciphertext = ? WHERE id = ?").run(otherCiphertext, legacy.link.id);
    const listed = (await call("GET", ownerUrl(), sessions.get("owner"))).json().links;
    expect(listed.find((item: { id: string }) => item.id === legacy.link.id).path).toBeNull();
    expect((await call("GET", parts(legacy).url, cookie)).statusCode).toBe(200);
    expect((await call("POST", ownerUrl(), sessions.get("owner"), {})).statusCode).toBe(409);
    db.prepare("UPDATE project_view_links SET token_ciphertext = ? WHERE id = ?").run(originalCiphertext, legacy.link.id);
    const key = path.join(config.dataDir, VIEW_LINK_KEY_FILE), backup = `${key}.backup`;
    fs.renameSync(key, backup);
    try {
      const withoutKey = await call("GET", ownerUrl(), sessions.get("owner"));
      expect(withoutKey.statusCode).toBe(200);
      expect(withoutKey.json().links.every((item: { path: string | null }) => item.path === null)).toBe(true);
      expect(fs.existsSync(key)).toBe(false);
      expect((await call("GET", parts(legacy).url, cookie)).statusCode).toBe(200);
    } finally { fs.renameSync(backup, key); }
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).json().links[0].path).toBe(legacy.path);
    await call("DELETE", ownerUrl(`/${legacy.link.id}`), sessions.get("owner"));
    const replacement = await create();
    expect(replacement.path).not.toBe(legacy.path);
    expect((await call("GET", parts(legacy).url, cookie)).statusCode).toBe(410);
  });

  it("limits link management to the actual owner", async () => {
    const link = await create();
    for (const user of ["writer", "reader", "admin", ""]) {
      const cookie = sessions.get(user) ?? "";
      for (const [method, suffix] of [["GET", ""], ["POST", ""], ["DELETE", `/${link.link.id}`]] as const) {
        const result = await call(method, ownerUrl(suffix), cookie, method === "POST" ? {} : undefined);
        expect(result.statusCode, `${user} ${method}: ${result.body}`).toBe(user === "admin" ? 404 : user ? 403 : 401);
      }
    }
  });

  it("exchanges the secret for a narrow HttpOnly cookie, not a login", async () => {
    const link = await create(), { url, token } = parts(link);
    const result = await call("POST", `${url}/access`, "", { token });
    const cookie = String(result.headers["set-cookie"]);
    expect(cookie).toContain(`Path=${url}`);
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("texlite_session=");
    const https = await app.inject({ method: "POST", url: `${url}/access`, headers: { "x-forwarded-proto": "https" }, payload: { token } });
    expect(String(https.headers["set-cookie"])).toContain("Secure");
    const page = await call("GET", link.path.split("#")[0]);
    expect(page.statusCode).toBe(200); expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-robots-tag"]).toContain("noindex");
  });

  it("validates every resource independently and never treats owner login or URL tokens as a grant", async () => {
    const link = await create(), { url, token } = parts(link);
    for (const suffix of ["", "/file?path=main.tex", "/resource?path=photo.svg", "/pdf?version=nope"]) {
      for (const cookie of ["", sessions.get("owner")!]) {
        const result = await call("GET", url + suffix, cookie);
        expect(result.statusCode).toBe(410); expect(result.headers["cache-control"]).toBe("private, no-store");
      }
    }
    expect((await call("GET", `${url}?token=${token}`)).statusCode).toBe(410);
    expect((await call("POST", `${url}/access`, "", { token: token.slice(0, -1) + "!" })).statusCode).toBe(410);
    expect((await call("POST", `${url}/access`, await grant(link), {})).statusCode).toBe(410);
  });

  it("exposes source, safe images and the current published PDF but no project credentials", async () => {
    const connect = vi.spyOn(CollaborationService.prototype, "connect");
    const link = await create(), { url } = parts(link), cookie = await grant(link);
    fs.writeFileSync(path.join(sourceRoot(config, projectId), "photo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.mkdirSync(path.join(sourceRoot(config, projectId), ".git"));
    fs.writeFileSync(path.join(sourceRoot(config, projectId), ".git", "config"), "secret");
    const run = await publish();
    const response = await call("GET", url, cookie), data = response.json<SharedProjectData>();
    expect(response.statusCode, response.body).toBe(200);
    expect(data.project).toEqual({ name: "Shared paper", mainFile: "main.tex", engine: config.defaultEngine });
    expect(data.siteName).toBe(config.siteName);
    expect(data.outline).toEqual([]);
    expect(data.files.some((file) => file.path.includes(".git"))).toBe(false);
    expect(data.pdf?.url).toBe(`${url}/pdf?version=${run}`);
    expect(response.body).not.toContain("compile log secret"); expect(response.body).not.toContain("owner_id");
    expect(response.body).not.toContain(parts(link).token); expect(response.body).not.toContain("token_ciphertext");
    expect((await call("GET", `${url}/file?path=main.tex`, cookie)).json()).toEqual({ path: "main.tex", content: source });
    const svg = await call("GET", `${url}/resource?path=photo.svg`, cookie);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    expect((await call("GET", data.pdf!.url, cookie)).body).toContain("shared PDF");
    expect(connect).not.toHaveBeenCalled();
  });

  it("supports authenticated byte ranges and checks grants before HEAD, Range and conditional requests", async () => {
    const link = await create(), { url } = parts(link), cookie = await grant(link);
    const run = await publish("%PDF-1.4\n0123456789"), pdf = `${url}/pdf?version=${run}`;
    const range = await app.inject({ url: pdf, headers: { cookie, range: "bytes=0-3" } });
    expect(range.statusCode).toBe(206); expect(range.body).toBe("%PDF"); expect(range.headers["content-range"]).toBe("bytes 0-3/19");
    const invalid = await app.inject({ url: pdf, headers: { cookie, range: "bytes=900-1000" } });
    expect(invalid.statusCode).toBe(416);
    expect((await call("HEAD", pdf, cookie)).statusCode).toBe(200);
    await call("DELETE", ownerUrl(`/${link.link.id}`), sessions.get("owner"));
    for (const method of ["GET", "HEAD"] as const) {
      const denied = await app.inject({ method, url: pdf, headers: { cookie, range: "bytes=0-3", "if-none-match": "*" } });
      expect(denied.statusCode).toBe(410); expect(denied.headers["cache-control"]).toBe("private, no-store");
    }
  });

  it("returns the main document outline including project-local included files", async () => {
    const dir = sourceRoot(config, projectId);
    fs.writeFileSync(path.join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{Main}\n\\input{section}\n\\end{document}");
    fs.writeFileSync(path.join(dir, "section.tex"), "\\subsection{Included result}\n");
    const link = await create(), cookie = await grant(link);
    const response = await call("GET", parts(link).url, cookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SharedProjectData>().outline).toEqual([
      { path: "main.tex", line: 3, level: 1, title: "Main" },
      { path: "section.tex", line: 1, level: 2, title: "Included result" }
    ]);
  });

  it("rejects traversal, .git, source symlinks, directories and non-image inline resources", async () => {
    const link = await create(), { url } = parts(link), cookie = await grant(link);
    fs.writeFileSync(path.join(root, "outside.txt"), "host secret");
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(sourceRoot(config, projectId), "linked.txt"));
    fs.mkdirSync(path.join(sourceRoot(config, projectId), "folder"));
    for (const [relative, status] of [["../outside.txt", 400], ["/etc/passwd", 400], [".git/config", 400], ["linked.txt", 409], ["folder", 404]] as const) {
      const result = await call("GET", `${url}/file?path=${encodeURIComponent(relative)}`, cookie);
      expect(result.statusCode, result.body).toBe(status); expect(result.body).not.toContain("host secret");
    }
    expect((await call("GET", `${url}/resource?path=main.tex`, cookie)).statusCode).toBe(400);
    expect((await call("GET", `${url}/resource?path=evil.html`, cookie)).statusCode).toBe(400);
  });

  it("bounds text reads and rejects binary contents before oversized text warnings", async () => {
    const link = await create(), { url } = parts(link), cookie = await grant(link), dir = sourceRoot(config, projectId);
    fs.writeFileSync(path.join(dir, "binary.txt"), Buffer.alloc(6 * 1024 * 1024));
    fs.writeFileSync(path.join(dir, "large.txt"), "a".repeat(6 * 1024 * 1024));
    expect((await call("GET", `${url}/file?path=binary.txt`, cookie)).json().code).toBe("FILE_CONTENT_INVALID");
    expect((await call("GET", `${url}/file?path=large.txt`, cookie)).statusCode).toBe(413);
  });

  it("invalidates secrets and cookies on expiry and deletion without granting access to the next link", async () => {
    const link = await create(), { url, token } = parts(link), oldCookie = await grant(link);
    db.prepare("UPDATE project_view_links SET expires_at = '2000-01-01' WHERE id = ?").run(link.link.id);
    expect((await call("GET", `${url}/file?path=main.tex`, oldCookie)).statusCode).toBe(410);
    expect((await call("POST", `${url}/access`, "", { token })).statusCode).toBe(410);
    const forever = await create({ expiresAt: null }); expect(forever.link.expiresAt).toBeNull();
    expect(parts(forever).token).not.toBe(token);
    expect((await call("GET", parts(forever).url, oldCookie)).statusCode).toBe(410);
    const foreverCookie = await grant(forever);
    await call("DELETE", ownerUrl(`/${forever.link.id}`), sessions.get("owner"));
    expect((await call("GET", parts(forever).url, foreverCookie)).statusCode).toBe(410);
  });

  it("rejects past or malformed expiry and oversized labels", async () => {
    for (const payload of [{ expiresAt: "2000-01-01" }, { expiresAt: "invalid" }, { expiresAt: 123 }, { label: "x".repeat(81) }]) {
      expect((await call("POST", ownerUrl(), sessions.get("owner"), payload)).statusCode).toBe(400);
    }
  });

  it("deletes revoked links from storage and listings, rejects their capabilities and allows safe retries", async () => {
    const removed = await create({ label: "Remove me" });
    const cookie = await grant(removed), { token, url } = parts(removed);
    const target = ownerUrl(`/${removed.link.id}`);
    expect((await call("DELETE", target, sessions.get("owner"))).statusCode).toBe(200);
    expect(db.prepare("SELECT id FROM project_view_links WHERE id = ?").get(removed.link.id)).toBeUndefined();
    const retained = await create({ label: "Keep me" });
    const listed = await call("GET", ownerUrl(), sessions.get("owner"));
    expect(listed.json().links).toEqual([retained.link]);
    expect((await call("DELETE", target, sessions.get("owner"))).statusCode).toBe(200);
    for (const suffix of ["", "/access", "/file?path=main.tex", "/resource?path=photo.png", "/pdf?version=old"]) {
      expect((await call("GET", url + suffix, cookie)).statusCode).toBe(410);
    }
    expect((await call("POST", `${url}/access`, "", { token })).statusCode).toBe(410);
    const project = await call("POST", `${prefix}/api/projects`, sessions.get("owner"), { name: "Other project" });
    const foreign = await call("POST", `${prefix}/api/projects/${project.json().project.id}/view-links`, sessions.get("owner"), {});
    const foreignLink = foreign.json<CreatedProjectViewLink>();
    expect((await call("DELETE", ownerUrl(`/${foreignLink.link.id}`), sessions.get("owner"))).statusCode).toBe(200);
    expect(db.prepare("SELECT id FROM project_view_links WHERE id = ?").get(foreignLink.link.id)).toEqual({ id: foreignLink.link.id });
  });

  it("revalidates a grant after waiting for the project read barrier", async () => {
    const link = await create(), cookie = await grant(link), { url } = parts(link);
    const original = ProjectMutationCoordinator.prototype.runFilesystemRead;
    vi.spyOn(ProjectMutationCoordinator.prototype, "runFilesystemRead").mockImplementation(function (this: ProjectMutationCoordinator, projectId, action, options) {
      db.prepare("DELETE FROM project_view_links WHERE id = ?").run(link.link.id);
      return original.call(this, projectId, action, options);
    });
    const result = await call("GET", `${url}/file?path=main.tex`, cookie);
    expect(result.statusCode).toBe(410); expect(result.body).not.toContain(source);
  });

  it("keeps existing links under the new owner's control after project transfer", async () => {
    const link = await create(), cookie = await grant(link);
    const result = await call("PUT", `${prefix}/api/projects/${projectId}/owner`, sessions.get("owner"), { userId: "writer" });
    expect(result.statusCode, result.body).toBe(200);
    expect((await call("GET", ownerUrl(), sessions.get("owner"))).statusCode).toBe(403);
    expect((await call("GET", ownerUrl(), sessions.get("writer"))).json().links).toEqual([link.link]);
    expect((await call("GET", parts(link).url, cookie)).statusCode).toBe(200);
    expect((await call("DELETE", ownerUrl(`/${link.link.id}`), sessions.get("writer"))).statusCode).toBe(200);
    expect((await call("GET", parts(link).url, cookie)).statusCode).toBe(410);
  });

  it("never exposes an old run or a different main document through the public PDF route", async () => {
    const link = await create(), cookie = await grant(link), { url } = parts(link);
    const old = await publish("%PDF-1.4\nold"), current = await publish("%PDF-1.4\ncurrent");
    expect((await call("GET", `${url}/pdf?version=${old}`, cookie)).statusCode).toBe(404);
    expect((await call("GET", `${url}/pdf?version=${current}&mainFile=other.tex`, cookie)).body).toContain("current");
    db.prepare("UPDATE projects SET main_file = 'other.tex' WHERE id = ?").run(projectId);
    expect((await call("GET", `${url}/pdf?version=${current}`, cookie)).statusCode).toBe(404);
  });

  it("binds credentials to one link and cascades deletion without creating a user", async () => {
    const first = await create(), second = await create({}, await otherProject()), cookie = await grant(first);
    expect((await call("GET", parts(second).url, cookie)).statusCode).toBe(410);
    expect((await call("POST", `${parts(second).url}/access`, "", { token: parts(first).token })).statusCode).toBe(410);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_view_links").get()).toEqual({ n: 1 });
    expect((await call("GET", parts(second).url, await grant(second))).statusCode).toBe(200);
    expect((await call("GET", parts(first).url, cookie)).statusCode).toBe(410);
  });

  it("keeps anonymous capabilities out of every authenticated write, compile, history and Agent path", async () => {
    const link = await create(), cookie = await grant(link), token = parts(link).token;
    const p = `${prefix}/api/projects/${projectId}`;
    for (const [method, suffix, payload] of [
      ["PUT", "/file", { path: "main.tex", content: "hacked" }],
      ["POST", "/compile", {}], ["POST", "/agent-tasks", { agent: "codex", title: "hacked" }],
      ["POST", "/comments", { path: "main.tex", content: "hacked" }], ["GET", "/history", undefined],
      ["GET", "/members", undefined], ["GET", "/git", undefined], ["GET", "/pdf", undefined], ["GET", "/file/raw?path=main.tex", undefined]
    ] as const) {
      const result = await app.inject({ method, url: `${p}${suffix}`, headers: { cookie, authorization: `Bearer ${token}` }, payload });
      expect([401, 404], result.body).toContain(result.statusCode);
    }
    expect((await call("PUT", `${parts(link).url}/file`, cookie, { path: "main.tex", content: "hacked" })).statusCode).toBe(404);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe(source);
    expect(db.prepare("SELECT COUNT(*) AS n FROM compile_runs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_tasks").get()).toEqual({ n: 0 });
  });

  it("rejects malicious Yjs updates on the server before joining collaboration", async () => {
    const link = await create(), cookie = await grant(link);
    const connect = vi.spyOn(CollaborationService.prototype, "connect");
    const doc = new Y.Doc(); doc.getText("main.tex").insert(0, "hacked");
    const message = encoding.createEncoder(); encoding.writeVarUint(message, 0); syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(doc));
    const closed = new Promise<number>((resolve, reject) => {
      void app.injectWS(`${prefix}/api/collaboration/${projectId}?token=${parts(link).token}`, { headers: { cookie } }, {
        onInit: (socket) => { socket.on("close", (code) => resolve(code)); socket.on("error", reject); },
        onOpen: (socket) => socket.send(encoding.toUint8Array(message))
      }).catch(reject);
    });
    expect(await closed).toBe(1008); expect(connect).not.toHaveBeenCalled(); doc.destroy();
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe(source);
  });
});
