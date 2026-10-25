import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import type { OutgoingHttpHeaders } from "node:http";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, escapeGlobPattern } from "../src/server/app.js";
import { CollaborationService } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { MAX_CITATION_BIBTEX_BYTES } from "../src/server/limits.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/server/security.js";
import { sourceRoot } from "../src/server/files.js";
import { ProjectHistoryService } from "../src/server/history.js";
import { ProjectMutationCoordinator } from "../src/server/projectMutations.js";
import { captureCompileSnapshot, publishCompileArtifacts } from "../src/server/compiler.js";
import * as metricSummaries from "../src/server/metrics.js";
import { useFakeTexTools } from "./texTools";

useFakeTexTools();

const hostHarperAvailable = spawnSync("harper-cli", ["--version"], { stdio: "ignore" }).status === 0;
const hostHarperIt = hostHarperAvailable ? it : it.skip;
const hostChktexAvailable = spawnSync("chktex", ["--version"], { stdio: "ignore" }).status === 0;
const hostChktexIt = hostChktexAvailable ? it : it.skip;

function citationPayload(citationKey: string, title: string, bibtex: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { bibtex, citationKey, entryType: "article", title, authors: null, year: "2026", ...extras };
}

function sessionCookie(headers: OutgoingHttpHeaders): string {
  const value = headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  if (typeof cookie !== "string" || !cookie) throw new Error("Expected a Set-Cookie response header");
  return cookie.split(";")[0];
}

describe("texLite application", () => {
  const execFileAsync = promisify(execFile);
  let root: string;
  let config: Config;
  let db: DatabaseConnection;
  let app: FastifyInstance;
  let cookie: string;
  let githubFailure: { pathSuffix: string; status: number; message: string; headers?: Record<string, string> } | null = null;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-test-"));
    config = {
      configPath: path.join(root, "config.json"), siteName: "Test texLite", adminEmail: "admin@example.test",
      host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "pdflatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
      maxUploadBytes: 50 * 1024 * 1024, pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024
      , git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: true
    };
    fs.mkdirSync(path.join(config.clientDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(config.clientDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
    fs.writeFileSync(path.join(config.clientDir, "assets", "app-deadbeef.js"), "export {};\n");
    db = openDatabase(config);
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'admin', 'Administrator', ?, 'admin', 0, 0, 1, ?)`)
      .run(randomUUID(), await hashPassword("administrator password"), new Date().toISOString());
    const githubFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (githubFailure && url.endsWith(githubFailure.pathSuffix)) {
        return Response.json({ message: githubFailure.message }, { status: githubFailure.status, headers: githubFailure.headers });
      }
      if (url.endsWith("/user") && init?.method === "GET") {
        return Response.json({ login: "texlite-owner" });
      }
      if (url.endsWith("/user/repos") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        return Response.json({
          name: body.name,
          clone_url: `https://github.com/texlite-owner/${body.name}.git`,
          html_url: `https://github.com/texlite-owner/${body.name}`,
          default_branch: "main"
        }, { status: 201 });
      }
      return Response.json({ message: "Not found" }, { status: 404 });
    };
    app = await buildApp(config, db, { logger: false, githubFetch, updateFetch: async () => Response.json({ version: "99.0.0" }) });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "administrator password" } });
    expect(login.statusCode).toBe(200);
    cookie = sessionCookie(login.headers);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires authentication and exposes only public site config", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, pid: process.pid, latexmk: "latexmk" });
    const unauthenticated = await app.inject({ method: "GET", url: "/api/projects" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({
      siteName: "Test texLite", adminEmail: "admin@example.test", minPasswordLength: MIN_PASSWORD_LENGTH,
      maxCitationBibtexBytes: MAX_CITATION_BIBTEX_BYTES
    });
  });

  it("restricts update notices and dismissal to administrators", async () => {
    for (const method of ["GET", "POST"] as const) {
      const url = `/api/admin/updates${method === "POST" ? "/dismiss" : ""}`;
      const payload = method === "POST" ? { version: "99.0.0" } : undefined;
      expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
    }
    const userId = randomUUID();
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, created_at)
      VALUES (?, ?, 'Reader', 'hash', 'user', ?)`)
      .run(userId, `reader-${userId}`, new Date().toISOString());
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(createHash("sha256").update(userId).digest("hex"), userId, "2099-01-01T00:00:00.000Z", new Date().toISOString());
    const headers = { cookie: `texlite_session=${userId}` };
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/updates", headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/admin/updates/dismiss", headers, payload: { version: "99.0.0" } })).statusCode).toBe(403);
      const result = await app.inject({ method: "GET", url: "/api/admin/updates", headers: { cookie } });
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toMatchObject({ update: { latestVersion: "99.0.0" } });
      expect((await app.inject({ method: "POST", url: "/api/admin/updates/dismiss", headers: { cookie }, payload: { version: "1.0.0" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/admin/updates/dismiss", headers: { cookie }, payload: { version: "99.0.0" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/updates", headers: { cookie } })).json()).toEqual({ update: null });
    } finally {
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }
  });

  it("searches all users and returns stable twenty-user pages with corrected bounds", async () => {
    const prefix = `user-page-${randomUUID()}`;
    const records = Array.from({ length: 21 }, (_, index) => ({
      id: randomUUID(), username: `${prefix}-${String(index).padStart(2, "0")}`,
      displayName: index === 20 ? `${prefix}%_\\实验室研究者` : `Researcher ${index}`
    }));
    const administrator = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get() as { password_hash: string };
    const insert = db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, 'user', ?, 0, 0, '2026-01-01T00:00:00.000Z')`);
    db.transaction(() => {
      for (const [index, record] of records.entries()) insert.run(record.id, record.username, record.displayName, administrator.password_hash, index === 19 ? 1 : 0);
    })();
    const url = (query: string, page = "1") => `/api/admin/users?${new URLSearchParams({ q: query, page })}`;
    try {
      const unfiltered = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
      expect(unfiltered.statusCode).toBe(200);
      expect(unfiltered.json().users).toHaveLength(20);
      expect(unfiltered.json().pagination).toMatchObject({ page: 1, pageSize: 20, total: (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count });

      const first = await app.inject({ method: "GET", url: url(prefix.toUpperCase()), headers: { cookie } });
      expect(first.statusCode).toBe(200);
      expect(first.json().pagination).toEqual({ page: 1, pageSize: 20, total: 21, totalPages: 2 });
      expect(first.json().users.map((user: { username: string }) => user.username)).toEqual(records.slice(0, 20).map((record) => record.username));
      expect(first.json().users[19]).toMatchObject({ disabled: true, ownedProjects: 0 });
      expect(first.json().users[0]).not.toHaveProperty("password_hash");

      const second = await app.inject({ method: "GET", url: url(prefix, "2"), headers: { cookie } });
      expect(second.json().pagination).toEqual({ page: 2, pageSize: 20, total: 21, totalPages: 2 });
      expect(second.json().users.map((user: { id: string }) => user.id)).toEqual([records[20].id]);

      for (const query of ["实验室研究者", `${prefix}%_\\`]) {
        const filtered = await app.inject({ method: "GET", url: url(query, "999"), headers: { cookie } });
        expect(filtered.json().users.map((user: { id: string }) => user.id)).toEqual([records[20].id]);
        expect(filtered.json().pagination).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
      }
      for (const page of ["0", "-1", "not-a-page", "1.5", "Infinity"]) {
        const invalidPage = await app.inject({ method: "GET", url: url(prefix, page), headers: { cookie } });
        expect(invalidPage.json().pagination.page).toBe(1);
        expect(invalidPage.json().users).toHaveLength(20);
      }
      const missing = await app.inject({ method: "GET", url: url(`${prefix}-missing`, "10"), headers: { cookie } });
      expect(missing.json()).toEqual({ users: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });

      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: records[0].username, password: "administrator password" } });
      expect(login.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: url(prefix), headers: { cookie: sessionCookie(login.headers) } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: url(prefix) })).statusCode).toBe(401);

      const removed = await app.inject({ method: "DELETE", url: `/api/admin/users/${records[20].id}`, headers: { cookie }, payload: { deleteProjects: false } });
      expect(removed.statusCode).toBe(200);
      const afterDelete = await app.inject({ method: "GET", url: url(prefix, "2"), headers: { cookie } });
      expect(afterDelete.json().pagination).toEqual({ page: 1, pageSize: 20, total: 20, totalPages: 1 });
      expect(afterDelete.json().users).toHaveLength(20);
    } finally {
      const remove = db.prepare("DELETE FROM users WHERE id = ?");
      db.transaction(() => { for (const record of records) remove.run(record.id); })();
    }
  });

  it("keeps the app shell fresh and caches fingerprinted browser runtimes", async () => {
    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["cache-control"]).toBe("no-store");

    const asset = await app.inject({ method: "GET", url: "/assets/app-deadbeef.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("protects the signed-in administrator even when another administrator exists", async () => {
    const admin = db.prepare("SELECT id, password_hash FROM users WHERE username = 'admin'").get() as { id: string; password_hash: string };
    const otherId = randomUUID();
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)")
      .run(otherId, "other-protected-admin", "Other admin", admin.password_hash, new Date().toISOString());
    try {
      for (const payload of [{ disabled: true }, { role: "user" }]) {
        const result = await app.inject({ method: "PATCH", url: `/api/admin/users/${admin.id}`, headers: { cookie }, payload });
        expect(result.statusCode).toBe(400);
        expect(result.json()).toMatchObject({ code: "SELF_RESTRICT_FORBIDDEN" });
      }
      expect((await app.inject({ method: "DELETE", url: `/api/admin/users/${admin.id}`, headers: { cookie } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${otherId}`, headers: { cookie }, payload: { role: "user" } })).statusCode).toBe(200);
      expect(db.prepare("SELECT role, disabled FROM users WHERE id = ?").get(admin.id)).toEqual({ role: "admin", disabled: 0 });
    } finally {
      db.prepare("DELETE FROM users WHERE id = ?").run(otherId);
    }
  });

  it("revokes cookies when an account is disabled, including after re-enabling it", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "disable-cookie-user", displayName: "Disable Cookie User", password: "reader-password" }
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "disable-cookie-user", password: "reader-password" }
    });
    expect(login.statusCode).toBe(200);
    const oldCookie = sessionCookie(login.headers);
    const userId = created.json().user.id as string;
    expect((await app.inject({
      method: "PATCH", url: `/api/admin/users/${userId}`, headers: { cookie }, payload: { disabled: true }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/api/admin/users/${userId}`, headers: { cookie }, payload: { disabled: false }
    })).statusCode).toBe(200);
    const stale = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie } });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("exposes the optional Harper CLI status only to project members, including readers", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Harper status" } });
    const projectId = created.json().project.id as string;
    const url = `/api/projects/${projectId}/spellcheck/status`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ available: hostHarperAvailable });
    expect(status.headers["cache-control"]).toBe("no-store");

    const reader = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "harper-status-reader", displayName: "Reader", password: "reader-password" }
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "harper-status-reader", password: "reader-password" } });
    const readerCookie = sessionCookie(login.headers);
    expect((await app.inject({ method: "GET", url, headers: { cookie: readerCookie } })).statusCode).toBe(404);
    const shared = await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${reader.json().user.id}`, headers: { cookie }, payload: { permission: "read" }
    });
    expect(shared.statusCode).toBe(200);
    const readerStatus = await app.inject({ method: "GET", url, headers: { cookie: readerCookie } });
    expect(readerStatus.statusCode).toBe(200);
    expect(readerStatus.json()).toEqual(status.json());
  });

  hostHarperIt("runs authenticated spellcheck through the optional host service", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Server spellcheck" } });
    const response = await app.inject({
      method: "POST", url: `/api/projects/${created.json().project.id}/spellcheck`, headers: { cookie },
      payload: { path: "main.tex", source: "This wrng source is checked by Harper.", clientId: randomUUID(), sequence: 1 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().lints).toEqual(expect.arrayContaining([expect.objectContaining({ problem: "wrng" })]));
  });

  hostChktexIt("runs ChkTeX only after the project setting is enabled", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Server ChkTeX" } });
    const projectId = created.json().project.id as string;
    const disabled = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/chktex`, headers: { cookie },
      payload: { path: "main.tex", source: "\\documentclass{article}\n", clientId: randomUUID(), sequence: 1 }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ issues: [] });
    const enabled = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { chktexEnabled: true } });
    expect(enabled.statusCode).toBe(200);
    const checked = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/chktex`, headers: { cookie },
      payload: { path: "main.tex", source: "\\documentclass{article}\n\\begin{document}\nSome text -- with two hyphens.\n\\begin{itemize}\n\\item First item $x^10$\n\\end{itemize}\n\\end{document}\n", clientId: randomUUID(), sequence: 1 }
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ number: 8, line: 3 })]));
    expect(checked.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ number: 25, line: 5 })]));
  });

  it("always skips writing checks for BibTeX files", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Bibliography writing checks" } });
    const response = await app.inject({
      method: "POST", url: `/api/projects/${created.json().project.id}/spellcheck`, headers: { cookie },
      payload: { path: "references.BIB", source: "author = {Mispeled}", clientId: randomUUID(), sequence: 1 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ lints: [] });
  });

  it.each(["spellcheck", "chktex"] as const)("requires current client identifiers for %s and tells old pages to reload", async (endpoint) => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Writing check request identifiers" } });
    const url = `/api/projects/${created.json().project.id}/${endpoint}`;
    // Unsupported bibliography content never starts a host checker. The
    // request contract is still enforced, even when ChkTeX is disabled.
    const source = { path: "references.bib", source: "author = {Mispeled}" };
    for (const identifiers of [{}, { clientId: randomUUID() }, { sequence: 1 }]) {
      const response = await app.inject({ method: "POST", url, headers: { cookie }, payload: { ...source, ...identifiers } });
      expect(response.statusCode, JSON.stringify(identifiers)).toBe(409);
      expect(response.json()).toMatchObject({ code: "CLIENT_UPDATE_REQUIRED", error: expect.stringMatching(/reload/i) });
    }
    const current = await app.inject({
      method: "POST", url, headers: { cookie }, payload: { ...source, clientId: randomUUID(), sequence: 1 }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(endpoint === "spellcheck" ? { lints: [] } : { issues: [] });
  });

  it.each(["spellcheck", "chktex"] as const)("rejects malformed %s identifiers rather than creating a fallback session lane", async (endpoint) => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Invalid writing check identifiers" } });
    const url = `/api/projects/${created.json().project.id}/${endpoint}`;
    const valid = { path: "references.bib", source: "author = {Mispeled}", clientId: randomUUID(), sequence: 1 };
    for (const invalid of [
      { clientId: null }, { clientId: "invalid" }, { clientId: 12 },
      { sequence: null }, { sequence: "1" }, { sequence: 0 }, { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      const response = await app.inject({ method: "POST", url, headers: { cookie }, payload: { ...valid, ...invalid } });
      expect(response.statusCode, JSON.stringify(invalid)).toBe(400);
      expect(response.json()).toMatchObject({ code: endpoint === "spellcheck" ? "SPELLCHECK_SOURCE_INVALID" : "CHK_TEX_SOURCE_INVALID" });
    }
  });

  it("uses one collaboration size limit for the API and editable text files", async () => {
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({ maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 5 });
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Large source" } });
    const tooLarge = "x".repeat(5 * 1024 * 1024 + 1);
    const response = await app.inject({
      method: "PUT", url: `/api/projects/${created.json().project.id}/file`, headers: { cookie },
      payload: { path: "large.tex", content: tooLarge }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("opens generic UTF-8 text but keeps binary and oversized files out of the editor API", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Generic text sources" } });
    const id = created.json().project.id as string;
    const source = sourceRoot(config, id);
    const content = "# 配置\ntitle: 文本编辑\n";
    for (const file of ["config.yaml", "settings.json", "script.sh", "LICENSE", "custom.unusual"]) fs.writeFileSync(path.join(source, file), content);
    fs.writeFileSync(path.join(source, "binary.unknown"), Buffer.from([0, 1, 255, 254]));
    fs.writeFileSync(path.join(source, "pretend.txt"), Buffer.concat([Buffer.from("x".repeat(9000)), Buffer.from([0])]));
    fs.writeFileSync(path.join(source, "large.txt"), "x".repeat(5 * 1024 * 1024 + 1));
    const listed = await app.inject({ method: "GET", url: `/api/projects/${id}/files`, headers: { cookie } });
    expect(listed.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "config.yaml", size: Buffer.byteLength(content) }),
      expect.objectContaining({ path: "LICENSE", size: Buffer.byteLength(content) }),
      expect.objectContaining({ path: "binary.unknown", size: 4 }),
      expect.objectContaining({ path: "pretend.txt", size: 9001 })
    ]));
    expect(listed.json().files.every((file: Record<string, unknown>) => !Object.hasOwn(file, "textContent"))).toBe(true);
    const validated = await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=config.yaml&validate=1`, headers: { cookie } });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toEqual({ path: "config.yaml" });
    const fetched = await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=config.yaml`, headers: { cookie } });
    expect(fetched.json().content).toBe(content);
    const changed = await app.inject({ method: "PUT", url: `/api/projects/${id}/file`, headers: { cookie }, payload: { path: "config.yaml", content: "title: changed\n" } });
    expect(changed.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(source, "config.yaml"), "utf8")).toBe("title: changed\n");
    for (const file of ["binary.unknown", "pretend.txt", "custom.unusual"]) {
      expect((await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=${file}`, headers: { cookie } })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=${file}&validate=1`, headers: { cookie } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: `/api/projects/${id}/file`, headers: { cookie }, payload: { path: file, content: "do not overwrite" } })).statusCode).toBe(400);
    }
    expect(fs.readFileSync(path.join(source, "binary.unknown"))).toEqual(Buffer.from([0, 1, 255, 254]));
    const download = await app.inject({ method: "GET", url: `/api/projects/${id}/file/raw?path=binary.unknown&download=1`, headers: { cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.rawPayload).toEqual(Buffer.from([0, 1, 255, 254]));
    expect((await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=large.txt`, headers: { cookie } })).statusCode).toBe(413);
    expect((await app.inject({ method: "GET", url: `/api/projects/${id}/file?path=large.txt&validate=1`, headers: { cookie } })).statusCode).toBe(413);
  });

  it("saves only changed project settings and rejects stale values from another session", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Settings draft" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().project.id as string;
    const url = `/api/projects/${id}`;
    const renamed = await app.inject({
      method: "PATCH", url, headers: { cookie },
      payload: { name: "Settings final", expectedSettings: { name: "Settings draft" } }
    });
    expect(renamed.statusCode).toBe(200);
    const unrelated = await app.inject({
      method: "PATCH", url, headers: { cookie },
      payload: { chktexEnabled: true, expectedSettings: { chktexEnabled: false } }
    });
    expect(unrelated.json().project).toMatchObject({ name: "Settings final", chktexEnabled: true });
    const stale = await app.inject({
      method: "PATCH", url, headers: { cookie },
      payload: { name: "Outdated title", expectedSettings: { name: "Settings draft" } }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "PROJECT_SETTINGS_CONFLICT" });
    const current = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(current.json().project).toMatchObject({ name: "Settings final", chktexEnabled: true });
  });

  it("creates, edits, compiles and comments on a project", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Paper" } });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    expect(project).toMatchObject({ ownerUsername: "admin", ownerDisplayName: "Administrator", lastModifiedUsername: "admin", chktexEnabled: false });
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);

    const source = String.raw`\documentclass{article}
\begin{document}
\section{Hello}
It works.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
    const saved = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: source } });
    expect(saved.statusCode).toBe(200);
    const savedRc = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: ".latexmkrc", content: "$silent = 1;\n" } });
    expect(savedRc.statusCode).toBe(200);
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "paper.sty", content: String.raw`\ProvidesPackage{paper}
\newcommand{\reviewnote}[1]{\textbf{#1}}
\NewDocumentCommand{\reviewpair}{m o}{#1 #2}
\def\macroPair#1#2{#1#2}
\newenvironment{reviewblock}{\begin{quote}}{\end{quote}}
\DeclareMathOperator{\argmax}{arg\,max}
` }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "refs.bib", content: "@article{smith2025, author={Smith}, title={A Test}}\n" }
    });
    const citationTarget = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/references/resolve?kind=citation&key=smith2025&path=main.tex`,
      headers: { cookie }
    });
    expect(citationTarget.statusCode).toBe(200);
    expect(citationTarget.json()).toMatchObject({
      target: { path: "refs.bib", line: 1, column: 1, kind: "citation", source: "bibtex" }
    });
    const completionIndex = await app.inject({ method: "GET", url: `/api/projects/${project.id}/completions`, headers: { cookie } });
    expect(completionIndex.statusCode).toBe(200);
    expect(completionIndex.json().index.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "\\noindent", source: "LaTeX" }),
      expect.objectContaining({ label: "\\reviewnote", source: "paper.sty", apply: "\\reviewnote{${1}}" }),
      expect.objectContaining({ label: "\\reviewpair", source: "paper.sty", apply: "\\reviewpair{${1}}[${2}]" }),
      expect.objectContaining({ label: "\\macroPair", source: "paper.sty", apply: "\\macroPair{${1}}{${2}}" }),
      expect.objectContaining({ label: "\\argmax", source: "paper.sty" })
    ]));
    expect(completionIndex.json().index.environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "reviewblock", source: "paper.sty" }),
      expect.objectContaining({ label: "itemize", source: "LaTeX" })
    ]));
    expect(completionIndex.json().index.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "smith2025", source: "refs.bib" })
    ]));
    expect(completionIndex.json().index.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "paper.sty", source: "Project" }),
      expect.objectContaining({ label: "refs.bib", source: "Project" })
    ]));
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "appendix.tex", content: String.raw`\documentclass{article}
\bibliography{appendix-refs}` }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "appendix-refs.bib", content: "@article{appendix2026, title={Appendix only}}\n" }
    });
    const alternateCompletions = await app.inject({ method: "GET", url: `/api/projects/${project.id}/completions?mainFile=appendix.tex`, headers: { cookie } });
    expect(alternateCompletions.statusCode).toBe(200);
    expect(alternateCompletions.json().index.citations).toEqual([
      expect.objectContaining({ label: "appendix2026", source: "appendix-refs.bib" })
    ]);
    const configured = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { engine: "pdflatex", latexmkrc: ".latexmkrc" } });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().project.latexmkrc).toBe(".latexmkrc");
    const emptyDictionary = await app.inject({ method: "GET", url: `/api/projects/${project.id}/dictionary`, headers: { cookie } });
    expect(emptyDictionary.statusCode).toBe(200);
    expect(emptyDictionary.json()).toEqual({ words: [] });
    const addedDictionaryWord = await app.inject({ method: "POST", url: `/api/projects/${project.id}/dictionary`, headers: { cookie }, payload: { word: "LaTeX" } });
    expect(addedDictionaryWord.statusCode).toBe(201);
    expect(addedDictionaryWord.json().words).toEqual(["LaTeX"]);
    const duplicateDictionaryWord = await app.inject({ method: "POST", url: `/api/projects/${project.id}/dictionary`, headers: { cookie }, payload: { word: "latex" } });
    expect(duplicateDictionaryWord.statusCode).toBe(201);
    expect(duplicateDictionaryWord.json().words).toEqual(["LaTeX"]);
    const removedDictionaryWord = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/dictionary/${encodeURIComponent("LaTeX")}`, headers: { cookie } });
    expect(removedDictionaryWord.statusCode).toBe(200);
    expect(removedDictionaryWord.json()).toEqual({ words: [] });

    const helloOffset = source.indexOf("Hello");
    const comment = await app.inject({ method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie }, payload: {
      path: "main.tex", startOffset: helloOffset, endOffset: helloOffset + 5, content: "Check this heading",
      sourceHash: createHash("sha256").update(source, "utf8").digest("hex")
    } });
    expect(comment.statusCode).toBe(201);
    const commentId = comment.json().comment.id;
    expect(comment.json().comment).toMatchObject({ authorUsername: "admin", authorDisplayName: "Administrator", replies: [] });
    const reply = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentId}/replies`, headers: { cookie },
      payload: { content: "Reply in this thread" }
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().reply).toMatchObject({
      authorUsername: "admin", authorDisplayName: "Administrator", content: "Reply in this thread"
    });
    const replyId = reply.json().reply.id;
    expect(new Date(reply.json().reply.createdAt).toISOString()).toBe(reply.json().reply.createdAt);
    const editedComment = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie },
      payload: { content: "Updated heading comment" }
    });
    expect(editedComment.statusCode).toBe(200);
    const editedReply = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}/replies/${replyId}`, headers: { cookie },
      payload: { content: "Updated thread reply" }
    });
    expect(editedReply.statusCode).toBe(200);
    expect(editedReply.json().reply).toMatchObject({ content: "Updated thread reply" });
    expect(new Date(editedReply.json().reply.editedAt).toISOString()).toBe(editedReply.json().reply.editedAt);
    const shiftedSource = `% preface\n${source}`;
    const shifted = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: shiftedSource } });
    expect(shifted.statusCode).toBe(200);
    expect(shifted.json().comments[0]).toMatchObject({
      startOffset: helloOffset + 10, selectedText: "Hello", startLine: 4, orphaned: false,
      content: "Updated heading comment", replies: [{ content: "Updated thread reply", authorUsername: "admin" }]
    });
    expect(new Date(shifted.json().comments[0].editedAt).toISOString()).toBe(shifted.json().comments[0].editedAt);
    const resolved = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie }, payload: { resolved: true } });
    expect(resolved.statusCode).toBe(200);
    const withoutAnchor = shiftedSource.replace("Hello", "");
    const orphaned = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: withoutAnchor } });
    expect(orphaned.json().comments[0]).toMatchObject({ orphaned: true, selectedText: "Hello" });
    const restoredAnchor = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: shiftedSource } });
    expect(restoredAnchor.json().comments[0]).toMatchObject({ orphaned: false, selectedText: "Hello", startOffset: helloOffset + 10 });
    const partialEdit = shiftedSource.replace("Hello", "Hello new");
    const updatedAnchor = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: partialEdit } });
    // Insertion immediately after the range does not pull adjacent source
    // into the selected quote.
    expect(updatedAnchor.json().comments[0]).toMatchObject({ orphaned: false, selectedText: "Hello" });
    const insideEdit = partialEdit.replace("Hello", "HeXllo");
    const insideAnchor = await app.inject({ method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: insideEdit } });
    expect(insideAnchor.json().comments[0]).toMatchObject({ orphaned: false, selectedText: "HeXllo", startOffset: helloOffset + 10, endOffset: helloOffset + 16 });

    const deletedReply = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/comments/${commentId}/replies/${replyId}`, headers: { cookie }
    });
    expect(deletedReply.statusCode).toBe(200);
    const deletedComment = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie }
    });
    expect(deletedComment.statusCode).toBe(200);
    const commentsAfterDelete = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(commentsAfterDelete.json().comments).toEqual([]);

    const [compiled, duplicateCompile] = await Promise.all([
      app.inject({ method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie } }),
      app.inject({ method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie } })
    ]);
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json().ok, compiled.json().log).toBe(true);
    expect(compiled.json().diagnostics).toMatchObject({ warnings: expect.any(Array), errors: [] });
    expect(compiled.headers["server-timing"]).toContain("latexmk;dur=");
    expect(compiled.json().timings).toMatchObject({
      snapshotMs: expect.any(Number), cacheSyncMs: expect.any(Number),
      latexmkMs: expect.any(Number), artifactCopyMs: expect.any(Number), requestMs: expect.any(Number)
    });
    expect(new Date(compiled.json().pdfCompiledAt).toISOString()).toBe(compiled.json().pdfCompiledAt);
    expect(duplicateCompile.json()).toMatchObject({ ok: true, runId: compiled.json().runId });
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const upToDateCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(upToDateCompile.statusCode).toBe(200);
    expect(upToDateCompile.json()).toMatchObject({ ok: true, skipped: true, runId: compiled.json().runId });
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);

    // Modifying project tags touches updated_at, but does not invalidate the fast compile skip
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie },
      payload: { name: "NewTag", color: "blue" }
    });
    const metadataChangedCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(metadataChangedCompile.statusCode).toBe(200);
    expect(metadataChangedCompile.json()).toMatchObject({ ok: true, skipped: true, runId: compiled.json().runId });
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);

    const incrementalSource = `${withoutAnchor}\n% incremental compile\n`;
    const incrementalSave = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "main.tex", content: incrementalSource }
    });
    expect(incrementalSave.statusCode).toBe(200);
    const incrementalCompile = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie }
    });
    expect(incrementalCompile.statusCode).toBe(200);
    expect(incrementalCompile.json().ok, incrementalCompile.json().log).toBe(true);
    expect(incrementalCompile.json().runId).not.toBe(compiled.json().runId);
    expect(incrementalCompile.headers["server-timing"]).toContain("cache;dur=");
    expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const cacheRoot = path.join(config.projectsDir, project.id, "output", ".texlite", "cache");
    expect(fs.readdirSync(cacheRoot)).toHaveLength(1);
    const targetRoot = path.join(config.projectsDir, project.id, "output", ".texlite", "targets");
    const manifestPath = path.join(targetRoot, fs.readdirSync(targetRoot)[0], "latest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({ runId: incrementalCompile.json().runId, version: 2, mainFile: "main.tex" });
    const latestCompile = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/latest`, headers: { cookie }
    });
    expect(latestCompile.json()).toMatchObject({
      pdfUrl: expect.stringContaining(`/api/projects/${project.id}/pdf`),
      pdfCompiledAt: incrementalCompile.json().pdfCompiledAt,
      pdfSizeBytes: expect.any(Number),
      pdfLoadingMode: "full",
      latestRun: { diagnostics: { warnings: expect.any(Array), errors: expect.any(Array) } }
    });
    const artifactDirectory = path.join(config.projectsDir, project.id, "output", ".texlite", "runs", manifest.runId, "output");
    expect(fs.existsSync(path.join(artifactDirectory, manifest.pdf))).toBe(true);
    expect(fs.existsSync(path.join(artifactDirectory, manifest.synctex))).toBe(true);
    fs.writeFileSync(path.join(artifactDirectory, "main.bbl"), "\\begin{thebibliography}{1}\n\\end{thebibliography}\n");
    const artifacts = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/artifacts`, headers: { cookie } });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().artifacts).toContainEqual(expect.objectContaining({ path: "main.bbl", viewable: true }));
    const viewedArtifact = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/artifacts?path=main.bbl`, headers: { cookie }
    });
    expect(viewedArtifact.json()).toMatchObject({ path: "main.bbl", content: expect.stringContaining("thebibliography") });
    const downloadedArtifact = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/compile/artifacts?path=main.bbl&download=1`, headers: { cookie }
    });
    expect(downloadedArtifact.statusCode).toBe(200);
    expect(downloadedArtifact.headers["content-disposition"]).toContain("attachment");
    const pdfLocation = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/sync/pdf?path=main.tex&line=4&column=1`, headers: { cookie }
    });
    expect(pdfLocation.statusCode, pdfLocation.body).toBe(200);
    expect(pdfLocation.json()).toMatchObject({ page: 1 });
    const sourceLocation = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/sync/source?page=${pdfLocation.json().page}&x=${pdfLocation.json().x}&y=${pdfLocation.json().y}`,
      headers: { cookie }
    });
    expect(sourceLocation.statusCode, sourceLocation.body).toBe(200);
    expect(sourceLocation.json()).toMatchObject({ path: "main.tex", line: 4 });
    const pdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("Paper.pdf");
    expect(pdf.headers["cache-control"]).toBe("private, max-age=60, must-revalidate");
    expect(pdf.headers["accept-ranges"]).toBe("bytes");
    expect(pdf.headers.etag).toBeTruthy();

    // A retained PDF must remain available while a collaboration room is
    // still warming up. Any project queue would call waitForReady and fail
    // this request, making a cold restart unnecessarily slow.
    const originalWaitForReady = CollaborationService.prototype.waitForReady;
    CollaborationService.prototype.waitForReady = async () => {
      throw new Error("PDF serving must not wait for collaboration readiness");
    };
    try {
      const coldStartPdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } });
      expect(coldStartPdf.statusCode).toBe(200);
    } finally {
      CollaborationService.prototype.waitForReady = originalWaitForReady;
    }
    const versionedPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf?mainFile=main.tex&run=${manifest.runId}`, headers: { cookie }
    });
    expect(versionedPdf.statusCode).toBe(200);
    expect(versionedPdf.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const rawSource = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file/raw?path=main.tex`, headers: { cookie } });
    expect(rawSource.statusCode).toBe(200);
    expect(rawSource.headers["content-disposition"]).toContain("inline");
    expect(rawSource.rawPayload.toString()).toContain("\\documentclass");
    const cachedPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie, "if-none-match": pdf.headers.etag! }
    });
    expect(cachedPdf.statusCode).toBe(304);
    const partialPdf = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie, range: "bytes=0-7" }
    });
    expect(partialPdf.statusCode).toBe(206);
    expect(partialPdf.headers["content-range"]).toBe(`bytes 0-7/${pdf.rawPayload.length}`);
    expect(partialPdf.rawPayload).toEqual(pdf.rawPayload.subarray(0, 8));
    const downloadedPdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf?download=1`, headers: { cookie } });
    expect(downloadedPdf.statusCode).toBe(200);
    expect(downloadedPdf.headers["cache-control"]).toBe("private, no-store");
    expect(downloadedPdf.headers["content-disposition"]).toMatch(/^attachment;.*Paper-\d{4}-\d{2}-\d{2}-\d{6}\.pdf/);
    const cleanCache = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile/clean`, headers: { cookie },
      payload: { mainFile: "main.tex", mode: "cache" }
    });
    expect(cleanCache.statusCode).toBe(200);
    expect(cleanCache.json()).toMatchObject({ ok: true, mode: "cache", retainedPdf: true });
    const afterCacheClean = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/latest?mainFile=main.tex`, headers: { cookie } });
    expect(afterCacheClean.json()).toMatchObject({ hasPdf: true, latestRun: { status: "succeeded" } });
    const cleanArtifacts = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/compile/clean`, headers: { cookie },
      payload: { mainFile: "main.tex", mode: "artifacts" }
    });
    expect(cleanArtifacts.statusCode).toBe(200);
    expect(cleanArtifacts.json()).toMatchObject({ ok: true, mode: "artifacts", retainedPdf: false });
    const afterArtifactClean = await app.inject({ method: "GET", url: `/api/projects/${project.id}/compile/latest?mainFile=main.tex`, headers: { cookie } });
    expect(afterArtifactClean.json()).toMatchObject({ hasPdf: false, latestRun: null });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/pdf`, headers: { cookie } })).statusCode).toBe(404);
  }, 40_000);

  it("compiles only the currently selected LaTeX root document", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Multiple roots" }
    });
    const projectId = created.json().project.id as string;
    const standalone = String.raw`\documentclass{article}
\begin{document}
Standalone document.
\input{chapter}
\end{document}
`;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "standalone.tex", content: standalone }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "chapter.tex", content: "\\section{A chapter}\n" }
    });

    const compiled = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie },
      payload: { mainFile: "standalone.tex" }
    });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({ ok: true, mainFile: "standalone.tex" });
    expect(compiled.json().pdfUrl).toContain("mainFile=standalone.tex");
    expect(db.prepare("SELECT main_file FROM compile_runs WHERE project_id = ?").all(projectId))
      .toEqual([{ main_file: "standalone.tex" }]);

    const includedLocation = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/sync/pdf?mainFile=standalone.tex&path=chapter.tex&line=1&column=1`,
      headers: { cookie }
    });
    expect(includedLocation.statusCode, includedLocation.body).toBe(200);
    expect(includedLocation.json()).toMatchObject({ page: 1 });

    const [defaultLatest, standaloneLatest, project] = await Promise.all([
      app.inject({ method: "GET", url: `/api/projects/${projectId}/compile/latest?mainFile=main.tex`, headers: { cookie } }),
      app.inject({ method: "GET", url: `/api/projects/${projectId}/compile/latest?mainFile=standalone.tex`, headers: { cookie } }),
      app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } })
    ]);
    expect(defaultLatest.json()).toMatchObject({ mainFile: "main.tex", latestRun: null, hasPdf: false });
    expect(standaloneLatest.json()).toMatchObject({ mainFile: "standalone.tex", hasPdf: true, latestRun: { status: "succeeded" } });
    expect(project.json().project.mainFile).toBe("main.tex");

    const invalid = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie },
      payload: { mainFile: "chapter.tex" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID" });
  }, 30_000);

  it("does not capture or compile when the combined reservation cannot flush collaborative source", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Failed snapshot flush" }
    });
    const projectId = created.json().project.id as string;
    const flush = vi.spyOn(CollaborationService.prototype, "flushProject").mockReturnValueOnce({
      revision: 1, persistedAt: new Date().toISOString(), ok: false, failedPaths: ["main.tex"]
    });
    const barrier = vi.spyOn(CollaborationService.prototype, "beginSnapshotBarrier");
    try {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: false, pdfUrl: null });
      expect(flush).toHaveBeenCalledWith(projectId);
      expect(barrier).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(config.projectsDir, projectId, "output", ".texlite", "runs"))).toBe(false);
    } finally {
      barrier.mockRestore();
      flush.mockRestore();
    }
  });

  it("returns a retryable response when a stable compile snapshot cannot be obtained", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Busy snapshot" }
    });
    const projectId = created.json().project.id as string;
    const stable = vi.spyOn(CollaborationService.prototype, "isStable").mockReturnValue(false);
    const serialized = vi.spyOn(ProjectMutationCoordinator.prototype, "runSerialized");
    try {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/compile`, headers: { cookie }
      });
      expect(response.statusCode).toBe(409);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.json()).toMatchObject({ code: "COMPILE_SNAPSHOT_BUSY", retryable: true });
      expect((db.prepare("SELECT COUNT(*) AS count FROM compile_runs WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
      // One reservation covers validation/flush and every capture attempt;
      // the only other reservation performs final orphan cleanup.
      expect(serialized.mock.calls.filter(([id]) => id === projectId)).toHaveLength(2);
      expect(serialized.mock.calls[0][2]?.flush).not.toBe(false);
    } finally {
      serialized.mockRestore();
      stable.mockRestore();
    }
  });

  it("rejects a source comment whose selected revision is no longer current", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Comment revision" } });
    const projectId = created.json().project.id as string;
    const original = "First sentence.\nSecond sentence.\n";
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: original }
    })).statusCode).toBe(200);
    const staleHash = createHash("sha256").update(original, "utf8").digest("hex");
    const changed = `Preface.\n${original}`;
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: changed }
    })).statusCode).toBe(200);

    const response = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: {
        path: "main.tex", startOffset: 0, endOffset: 5, content: "This must not attach to the new preface.", sourceHash: staleHash
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "COMMENT_SOURCE_CHANGED" });
    const comments = await app.inject({ method: "GET", url: `/api/projects/${projectId}/comments?path=main.tex`, headers: { cookie } });
    expect(comments.json()).toEqual({ comments: [], summary: { totalCount: 0, unresolvedCount: 0, filePaths: [] } });
  });

  it("allows an editor to cancel an active compilation without publishing output", async () => {
    const originalLatexmk = config.latexmk;
    const fakeLatexmk = path.join(root, "cancel-latexmk.mjs");
    fs.writeFileSync(fakeLatexmk, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
    fs.chmodSync(fakeLatexmk, 0o700);
    config.latexmk = fakeLatexmk;
    try {
      const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Cancelable compile" } });
      const project = created.json().project as { id: string };
      const compiling = app.inject({ method: "POST", url: `/api/projects/${project.id}/compile`, headers: { cookie } });
      let active = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const run = db.prepare("SELECT status FROM compile_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(project.id) as { status: string } | undefined;
        if (run?.status === "running") { active = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(active).toBe(true);

      const cancelled = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/compile/cancel`, headers: { cookie }, payload: { mainFile: "main.tex" }
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ cancelled: true, mainFile: "main.tex", status: "running" });
      const result = await compiling;
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ ok: false, cancelled: true });
      expect(db.prepare("SELECT status FROM compile_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(project.id))
        .toMatchObject({ status: "failed" });
    } finally {
      config.latexmk = originalLatexmk;
    }
  }, 10_000);

  it("creates folders and moves files and directories while preserving linked paths", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Organized" } });
    const project = created.json().project;
    const chapters = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie }, payload: { path: "chapters" }
    });
    expect(chapters.statusCode).toBe(201);
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "chapters/intro.tex", content: "Introduction\n" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "chapters/intro.tex", startOffset: 0, endOffset: 12, content: "Keep this anchor" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie }, payload: { path: "archive" }
    });
    const movedFolder = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "chapters", destinationDirectory: "archive" }
    });
    expect(movedFolder.json()).toMatchObject({ path: "archive/chapters" });
    const comments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=archive%2Fchapters%2Fintro.tex`, headers: { cookie }
    });
    expect(comments.json().comments[0]).toMatchObject({ selectedText: "Introduction" });
    const movedMain = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "main.tex", destinationDirectory: "archive/chapters" }
    });
    expect(movedMain.json()).toMatchObject({ path: "archive/chapters/main.tex" });
    const renamedMain = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "archive/chapters/main.tex", destinationDirectory: "archive/chapters", destinationName: "paper.tex" }
    });
    expect(renamedMain.json()).toMatchObject({ path: "archive/chapters/paper.tex" });
    const invalidMainRename = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "archive/chapters/paper.tex", destinationDirectory: "archive/chapters", destinationName: "paper.tex.bak" }
    });
    expect(invalidMainRename.statusCode).toBe(400);
    expect(invalidMainRename.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID" });
    expect(fs.existsSync(path.join(config.projectsDir, project.id, "source", "archive", "chapters", "paper.tex"))).toBe(true);
    const renamedFolder = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/path`, headers: { cookie },
      payload: { source: "archive/chapters", destinationDirectory: "archive", destinationName: "sections" }
    });
    expect(renamedFolder.json()).toMatchObject({ path: "archive/sections" });
    const details = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(details.json().project.mainFile).toBe("archive/sections/paper.tex");
    const files = await app.inject({ method: "GET", url: `/api/projects/${project.id}/files`, headers: { cookie } });
    expect(files.json().files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([
      "archive", "archive/sections", "archive/sections/intro.tex", "archive/sections/paper.tex"
    ]));
  });

  it("does not overwrite same-named files during creation or upload", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "No Overwrite" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "notes.txt", content: "original" }
    });

    const duplicate = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "notes.txt", content: "replacement" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "FILE_EXISTS", path: "notes.txt" });
    const unchanged = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file?path=notes.txt`, headers: { cookie } });
    expect(unchanged.json().content).toBe("original");

    const firstUpload = multipartBody("upload.txt", Buffer.from("first"));
    const uploaded = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${firstUpload.boundary}`
      }, payload: firstUpload.body
    });
    expect(uploaded.statusCode).toBe(201);
    const secondUpload = multipartBody("upload.txt", Buffer.from("second"));
    const collision = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${secondUpload.boundary}`
      }, payload: secondUpload.body
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "FILE_EXISTS", path: "upload.txt" });
    const overwritten = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/upload?overwrite=1`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${secondUpload.boundary}`
      }, payload: secondUpload.body
    });
    expect(overwritten.statusCode).toBe(201);
    const uploadedContent = await app.inject({ method: "GET", url: `/api/projects/${project.id}/file?path=upload.txt`, headers: { cookie } });
    expect(uploadedContent.json().content).toBe("second");
  });

  it("reanchors source comments when an uploaded text file replaces the source", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Upload comment anchors" } });
    const projectId = created.json().project.id as string;
    const original = "first line\nkeep this sentence\nlast line\n";
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: original }
    })).statusCode).toBe(200);
    const selected = "keep this sentence";
    const startOffset = original.indexOf(selected);
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset, endOffset: startOffset + selected.length, content: "Review this sentence" }
    });
    expect(comment.statusCode).toBe(201);

    const replacement = "inserted line\nfirst line\nkeep this sentence\nlast line\n";
    const multipart = multipartBody("main.tex", Buffer.from(replacement));
    const uploaded = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/upload?overwrite=1`, headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(uploaded.statusCode).toBe(201);
    const comments = await app.inject({ method: "GET", url: `/api/projects/${projectId}/comments?path=main.tex`, headers: { cookie } });
    expect(comments.json().comments[0]).toMatchObject({ selectedText: selected, startOffset: replacement.indexOf(selected), orphaned: false });
  });

  it("keeps project archives private to each user", async () => {
    const username = `archive-reader-${randomUUID().slice(0, 8)}`;
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "Archive Reader", password: "reader-password" }
    });
    expect(createdUser.statusCode).toBe(201);
    const readerId = createdUser.json().user.id as string;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "reader-password" } });
    expect(login.statusCode).toBe(200);
    const readerCookie = sessionCookie(login.headers);
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Private archive" } });
    const projectId = created.json().project.id as string;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" } });

    const archivedByAdmin = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/archive`, headers: { cookie } });
    expect(archivedByAdmin.statusCode).toBe(200);
    expect(archivedByAdmin.json()).toMatchObject({ ok: true, archived: true });
    const adminActive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(adminActive.json().projects.some((project: { id: string }) => project.id === projectId)).toBe(false);
    const adminArchived = await app.inject({ method: "GET", url: "/api/projects?archived=1", headers: { cookie } });
    expect(adminArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true }));

    const readerActive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(readerActive.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: false, permission: "read" }));
    const archivedByReader = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/archive`, headers: { cookie: readerCookie } });
    expect(archivedByReader.statusCode).toBe(200);
    const readerAfterArchive = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(readerAfterArchive.json().projects.some((project: { id: string }) => project.id === projectId)).toBe(false);
    const readerArchived = await app.inject({ method: "GET", url: "/api/projects?archived=true", headers: { cookie: readerCookie } });
    expect(readerArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true, permission: "read" }));

    const restoredByAdmin = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/archive`, headers: { cookie } });
    expect(restoredByAdmin.statusCode).toBe(200);
    const adminRestored = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(adminRestored.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: false }));
    const readerStillArchived = await app.inject({ method: "GET", url: "/api/projects?archived=1", headers: { cookie: readerCookie } });
    expect(readerStillArchived.json().projects).toContainEqual(expect.objectContaining({ id: projectId, archived: true }));
  });

  it("paginates project lists with twenty projects per page by default", async () => {
    const prefix = `Pagination ${randomUUID().slice(0, 8)}`;
    for (let index = 1; index <= 21; index += 1) {
      const created = await app.inject({
        method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: `${prefix} ${index}` }
      });
      expect(created.statusCode).toBe(201);
    }
    const firstPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}`, headers: { cookie }
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().projects).toHaveLength(20);
    expect(firstPage.json().pagination).toMatchObject({ page: 1, pageSize: 20, total: 21, totalPages: 2 });
    const secondPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}&page=2`, headers: { cookie }
    });
    expect(secondPage.json().projects).toHaveLength(1);
    expect(secondPage.json().pagination).toMatchObject({ page: 2, pageSize: 20, total: 21, totalPages: 2 });
    const smallerPage = await app.inject({
      method: "GET", url: `/api/projects?search=${encodeURIComponent(prefix)}&page=2&pageSize=5`, headers: { cookie }
    });
    expect(smallerPage.json().projects).toHaveLength(5);
    expect(smallerPage.json().pagination).toMatchObject({ page: 2, pageSize: 5, total: 21, totalPages: 5 });
  });

  it("stores a validated shared project icon and restricts changes to its owner", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Icon catalog" } });
    const projectId = created.json().project.id as string;
    expect(created.json().project.icon).toBeNull();

    const saved = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/icon`, headers: { cookie }, payload: { icon: "brain-circuit" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().project).toMatchObject({ id: projectId, icon: "brain-circuit" });
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } })).json().project.icon)
      .toBe("brain-circuit");

    const advanced = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/icon`, headers: { cookie }, payload: { icon: "alarm-clock-minus" }
    });
    expect(advanced.statusCode).toBe(200);
    expect(advanced.json().project).toMatchObject({ id: projectId, icon: "alarm-clock-minus" });
    const advancedSvg = await app.inject({ method: "GET", url: "/api/project-icons/alarm-clock-minus", headers: { cookie } });
    expect(advancedSvg.statusCode).toBe(200);
    expect(advancedSvg.headers["content-type"]).toContain("image/svg+xml");
    expect(advancedSvg.body).toContain("lucide-alarm-clock-minus");

    const invalid = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/icon`, headers: { cookie }, payload: { icon: "not-an-icon" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "PROJECT_ICON_INVALID" });

    for (const icon of ["lucide:alarm-clock-minus", "FileText", "file-code2", "github"]) {
      const rejected = await app.inject({
        method: "PATCH", url: `/api/projects/${projectId}/icon`, headers: { cookie }, payload: { icon }
      });
      expect(rejected.statusCode, icon).toBe(400);
      expect(rejected.json()).toMatchObject({ code: "PROJECT_ICON_INVALID" });
    }
    // Older projects can keep displaying retained SVGs even though they are
    // not offered as new choices in the official catalog.
    for (const name of ["github", "file-code2"]) {
      expect((await app.inject({ method: "GET", url: `/api/project-icons/${name}`, headers: { cookie } })).statusCode).toBe(200);
    }

    const username = `icon-editor-${randomUUID().slice(0, 8)}`;
    const user = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "Icon Editor", password: "editor-password" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${user.json().user.id}`, headers: { cookie }, payload: { permission: "edit" }
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "editor-password" } });
    const editorCookie = sessionCookie(login.headers);
    const forbidden = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/icon`, headers: { cookie: editorCookie }, payload: { icon: "database" }
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } })).json().project.icon)
      .toBe("alarm-clock-minus");
  });

  it("duplicates project sources without copying collaboration or build output", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Duplicate source" } });
    const source = created.json().project;
    const sourceContent = String.raw`\documentclass{article}
\begin{document}
Copied source.
\end{document}
`;
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: "main.tex", content: sourceContent } });
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: "assets/data.txt", content: "resource" } });
    await app.inject({ method: "PUT", url: `/api/projects/${source.id}/file`, headers: { cookie }, payload: { path: ".latexmkrc", content: "$silent = 1;\n" } });
    await app.inject({ method: "PATCH", url: `/api/projects/${source.id}`, headers: { cookie }, payload: { latexmkrc: ".latexmkrc", engine: "xelatex" } });
    await app.inject({ method: "PATCH", url: `/api/projects/${source.id}/icon`, headers: { cookie }, payload: { icon: "file-text" } });
    await app.inject({
      method: "POST", url: `/api/projects/${source.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Source-only comment" }
    });

    const duplicated = await app.inject({ method: "POST", url: `/api/projects/${source.id}/duplicate`, headers: { cookie }, payload: {} });
    expect(duplicated.statusCode, duplicated.body).toBe(201);
    const copy = duplicated.json().project;
    expect(copy).toMatchObject({ name: "Duplicate source (1)", ownerUsername: "admin", mainFile: "main.tex", latexmkrc: ".latexmkrc", engine: "xelatex", icon: "file-text" });
    expect(copy.id).not.toBe(source.id);
    const copiedMain = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/file?path=main.tex`, headers: { cookie } });
    expect(copiedMain.json().content).toBe(sourceContent);
    const copiedResource = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/file?path=assets%2Fdata.txt`, headers: { cookie } });
    expect(copiedResource.json().content).toBe("resource");
    const copiedComments = await app.inject({ method: "GET", url: `/api/projects/${copy.id}/comments?path=main.tex`, headers: { cookie } });
    expect(copiedComments.json().comments).toEqual([]);
    expect(fs.readdirSync(path.join(config.projectsDir, copy.id, "output"))).toEqual([".texlite"]);
    expect(fs.existsSync(path.join(config.projectsDir, copy.id, "output", ".texlite", "history"))).toBe(true);
  });

  it("skips settings-only snapshots, summarizes attachments and compares deleted text files", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Snapshot attachments" } });
    const projectId = created.json().project.id as string;
    const getVersions = async () => (await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions;
    const original = await getVersions();
    const configured = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { chktexEnabled: true } });
    expect(configured.statusCode).toBe(200);
    expect((await getVersions()).map((version: { id: string }) => version.id)).toEqual(original.map((version: { id: string }) => version.id));

    const pdf = multipartBody("figure.pdf", Buffer.from("%PDF-1.7\nnon-text document"));
    expect((await app.inject({ method: "POST", url: `/api/projects/${projectId}/upload`, headers: { cookie, "content-type": `multipart/form-data; boundary=${pdf.boundary}` }, payload: pdf.body })).statusCode).toBe(201);
    expect((await getVersions()).map((version: { id: string }) => version.id)).toEqual(original.map((version: { id: string }) => version.id));
    const tracking = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/files`, headers: { cookie } });
    expect(tracking.statusCode).toBe(200);
    expect(tracking.json().files).toContainEqual(expect.objectContaining({ path: "figure.pdf", included: false, defaultIncluded: false }));
    expect((await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/history/files`, headers: { cookie }, payload: { path: "figure.pdf", included: true } })).statusCode).toBe(200);
    const withPdf = (await getVersions())[0];
    expect(withPdf.changedPaths).toContain("figure.pdf");
    const unsupported = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/${withPdf.id}/file?path=figure.pdf`, headers: { cookie } });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().code).toBe("HISTORY_FILE_PREVIEW_UNSUPPORTED");
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=figure.pdf`, headers: { cookie } })).statusCode).toBe(200);
    const deletedPdf = (await getVersions())[0];
    const detail = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/${deletedPdf.id}`, headers: { cookie } });
    expect(detail.json().files).toContainEqual({ path: "figure.pdf", size: 0, deleted: true, textContent: false });

    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "notes.txt", content: "previous notes" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=notes.txt`, headers: { cookie } })).statusCode).toBe(200);
    const deletedText = (await getVersions())[0];
    const comparison = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/${deletedText.id}/file?path=notes.txt&against=__previous__`, headers: { cookie } });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json()).toMatchObject({ historical: "", comparison: "previous notes" });
  });

  it.each([".gitignore", "chapters/.gitignore", "build.bat", "scripts/RUN.CMD", "settings.ini", ".env.local"])("compares managed text files in snapshots (%s)", async (filePath) => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Git ignore snapshot" } });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id as string;
    const historyUrl = `/api/projects/${projectId}/history`;
    const batch = /\.(bat|cmd)$/i.test(filePath);
    const oldContent = batch ? "@echo off\r\necho Previous\r\n" : "# Build output\n*.aux\n";
    const newContent = batch ? "@echo off\r\necho Updated\r\n" : "# Build output\n*.aux\n*.log\n";
    const getLatest = async () => (await app.inject({ method: "GET", url: historyUrl, headers: { cookie } })).json().versions[0];
    const write = async (content: string) => {
      const response = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: filePath, content } });
      expect(response.statusCode, response.body).toBe(200);
    };
    await write(oldContent);
    const previous = await getLatest();
    await write(newContent);
    const current = await getLatest();
    expect(current.changedPaths).toContain(filePath);
    const detail = await app.inject({ method: "GET", url: `${historyUrl}/${current.id}`, headers: { cookie } });
    expect(detail.json().files).toContainEqual({ path: filePath, size: Buffer.byteLength(newContent), textContent: true });
    const tracked = await app.inject({ method: "GET", url: `${historyUrl}/files`, headers: { cookie } });
    expect(tracked.json().files).toContainEqual(expect.objectContaining({ path: filePath, included: true, defaultIncluded: true }));

    const previousComparison = await app.inject({ method: "GET", url: `${historyUrl}/${current.id}/file?path=${encodeURIComponent(filePath)}&against=__previous__`, headers: { cookie } });
    expect(previousComparison.statusCode, previousComparison.body).toBe(200);
    expect(previousComparison.json()).toMatchObject({ path: filePath, historical: newContent, comparison: oldContent, previousVersion: { id: previous.id } });

    const currentComparison = await app.inject({ method: "GET", url: `${historyUrl}/${previous.id}/file?path=${encodeURIComponent(filePath)}`, headers: { cookie } });
    expect(currentComparison.statusCode, currentComparison.body).toBe(200);
    expect(currentComparison.json()).toMatchObject({ path: filePath, historical: oldContent, comparison: newContent, against: "current" });

    await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`, headers: { cookie } });
    const deleted = await getLatest();
    const deletionDetail = await app.inject({ method: "GET", url: `${historyUrl}/${deleted.id}`, headers: { cookie } });
    expect(deletionDetail.json().files).toContainEqual({ path: filePath, size: 0, deleted: true, textContent: true });
    const deletion = await app.inject({ method: "GET", url: `${historyUrl}/${deleted.id}/file?path=${encodeURIComponent(filePath)}&against=__previous__`, headers: { cookie } });
    expect(deletion.statusCode, deletion.body).toBe(200);
    expect(deletion.json()).toMatchObject({ historical: "", comparison: newContent });
  });

  it("allows writers to share snapshot file choices and rejects reader mutations and malformed paths", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Snapshot choices" } });
    const projectId = created.json().project.id as string;
    const user = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "history-file-member", displayName: "Member", password: "member-password" } });
    const userId = user.json().user.id;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "history-file-member", password: "member-password" } });
    const memberCookie = sessionCookie(login.headers);
    const url = `/api/projects/${projectId}/history/files`;
    expect((await app.inject({ method: "GET", url, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: { cookie }, payload: { permission: "read" } });
    expect((await app.inject({ method: "GET", url, headers: { cookie: memberCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url, headers: { cookie: memberCookie }, payload: { path: "main.tex", included: false } })).statusCode).toBe(403);
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: { cookie }, payload: { permission: "edit" } });
    expect((await app.inject({ method: "PATCH", url, headers: { cookie: memberCookie }, payload: { path: "main.tex", included: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: { cookie } })).json().files)
      .toContainEqual(expect.objectContaining({ path: "main.tex", included: false, override: false }));
    expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { path: "../outside", included: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { path: "main.tex" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { path: "missing.tex", included: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { path: "main.tex", included: null } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: { cookie: memberCookie } })).json().files)
      .toContainEqual(expect.objectContaining({ path: "main.tex", included: true, override: null }));
    const failedRecord = vi.spyOn(ProjectHistoryService.prototype, "record").mockImplementationOnce(() => { throw new Error("disk full"); });
    try {
      expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { path: "main.tex", included: false } })).statusCode).toBe(500);
      expect(db.prepare("SELECT * FROM project_history_files WHERE project_id = ? AND path = 'main.tex'").get(projectId)).toBeUndefined();
    } finally { failedRecord.mockRestore(); }
  });

  it("does not restore a snapshot if its safety checkpoint fails", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Snapshot checkpoint failure" } });
    const projectId = created.json().project.id as string;
    const versions = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    const versionId = versions.json().versions[0].id;
    fs.writeFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "current unsnapshotted content");
    const checkpoint = vi.spyOn(ProjectHistoryService.prototype, "checkpointForRestore").mockImplementationOnce(() => { throw new Error("disk full"); });
    try {
      const result = await app.inject({ method: "POST", url: `/api/projects/${projectId}/history/${versionId}/restore`, headers: { cookie }, payload: {} });
      expect(result.statusCode).toBe(500);
      expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe("current unsnapshotted content");
    } finally { checkpoint.mockRestore(); }
  });

  it("builds the outline across included files and restores automatic project history", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "History paper" } });
    const projectId = created.json().project.id as string;
    const main = String.raw`\documentclass{article}
\begin{document}
\section{Main result}
UniqueTerm in the main document.
\input{sections/intro}
\end{document}
`;
    const intro = String.raw`\section{Introduction and
Motivation}
Another UniqueTerm appears here.
`;
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "main.tex", content: main } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "sections/intro.tex", content: intro } })).statusCode).toBe(200);

    const versions = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions.length).toBeGreaterThanOrEqual(3);
    expect(versions.json().stats).toMatchObject({
      versionCount: expect.any(Number), ordinaryVersionCount: expect.any(Number),
      objectBytes: expect.any(Number), maxVersions: 200, maxStorageBytes: 512 * 1024 * 1024
    });
    const latestHistoryPage = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history?limit=1`, headers: { cookie } });
    expect(latestHistoryPage.statusCode).toBe(200);
    expect(latestHistoryPage.json().versions).toHaveLength(1);
    expect(latestHistoryPage.json().nextCursor).toEqual(expect.any(String));
    const olderHistoryPage = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/history?limit=1&before=${encodeURIComponent(latestHistoryPage.json().nextCursor)}`, headers: { cookie }
    });
    expect(olderHistoryPage.statusCode).toBe(200);
    expect(olderHistoryPage.json().versions[0].id).not.toBe(latestHistoryPage.json().versions[0].id);
    const crossPageComparison = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/history/${latestHistoryPage.json().versions[0].id}/file?path=main.tex&against=__previous__`,
      headers: { cookie }
    });
    expect(crossPageComparison.statusCode).toBe(200);
    expect(crossPageComparison.json()).toMatchObject({
      against: olderHistoryPage.json().versions[0].id,
      previousVersion: { id: olderHistoryPage.json().versions[0].id }
    });
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/history?before=invalid`, headers: { cookie } })).statusCode).toBe(400);
    const selectedVersion = versions.json().versions[0];
    expect(selectedVersion.changedPaths).toContain("sections/intro.tex");
    expect(selectedVersion.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const staleRestore = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie },
      payload: { path: "main.tex", snapshotHash: "0".repeat(64) }
    });
    expect(staleRestore.statusCode).toBe(409);
    expect(staleRestore.json()).toMatchObject({ code: "HISTORY_VERSION_CHANGED" });

    const outline = await app.inject({ method: "GET", url: `/api/projects/${projectId}/outline`, headers: { cookie } });
    expect(outline.json().outline).toEqual([
      expect.objectContaining({ path: "main.tex", line: 3, title: "Main result" }),
      expect.objectContaining({ path: "sections/intro.tex", line: 1, title: "Introduction and\nMotivation" })
    ]);
    for (const [filePath, content] of [["main.tex", main], ["sections/intro.tex", intro]]) {
      const edited = await app.inject({
        method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
        payload: { path: filePath, content: content.replace("UniqueTerm", "ChangedTerm") }
      });
      expect(edited.statusCode, edited.body).toBe(200);
    }

    const comparison = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/history/${selectedVersion.id}/file?path=main.tex`, headers: { cookie }
    });
    expect(comparison.json().historical).toContain("UniqueTerm");
    expect(comparison.json().comparison).toContain("ChangedTerm");
    const staleLabel = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie },
      payload: { label: "This label must not be applied", snapshotHash: "0".repeat(64) }
    });
    expect(staleLabel.statusCode).toBe(409);
    expect(staleLabel.json()).toMatchObject({ code: "HISTORY_VERSION_CHANGED" });
    const labeled = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie },
      payload: { label: "Before terminology update", snapshotHash: selectedVersion.snapshotHash }
    });
    expect(labeled.json().version.label).toBe("Before terminology update");
    expect(labeled.json().retentionScheduled).toBe(false);
    const unlabeled = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie },
      payload: { label: null, snapshotHash: selectedVersion.snapshotHash }
    });
    expect(unlabeled.json().retentionScheduled).toBe(true);
    expect(unlabeled.json().retentionRefreshAfterMs).toBeGreaterThan(30_000);

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "restore-target.txt", content: "restore me" }
    });
    const restoreVersions = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    const restoreVersion = restoreVersions.json().versions.find((version: { changedPaths: string[] }) => version.changedPaths.includes("restore-target.txt"));
    expect(restoreVersion).toBeTruthy();
    await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=restore-target.txt`, headers: { cookie } });
    await app.inject({ method: "POST", url: `/api/projects/${projectId}/folders`, headers: { cookie }, payload: { path: "restore-target.txt" } });
    const versionsBeforeConflict = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions.length;
    const targetConflict = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${restoreVersion.id}/restore`, headers: { cookie }, payload: { path: "restore-target.txt" }
    });
    expect(targetConflict.statusCode).toBe(409);
    expect(targetConflict.json()).toMatchObject({ code: "HISTORY_TARGET_CONFLICT" });
    const versionsAfterConflict = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions.length;
    expect(versionsAfterConflict).toBe(versionsBeforeConflict);
    expect(fs.readdirSync(sourceRoot(config, projectId)).some((entry) => entry.startsWith("restore-target.txt.history-") && entry.endsWith(".tmp"))).toBe(false);

    const restoredFile = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie }, payload: { path: "main.tex" }
    });
    expect(restoredFile.statusCode, restoredFile.body).toBe(200);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toContain("UniqueTerm");
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "sections/intro.tex"), "utf8")).toContain("ChangedTerm");

    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "transient.txt", content: "remove on restore" } });
    const restoredProject = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie }, payload: {}
    });
    expect(restoredProject.statusCode, restoredProject.body).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "transient.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "sections/intro.tex"), "utf8")).toContain("UniqueTerm");

    const suffix = randomUUID().slice(0, 8);
    const username = `history-reader-${suffix}`;
    const reader = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "History Reader", password: "reader-password" }
    });
    const readerId = reader.json().user.id as string;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" } });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "reader-password" } });
    const readerCookie = sessionCookie(readerLogin.headers);
    const readerHistory = await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie: readerCookie } });
    expect(readerHistory.statusCode).toBe(200);
    expect(readerHistory.json().stats).toBeNull();
    expect((await app.inject({ method: "POST", url: `/api/projects/${projectId}/history/${selectedVersion.id}/restore`, headers: { cookie: readerCookie }, payload: { path: "main.tex" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie: readerCookie } })).statusCode).toBe(403);

    const currentBeforeDelete = fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8");
    const deletedVersion = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie } });
    expect(deletedVersion.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "main.tex"), "utf8")).toBe(currentBeforeDelete);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/history/${selectedVersion.id}`, headers: { cookie } })).statusCode).toBe(404);
    const clearedHistory = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/history`, headers: { cookie } });
    expect(clearedHistory.statusCode).toBe(200);
    expect(clearedHistory.json().stats).toMatchObject({ versionCount: 0, objectCount: 0, objectBytes: 0 });
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/history`, headers: { cookie } })).json().versions).toEqual([]);
  });

  it("exposes compiler versions to signed-in users without exposing host paths", async () => {
    expect((await app.inject({ method: "GET", url: "/api/compiler/versions" })).statusCode).toBe(401);
    const username = `versions-user-${randomUUID().slice(0, 8)}`;
    await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie }, payload: { username, displayName: "Versions User", password: "versions-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "versions-password" } });
    const response = await app.inject({ method: "GET", url: "/api/compiler/versions", headers: { cookie: sessionCookie(login.headers) } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const tools = response.json().tools as { id: string; version: string | null }[];
    expect(tools.map(({ id }) => id)).toEqual(["texlive", "pdflatex", "xelatex", "lualatex", "latexmk", "bibtex", "biber", "texcount", "chktex"]);
    expect(tools.every((tool) => Object.keys(tool).sort().join(",") === "id,version")).toBe(true);
    expect(tools.every(({ version }) => version === null || /^\d[\w.-]*$/.test(version))).toBe(true);
  });

  it("exposes operational metrics only to administrators", async () => {
    const adminMetrics = await app.inject({ method: "GET", url: "/api/health/metrics", headers: { cookie } });
    expect(adminMetrics.statusCode).toBe(200);
    expect(adminMetrics.headers["cache-control"]).toBe("no-store");
    const resourceMemory = adminMetrics.json();
    expect(["host", "container"]).toContain(resourceMemory.systemMemory.scope);
    expect(resourceMemory).toHaveProperty("texMemory.rssBytes");
    expect(resourceMemory).toHaveProperty("texMemory.processCount");
    expect(["warming", "ready", "unavailable"]).toContain(resourceMemory.cpu.status);
    expect(resourceMemory.cpu).toHaveProperty("texlitePercent");
    expect(adminMetrics.json()).toMatchObject({
      compileQueue: { concurrency: 1 },
      collaboration: expect.objectContaining({ rooms: expect.any(Number), sessions: expect.any(Number) }),
      caches: { completions: expect.any(Object), outlines: expect.any(Object) },
      durationsMs: expect.any(Object)
    });
    const username = `metrics-user-${randomUUID().slice(0, 8)}`;
    await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie }, payload: { username, displayName: "Metrics User", password: "metrics-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "metrics-password" } });
    const userCookie = sessionCookie(login.headers);
    expect((await app.inject({ method: "GET", url: "/api/health/metrics", headers: { cookie: userCookie } })).statusCode).toBe(403);
  });

  it("serves normalized event-loop lag through the metrics API", async () => {
    const lag = { p50Ms: 0.1, p95Ms: 0.2, maxMs: 80.5 };
    const summarize = vi.spyOn(metricSummaries, "eventLoopDelaySummary").mockReturnValue(lag);
    try {
      const response = await app.inject({ method: "GET", url: "/api/health/metrics", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().eventLoopDelay).toEqual(lag);
      expect(summarize).toHaveBeenCalledOnce();
    } finally { summarize.mockRestore(); }
  });

  it("uses one actionable error for rejected GitHub tokens", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Git error diagnostics" } });
    const projectId = created.json().project.id as string;
    const localizedHeaders = { cookie, "accept-language": "zh-CN" };

    try {
      githubFailure = { pathSuffix: "/user", status: 401, message: "Bad credentials" };
      const invalidToken = await app.inject({
        method: "PUT", url: "/api/account/github", headers: localizedHeaders, payload: { token: "github_pat_expired_test_token_123456" }
      });
      expect(invalidToken.json()).toMatchObject({ code: "GIT_TOKEN_REJECTED" });
      expect(invalidToken.json().error).toContain("无效、已过期或权限不足");
      expect((await app.inject({ method: "GET", url: "/api/account/github", headers: { cookie } })).json().status)
        .toEqual({ tokenConfigured: false, githubLogin: null });

      githubFailure = null;
      const configured = await app.inject({
        method: "PUT", url: "/api/account/github", headers: localizedHeaders, payload: { token: "github_pat_valid_test_token_1234567890" }
      });
      expect(configured.statusCode).toBe(200);

      githubFailure = { pathSuffix: "/user/repos", status: 403, message: "Resource not accessible by personal access token" };
      const permissionDenied = await app.inject({
        method: "POST", url: `/api/projects/${projectId}/git/repository`, headers: localizedHeaders,
        payload: { name: "permission-denied", private: true }
      });
      expect(permissionDenied.json()).toMatchObject({ code: "GIT_TOKEN_REJECTED" });
      expect(permissionDenied.json().error).toContain("无效、已过期或权限不足");
    } finally {
      githubFailure = null;
      await app.inject({ method: "DELETE", url: "/api/account/github", headers: { cookie } });
    }
  });

  it("manages an owner-only encrypted GitHub backup with commit, diff, checkout and push", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Git backup paper" } });
    const projectId = created.json().project.id as string;
    const initialStatus = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git`, headers: { cookie } });
    expect(initialStatus.json().status).toMatchObject({ initialized: false, tokenConfigured: false });

    const token = "github_pat_test_token_1234567890";
    const configured = await app.inject({
      method: "PUT", url: "/api/account/github", headers: { cookie }, payload: { token }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().status).toMatchObject({ tokenConfigured: true, githubLogin: "texlite-owner" });
    const currentUser = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const stored = db.prepare("SELECT token_ciphertext FROM user_github_settings WHERE user_id = ?").get(currentUser.json().user.id) as { token_ciphertext: string };
    expect(stored.token_ciphertext).not.toContain(token);
    expect(fs.statSync(path.join(root, "git-token.key")).mode & 0o777).toBe(0o600);
    const projectStatusWithAccountToken = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git`, headers: { cookie } });
    expect(projectStatusWithAccountToken.json().status).toMatchObject({ initialized: false, tokenConfigured: true, githubLogin: "texlite-owner" });

    const repository = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/repository`, headers: { cookie },
      payload: { name: "git-backup-paper", private: true }
    });
    expect(repository.statusCode).toBe(200);
    expect(repository.json().status).toMatchObject({ repositoryName: "git-backup-paper", defaultBranch: "main" });

    const firstCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Initial backup" }
    });
    expect(firstCommit.statusCode, firstCommit.body).toBe(201);
    expect(firstCommit.json().commit).toMatchObject({ authorName: "admin", authorEmail: "admin@texlite.com", message: "Initial backup" });
    expect(firstCommit.json().status.ahead).toBe(1);
    const firstSha = firstCommit.json().commit.sha as string;

    const changedSource = String.raw`\documentclass{article}
\begin{document}
Second version.
\end{document}
`;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "main.tex", content: changedSource }
    });
    const workingDiff = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git/diff`, headers: { cookie } });
    expect(workingDiff.statusCode).toBe(200);
    expect(workingDiff.json().diff).toContain("+Second version.");
    const secondCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Second backup" }
    });
    expect(secondCommit.statusCode).toBe(201);
    expect(secondCommit.json().status.ahead).toBe(2);

    const bare = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", bare]);
    await execFileAsync("git", ["remote", "set-url", "origin", bare], { cwd: sourceRoot(config, projectId) });
    const pushed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/push`, headers: { cookie } });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().status.ahead).toBe(0);

    const checkedOut = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: false }
    });
    expect(checkedOut.statusCode).toBe(200);
    expect(checkedOut.json().status.branch).toBeNull();
    const detachedCommit = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/commit`, headers: { cookie }, payload: { message: "Detached commit" }
    });
    expect(detachedCommit.statusCode).toBe(409);
    const detachedPush = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/push`, headers: { cookie } });
    expect(detachedPush.statusCode).toBe(409);
    const historicalFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(historicalFile.json().content).not.toContain("Second version.");

    const returned = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: null, force: false }
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().status.branch).toBe("main");
    const currentFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(currentFile.json().content).toContain("Second version.");

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: changedSource.replace("Second", "Discarded") }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "untracked.txt", content: "keep me" }
    });
    const discarded = await app.inject({ method: "POST", url: `/api/projects/${projectId}/git/discard`, headers: { cookie } });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json().status).toMatchObject({ dirty: true, restorable: false });
    const restoredFile = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=main.tex`, headers: { cookie } });
    expect(restoredFile.json().content).toContain("Second version.");
    expect(fs.readFileSync(path.join(sourceRoot(config, projectId), "untracked.txt"), "utf8")).toBe("keep me");

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: changedSource.replace("Second", "Uncommitted") }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie }, payload: { path: "untracked.txt", content: "temporary" }
    });
    const refused = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: false }
    });
    expect(refused.statusCode).toBe(400);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "untracked.txt"))).toBe(true);
    const forced = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/git/checkout`, headers: { cookie }, payload: { revision: firstSha, force: true }
    });
    expect(forced.statusCode).toBe(200);
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), "untracked.txt"))).toBe(false);

    const readerCreated = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "git-reader", displayName: "Git Reader", password: "reader-password" }
    });
    const readerId = readerCreated.json().user.id;
    await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "edit" } });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "git-reader", password: "reader-password" } });
    const readerCookie = sessionCookie(readerLogin.headers);
    const forbidden = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git`, headers: { cookie: readerCookie } });
    expect(forbidden.statusCode).toBe(403);

    const removed = await app.inject({ method: "DELETE", url: "/api/account/github", headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().status).toEqual({ tokenConfigured: false, githubLogin: null });
  });

  it("does not grant project creation to new users by default", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "writer", displayName: "Writer", password: "writer-password" }
    });
    expect(createdUser.statusCode).toBe(201);
    expect(createdUser.json().user.canCreateProjects).toBe(false);
    expect(createdUser.json().user.mustChangePassword).toBe(false);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "writer", password: "writer-password" } });
    expect(login.json().user.mustChangePassword).toBe(false);
    const writerCookie = sessionCookie(login.headers);
    const project = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: writerCookie }, payload: { name: "Not allowed" } });
    expect(project.statusCode).toBe(403);
    const granted = await app.inject({ method: "PATCH", url: `/api/admin/users/${createdUser.json().user.id}`, headers: { cookie }, payload: { canCreateProjects: true } });
    expect(granted.json().user.canCreateProjects).toBe(true);
    const allowed = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: writerCookie }, payload: { name: "Allowed" } });
    expect(allowed.statusCode).toBe(201);
  });

  it("records the actual resolver, preserves repeated resolves, and clears metadata on reopen", async () => {
    const reader = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "resolution-reader", displayName: "Resolution Reader", password: "reader-password" }
    });
    const readerId = reader.json().user.id as string;
    const login = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { username: "resolution-reader", password: "reader-password" } });
    const readerCookie = sessionCookie(login.headers);
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Resolution attribution" } })).json().project as { id: string };
    await app.inject({ method: "PUT", url: `/api/projects/${project.id}/members/${readerId}`, headers: { cookie },
      payload: { permission: "read" } });
    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Please review." } });
    const commentId = created.json().comment.id as string;
    const empty = { resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null };
    expect(created.json().comment).toMatchObject({ resolved: false, ...empty });
    const update = (resolved: boolean, actor = readerCookie) => app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie: actor }, payload: { resolved }
    });
    const load = async (scope = "path=main.tex") => (await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?${scope}`, headers: { cookie }
    })).json().comments[0];
    const confirmed = await update(true);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      resolution: { id: commentId, filePath: "main.tex", resolved: true, resolvedById: readerId,
        resolvedByUsername: "resolution-reader", resolvedByDisplayName: "Resolution Reader", resolvedAt: expect.any(String) },
      summary: { totalCount: 1, unresolvedCount: 0, filePaths: ["main.tex"] }
    });
    const resolved = await load();
    expect(resolved).toMatchObject({ resolved: true, resolvedById: readerId,
      resolvedByUsername: "resolution-reader", resolvedByDisplayName: "Resolution Reader", resolvedAt: expect.any(String) });
    expect(resolved.authorId).not.toBe(readerId);
    expect(new Date(resolved.resolvedAt).toISOString()).toBe(resolved.resolvedAt);
    expect((await load("scope=project")).resolvedAt).toBe(resolved.resolvedAt);
    expect((await update(true, cookie)).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie },
      payload: { content: "Updated review." } });
    expect(await load()).toMatchObject({ resolvedById: readerId, resolvedAt: resolved.resolvedAt });
    const reopened = await update(false);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ resolution: { id: commentId, resolved: false, ...empty }, summary: { unresolvedCount: 1 } });
    expect(await load()).toMatchObject({ resolved: false, ...empty });
    expect((await update(true, cookie)).statusCode).toBe(200);
    expect(await load()).toMatchObject({ resolved: true, resolvedByUsername: "admin", resolvedAt: expect.any(String) });
    await update(false);
    await update(true);
    const beforeDeletion = await load();
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/users/${readerId}`, headers: { cookie },
      payload: { deleteProjects: false } });
    expect(deleted.statusCode).toBe(200);
    expect(await load()).toMatchObject({ resolved: true, ...empty, resolvedAt: beforeDeletion.resolvedAt });
    expect(db.prepare("SELECT resolved_by, resolved_at FROM comments WHERE id = ?").get(commentId))
      .toEqual({ resolved_by: null, resolved_at: beforeDeletion.resolvedAt });
  });

  it("creates personal @mention notifications only for project members and clears them explicitly or on resolve", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "mention-reader", displayName: "Mention Reader", password: "reader-password" }
    });
    const readerId = createdUser.json().user.id as string;
    const readerLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "mention-reader", password: "reader-password" }
    });
    const readerCookie = sessionCookie(readerLogin.headers);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Mention notifications" }
    })).json().project as { id: string };
    await app.inject({ method: "PUT", url: `/api/projects/${project.id}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" } });

    const candidates = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mention-candidates`, headers: { cookie: readerCookie } });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().users).toEqual([{ id: expect.any(String), username: "admin", displayName: "Administrator" }]);

    const ordinaryAt = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Mail mention-reader@example.test and @nobody." }
    });
    expect(ordinaryAt.statusCode).toBe(201);
    const noMention = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions?unread=1`, headers: { cookie: readerCookie } });
    expect(noMention.json().mentions).toEqual([]);

    const mentionedComment = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Could you check this, @mention-reader?" }
    });
    const commentId = mentionedComment.json().comment.id as string;
    const unread = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions?unread=1`, headers: { cookie: readerCookie } });
    expect(unread.json().mentions).toMatchObject([{ commentId, replyId: null, filePath: "main.tex", resolved: false }]);
    const mentionId = unread.json().mentions[0].id as string;
    const inaccessibleMention = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions/${mentionId}`, headers: { cookie } });
    expect(inaccessibleMention.statusCode).toBe(404);
    const listed = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(listed.json().projects.find((entry: { id: string }) => entry.id === project.id)).toMatchObject({ unreadMentionCount: 1 });

    const marked = await app.inject({ method: "POST", url: `/api/projects/${project.id}/mentions/${mentionId}/read`, headers: { cookie: readerCookie } });
    expect(marked.json()).toMatchObject({ ok: true, changed: true });
    const afterMarked = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: readerCookie } });
    expect(afterMarked.json().projects.find((entry: { id: string }) => entry.id === project.id)).toMatchObject({ unreadMentionCount: 0 });

    const removeMention = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie },
      payload: { content: "Please check this without a direct notification." }
    });
    expect(removeMention.statusCode).toBe(200);
    const resolveMention = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie },
      payload: { content: "Please check this, @mention-reader." }
    });
    expect(resolveMention.statusCode).toBe(200);
    const newlyUnread = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions?unread=1`, headers: { cookie: readerCookie } });
    expect(newlyUnread.json().mentions).toHaveLength(1);
    await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/comments/${commentId}`, headers: { cookie }, payload: { resolved: true } });
    const resolvedUnread = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions?unread=1`, headers: { cookie: readerCookie } });
    expect(resolvedUnread.json().mentions).toEqual([]);

    // A fresh reply after resolving a thread is actionable again; resolving
    // only clears notifications which existed at the time of resolution.
    const reply = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentId}/replies`, headers: { cookie },
      payload: { content: "One more detail for @mention-reader." }
    });
    expect(reply.statusCode).toBe(201);
    const replyUnread = await app.inject({ method: "GET", url: `/api/projects/${project.id}/mentions?unread=1`, headers: { cookie: readerCookie } });
    expect(replyUnread.json().mentions).toMatchObject([{ commentId, replyId: reply.json().reply.id }]);
    const markAll = await app.inject({ method: "POST", url: `/api/projects/${project.id}/mentions/read-all`, headers: { cookie: readerCookie } });
    expect(markAll.json()).toMatchObject({ ok: true, changed: 1 });
  });

  it("lists a readable project-wide comment review with source paths and replies", async () => {
    const reader = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "comment-review-reader", displayName: "Comment Review Reader", password: "reader-password" }
    });
    const readerLogin = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "comment-review-reader", password: "reader-password" }
    });
    const readerCookie = sessionCookie(readerLogin.headers);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Comment review scope" }
    })).json().project as { id: string };
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${reader.json().user.id}`, headers: { cookie },
      payload: { permission: "read" }
    });
    const chapterSource = "\\section{Introduction}\nA reviewed paragraph.\n";
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "chapters/intro.tex", content: chapterSource }
    });
    const rootComment = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Review the root." }
    });
    const chapterComment = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "chapters/intro.tex", startOffset: 0, endOffset: 8, content: "Review the chapter." }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${chapterComment.json().comment.id}/replies`, headers: { cookie },
      payload: { content: "A reply in the chapter thread." }
    });
    await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/comments/${chapterComment.json().comment.id}`, headers: { cookie },
      payload: { resolved: true }
    });

    const projectComments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?scope=project`, headers: { cookie: readerCookie }
    });
    expect(projectComments.statusCode).toBe(200);
    expect(projectComments.json().summary).toEqual({ totalCount: 2, unresolvedCount: 1, filePaths: ["chapters/intro.tex", "main.tex"] });
    expect(projectComments.json().comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rootComment.json().comment.id, filePath: "main.tex", replies: [] }),
      expect.objectContaining({ id: chapterComment.json().comment.id, filePath: "chapters/intro.tex", resolved: true, replies: [expect.objectContaining({ content: "A reply in the chapter thread." })] })
    ]));
    const fileComments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie: readerCookie }
    });
    expect(fileComments.statusCode).toBe(200);
    expect(fileComments.json().summary).toEqual(projectComments.json().summary);
    expect(fileComments.json().comments).toEqual([expect.objectContaining({ id: rootComment.json().comment.id, filePath: "main.tex" })]);
    const conflictingScope = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?scope=project&path=main.tex`, headers: { cookie: readerCookie }
    });
    expect(conflictingScope.statusCode).toBe(400);
    expect(conflictingScope.json()).toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("orders project comments by the configured root's expanded source and updates that order after root changes", async () => {
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Manuscript comment order" }
    })).json().project as { id: string };
    const sources = new Map([
      ["main.tex", "\\documentclass{article}\nRoot before\n\\input{z-intro}\nRoot middle\n\\include{a-method}\nRoot after\n"],
      ["alternate.tex", "\\documentclass{article}\n\\input{a-method}\n\\input{z-intro}\n"],
      ["z-intro.tex", "Intro before\n\\input{nested}\nIntro after\n"],
      ["nested.tex", "Nested note\n"], ["a-method.tex", "Method note\n"], ["aaa-orphan.tex", "Unreferenced note\n"]
    ]);
    for (const [filePath, content] of sources) {
      expect((await app.inject({
        method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie }, payload: { path: filePath, content }
      })).statusCode).toBe(200);
    }
    const notes = [
      ["main.tex", "Root before"], ["z-intro.tex", "Intro before"], ["nested.tex", "Nested note"],
      ["z-intro.tex", "Intro after"], ["main.tex", "Root middle"], ["a-method.tex", "Method note"],
      ["main.tex", "Root after"], ["aaa-orphan.tex", "Unreferenced note"]
    ];
    const noteIds = new Map<string, string>();
    for (const [filePath, marker] of [...notes].reverse()) {
      const startOffset = sources.get(filePath)!.indexOf(marker);
      const added = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
        payload: { path: filePath, startOffset, endOffset: startOffset + marker.length, content: marker }
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().comment).not.toHaveProperty("sourceOrder");
      noteIds.set(marker, added.json().comment.id);
    }
    const firstReply = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${noteIds.get("Intro before")}/replies`, headers: { cookie },
      payload: { content: "Earlier reply" }
    });
    const secondReply = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${noteIds.get("Intro before")}/replies`, headers: { cookie },
      payload: { content: "Later reply" }
    });
    expect(firstReply.statusCode).toBe(201); expect(secondReply.statusCode).toBe(201);
    const review = await app.inject({ method: "GET", url: `/api/projects/${project.id}/comments?scope=project`, headers: { cookie } });
    expect(review.statusCode).toBe(200);
    expect(review.json().comments.map((item: { content: string }) => item.content)).toEqual(notes.map(([, marker]) => marker));
    expect(review.json().comments.map((item: { sourceOrder: number }) => item.sourceOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(review.json().comments[1].replies.map((item: { content: string }) => item.content)).toEqual(["Earlier reply", "Later reply"]);

    // Merely opening another file never changes the configured ordering root.
    const file = await app.inject({ method: "GET", url: `/api/projects/${project.id}/comments?path=z-intro.tex`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.json().comments.every((item: object) => !("sourceOrder" in item))).toBe(true);
    const sameRoot = await app.inject({ method: "GET", url: `/api/projects/${project.id}/comments?scope=project`, headers: { cookie } });
    expect(sameRoot.json().comments.map((item: { content: string }) => item.content)).toEqual(notes.map(([, marker]) => marker));

    const signal = vi.spyOn(CollaborationService.prototype, "signalComments");
    try {
      const settings = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { mainFile: "alternate.tex" } });
      expect(settings.statusCode).toBe(200);
      expect(signal).toHaveBeenCalledWith(project.id);
    } finally { signal.mockRestore(); }
    const changedRoot = await app.inject({ method: "GET", url: `/api/projects/${project.id}/comments?scope=project`, headers: { cookie } });
    expect(changedRoot.statusCode).toBe(200);
    expect(changedRoot.json().comments.map((item: { content: string }) => item.content)).toEqual([
      "Method note", "Intro before", "Nested note", "Intro after", "Unreferenced note", "Root before", "Root middle", "Root after"
    ]);
  });

  it("keeps project comment counts consistent across the dashboard and files without source includes", async () => {
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Bibliography comments" }
    })).json().project as { id: string };
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "custom.bib", content: "@book{example, title={Example}}" }
    });
    const commentIds: string[] = [];
    for (const filePath of ["main.tex", "main.tex", "custom.bib"]) {
      const added = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
        payload: { path: filePath, startOffset: 0, endOffset: 0, content: "Review this file." }
      });
      expect(added.statusCode).toBe(201);
      commentIds.push(added.json().comment.id);
    }
    // Replies must not inflate the number of unresolved discussions.
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentIds[2]}/replies`, headers: { cookie },
      payload: { content: "A reply." }
    });
    for (const [unresolved, resolve] of [[3, false], [2, true]] as const) {
      if (resolve) await app.inject({
        method: "PATCH", url: `/api/projects/${project.id}/comments/${commentIds[2]}`, headers: { cookie },
        payload: { resolved: true }
      });
      const fileComments = await app.inject({
        method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
      });
      expect(fileComments.json().comments).toHaveLength(2);
      expect(fileComments.json().summary).toEqual({ totalCount: 3, unresolvedCount: unresolved, filePaths: ["custom.bib", "main.tex"] });
      const projectComments = await app.inject({
        method: "GET", url: `/api/projects/${project.id}/comments?scope=project`, headers: { cookie }
      });
      expect(projectComments.json().comments).toHaveLength(3);
      expect(projectComments.json().summary).toEqual(fileComments.json().summary);
      const listed = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
      expect(listed.json().projects.find((item: { id: string }) => item.id === project.id))
        .toMatchObject({ commentCount: 3, unresolvedCommentCount: unresolved });
    }
  });

  it("allows only authors to edit or delete their comments and replies", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "comment-reader", displayName: "Comment Reader", password: "reader-password" }
    });
    const readerId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "comment-reader", password: "reader-password" }
    });
    const readerCookie = sessionCookie(login.headers);
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Authored comments" } });
    const projectId = created.json().project.id;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${readerId}`, headers: { cookie }, payload: { permission: "read" }
    });
    const beforePrivateTag = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    const readerTagResponse = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie: readerCookie },
      payload: { name: "Private review", color: "orange" }
    });
    const adminSameNameTag = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie },
      payload: { name: "Private review", color: "blue" }
    });
    expect(readerTagResponse.statusCode).toBe(201);
    expect(adminSameNameTag.statusCode).toBe(201);
    expect(readerTagResponse.json().tag.id).not.toBe(adminSameNameTag.json().tag.id);
    const readerTagged = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/tags`, headers: { cookie: readerCookie },
      payload: { tagId: readerTagResponse.json().tag.id }
    });
    expect(readerTagged.statusCode).toBe(201);
    expect(readerTagged.json().project.tags).toEqual([expect.objectContaining({ name: "Private review", color: "orange" })]);
    const readerProject = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie: readerCookie } });
    const adminProject = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(readerProject.json().project.tags).toHaveLength(1);
    expect(adminProject.json().project.tags).toEqual([]);
    expect(adminProject.json().project.updatedAt).toBe(beforePrivateTag.json().project.updatedAt);
    const readerTags = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie: readerCookie } });
    const adminTags = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie } });
    expect(readerTags.json().tags).toContainEqual(readerTagResponse.json().tag);
    expect(readerTags.json().tags).not.toContainEqual(adminSameNameTag.json().tag);
    expect(adminTags.json().tags).toContainEqual(adminSameNameTag.json().tag);
    expect(adminTags.json().tags).not.toContainEqual(readerTagResponse.json().tag);
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Administrator comment" }
    });
    const commentId = comment.json().comment.id;
    const reply = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments/${commentId}/replies`, headers: { cookie },
      payload: { content: "Administrator reply" }
    });
    const replyId = reply.json().reply.id;

    const readerComment = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: readerCookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Read member comment" }
    });
    expect(readerComment.statusCode).toBe(201);
    expect(readerComment.json().comment).toMatchObject({ authorUsername: "comment-reader", content: "Read member comment" });
    const readerReply = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments/${commentId}/replies`, headers: { cookie: readerCookie },
      payload: { content: "Read member reply" }
    });
    expect(readerReply.statusCode).toBe(201);
    expect(readerReply.json().reply).toMatchObject({ authorUsername: "comment-reader", content: "Read member reply" });

    for (const request of [
      { method: "PATCH", url: `/api/projects/${projectId}/comments/${commentId}`, payload: { content: "Overwritten" } },
      { method: "DELETE", url: `/api/projects/${projectId}/comments/${commentId}` },
      { method: "PATCH", url: `/api/projects/${projectId}/comments/${commentId}/replies/${replyId}`, payload: { content: "Overwritten" } },
      { method: "DELETE", url: `/api/projects/${projectId}/comments/${commentId}/replies/${replyId}` }
    ] as const) {
      const response = await app.inject({ ...request, headers: { cookie: readerCookie } });
      expect(response.statusCode).toBe(403);
    }
    const unchanged = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=main.tex`, headers: { cookie: readerCookie }
    });
    expect(unchanged.json().comments[0]).toMatchObject({
      content: "Administrator comment", replies: [
        { content: "Administrator reply" }, { content: "Read member reply" }
      ]
    });

    const successfulRunId = randomUUID();
    const compiledAt = new Date(Date.now() - 1_000).toISOString();
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'main.tex', 'succeeded', 'Successful compile', ?, ?)`)
      .run(successfulRunId, projectId, comment.json().comment.authorId, compiledAt, compiledAt);
    const failedRunId = randomUUID();
    const failedAt = new Date().toISOString();
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
      VALUES (?, ?, ?, 'main.tex', 'failed', 'Latest compile failed', ?, ?)`)
      .run(failedRunId, projectId, comment.json().comment.authorId, failedAt, failedAt);
    const snapshot = await captureCompileSnapshot(config, projectId, successfulRunId, {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const pdf = path.join(snapshot.outputDir, "main.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\nretained\n");
    publishCompileArtifacts(config, projectId, snapshot, {
      ok: true, log: "Successful compile", diagnostics: { warnings: [], errors: [] }, pdfPath: pdf, synctexPath: null
    });
    const latestCompile = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/compile/latest`, headers: { cookie: readerCookie }
    });
    expect(latestCompile.statusCode).toBe(200);
    expect(latestCompile.json()).toMatchObject({
      hasPdf: true,
      pdfUrl: `/api/projects/${projectId}/pdf?mainFile=main.tex&run=${successfulRunId}`,
      latestRun: { id: failedRunId, status: "failed", log: "Latest compile failed" }
    });
    const retainedPdf = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/pdf`, headers: { cookie: readerCookie }
    });
    expect(retainedPdf.statusCode).toBe(200);
    expect(retainedPdf.headers["content-type"]).toContain("application/pdf");
    const versionedPdf = await app.inject({
      method: "GET", url: latestCompile.json().pdfUrl, headers: { cookie: readerCookie }
    });
    expect(versionedPdf.statusCode).toBe(200);
    expect(versionedPdf.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect((await app.inject({
      method: "GET", url: `/api/projects/${projectId}/pdf?run=1790000000000`, headers: { cookie: readerCookie }
    })).statusCode).toBe(404);
  });

  it("imports ZIP projects and manages colored tags", async () => {
    const archive = makeZip({
      "paper/draft.tex": "Draft document",
      "paper/main.tex": String.raw`\documentclass{article}\begin{document}Imported\end{document}`,
      "paper/refs.bib": ""
    });
    const multipart = multipartBody("paper.zip", archive);
    const imported = await app.inject({
      method: "POST", url: "/api/projects/import?name=Imported%20Paper", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const project = imported.json().project;
    expect(project).toMatchObject({ name: "Imported Paper", mainFile: "main.tex" });
    const files = await app.inject({ method: "GET", url: `/api/projects/${project.id}/files`, headers: { cookie } });
    expect(files.json().files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["draft.tex", "main.tex", "refs.bib"]));

    const createdTag = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie }, payload: { name: "Research", color: "purple" }
    });
    expect(createdTag.statusCode).toBe(201);
    const tag = createdTag.json().tag;
    const catalog = await app.inject({ method: "GET", url: "/api/tags", headers: { cookie } });
    expect(catalog.json().tags).toContainEqual(tag);

    // Add a comment to the project
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Draft note" }
    });

    const tagged = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie }, payload: { tagId: tag.id }
    });
    expect(tagged.statusCode).toBe(201);
    expect(tagged.json().tags[0]).toMatchObject({ name: "Research", color: "purple" });
    expect(tagged.json().project).toMatchObject({ commentCount: 1, unresolvedCommentCount: 1 });
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(projects.json().projects.find((item: { id: string }) => item.id === project.id)).toMatchObject({
      ownerUsername: "admin", lastModifiedUsername: "admin", tags: [{ name: "Research" }],
      commentCount: 1, unresolvedCommentCount: 1
    });

    const renamed = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie }, payload: { name: "Renamed Paper" }
    });
    expect(renamed.json().project).toMatchObject({
      name: "Renamed Paper", lastModifiedUsername: "admin",
      commentCount: 1, unresolvedCommentCount: 1
    });

    const untagged = await app.inject({
      method: "DELETE", url: `/api/projects/${project.id}/tags/${tag.id}`, headers: { cookie }
    });
    expect(untagged.statusCode).toBe(200);
    expect(untagged.json().project).toMatchObject({
      commentCount: 1, unresolvedCommentCount: 1
    });

    const download = await app.inject({ method: "GET", url: `/api/projects/${project.id}/download`, headers: { cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.headers["content-disposition"]).toContain("Renamed%20Paper.zip");
    expect(download.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("keeps an imported latexmkrc disabled until selected and clears it when deleted", async () => {
    const archive = makeZip({
      "paper/main.tex": String.raw`\documentclass{article}\begin{document}Imported\end{document}`,
      "paper/.latexmkrc": "$silent = 1;\n"
    });
    const multipart = multipartBody("paper.zip", archive);
    const imported = await app.inject({
      method: "POST", url: "/api/projects/import?name=RC%20project", headers: {
        cookie, "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const projectId = imported.json().project.id as string;
    expect(imported.json().project.latexmkrc).toBeNull();
    const files = await app.inject({ method: "GET", url: `/api/projects/${projectId}/files`, headers: { cookie } });
    expect(files.json().files).toContainEqual(expect.objectContaining({ path: ".latexmkrc", type: "file" }));

    const enabled = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { latexmkrc: ".latexmkrc" }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().project.latexmkrc).toBe(".latexmkrc");

    const disabled = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { latexmkrc: null }
    });
    expect(disabled.json().project.latexmkrc).toBeNull();
    expect(fs.existsSync(path.join(sourceRoot(config, projectId), ".latexmkrc"))).toBe(true);
    await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { latexmkrc: ".latexmkrc" }
    });

    const deleted = await app.inject({
      method: "DELETE", url: `/api/projects/${projectId}/file?path=.latexmkrc`, headers: { cookie }
    });
    expect(deleted.statusCode).toBe(200);
    const project = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(project.json().project.latexmkrc).toBeNull();
  });

  it("manages a private tag catalog without deleting associated projects", async () => {
    const firstProject = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Tag catalog first" }
    })).json().project;
    const secondProject = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Tag catalog second" }
    })).json().project;
    const tagName = `Catalog ${randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie }, payload: { name: tagName, color: "blue" }
    });
    expect(created.statusCode).toBe(201);
    const tag = created.json().tag as { id: string; name: string; color: string };

    for (const project of [firstProject, secondProject]) {
      const assigned = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/tags`, headers: { cookie }, payload: { tagId: tag.id }
      });
      expect(assigned.statusCode).toBe(201);
    }

    const catalog = await app.inject({ method: "GET", url: "/api/tags/management", headers: { cookie } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().tags).toContainEqual(expect.objectContaining({ ...tag, projectCount: 2 }));

    const renamed = await app.inject({
      method: "PATCH", url: `/api/tags/${tag.id}`, headers: { cookie }, payload: { name: `${tagName} revised`, color: "orange" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().tag).toMatchObject({ id: tag.id, name: `${tagName} revised`, color: "orange" });
    const firstAfterRename = await app.inject({ method: "GET", url: `/api/projects/${firstProject.id}`, headers: { cookie } });
    expect(firstAfterRename.json().project.tags).toEqual([expect.objectContaining({ id: tag.id, name: `${tagName} revised`, color: "orange" })]);

    const duplicateName = await app.inject({
      method: "POST", url: "/api/tags", headers: { cookie }, payload: { name: `${tagName} revised`, color: "purple" }
    });
    expect(duplicateName.statusCode).toBe(409);
    expect(duplicateName.json()).toMatchObject({ code: "TAG_NAME_EXISTS" });

    const otherUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: `tag-manager-${randomUUID().slice(0, 8)}`, displayName: "Tag Manager", password: "reader-password" }
    });
    const otherLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: otherUser.json().user.username, password: "reader-password" }
    });
    const otherCookie = sessionCookie(otherLogin.headers);
    const otherEdit = await app.inject({
      method: "PATCH", url: `/api/tags/${tag.id}`, headers: { cookie: otherCookie }, payload: { name: "Not allowed", color: "red" }
    });
    expect(otherEdit.statusCode).toBe(404);
    expect(otherEdit.json()).toMatchObject({ code: "TAG_NOT_FOUND" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/tags/${tag.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deletedId: tag.id, projectCount: 2 });
    const catalogAfterDelete = await app.inject({ method: "GET", url: "/api/tags/management", headers: { cookie } });
    expect(catalogAfterDelete.json().tags).not.toContainEqual(expect.objectContaining({ id: tag.id }));

    for (const project of [firstProject, secondProject]) {
      const stillThere = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
      expect(stillThere.statusCode).toBe(200);
      expect(stillThere.json().project.tags).toEqual([]);
    }
  });

  it("deletes a project together with its source files and history", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Disposable" } });
    const project = created.json().project;
    const historyDirectory = path.join(config.projectsDir, project.id, "output", ".texlite", "history");
    expect(fs.existsSync(path.join(config.projectsDir, project.id, "source", "main.tex"))).toBe(true);
    expect(fs.existsSync(historyDirectory)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(1);
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(path.join(config.projectsDir, project.id))).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(0);
    const missing = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it("does not delete database record if moving project directory to trash fails", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Fail Delete Project" }
    });
    const projectId = created.json().project.id as string;
    expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(1);

    const originalRename = fs.renameSync.bind(fs);
    const originalRm = fs.rmSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(oldPath).includes(projectId)) throw Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" });
      return originalRename(oldPath, newPath);
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      if (String(targetPath).includes(projectId)) throw Object.assign(new Error("simulated EPERM"), { code: "EPERM" });
      return originalRm(targetPath, options as any);
    });

    try {
      const deleteAttempt = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } });
      expect(deleteAttempt.statusCode).toBe(500);
      // Verify DB record is preserved
      expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(1);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }

    // Now normal deletion succeeds
    const successfulDelete = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(successfulDelete.statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(projectId) as { count: number }).count).toBe(0);
  });

  it("does not grant administrators access to unshared projects", async () => {
    const suffix = randomUUID().slice(0, 8);
    const username = `private-owner-${suffix}`;
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username, displayName: "Private Owner", password: "owner-password", canCreateProjects: true }
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "owner-password" } });
    const ownerCookie = sessionCookie(login.headers);
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: ownerCookie }, payload: { name: "Administrator privacy" }
    });
    const projectId = created.json().project.id as string;

    const catalog = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().projects).not.toContainEqual(expect.objectContaining({ id: projectId }));
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/files`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } })).statusCode).toBe(404);

    const administrator = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const administratorId = administrator.json().user.id as string;
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/members/${administratorId}`, headers: { cookie: ownerCookie }, payload: { permission: "read" }
    })).statusCode).toBe(200);
    const shared = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().project).toMatchObject({ id: projectId, permission: "read" });
    const sharedCatalog = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(sharedCatalog.json().projects).toContainEqual(expect.objectContaining({ id: projectId, permission: "read" }));
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie } })).statusCode).toBe(403);
  });

  it("transfers ownership while retaining the former owner as an editor", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "project-recipient", displayName: "Project Recipient", password: "recipient-password" }
    });
    const recipient = createdUser.json().user;
    expect(recipient.canCreateProjects).toBe(false);
    const recipientLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "project-recipient", password: "recipient-password" }
    });
    const recipientCookie = sessionCookie(recipientLogin.headers);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const formerOwnerId = me.json().user.id as string;
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Transferred paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${recipient.id}`, headers: { cookie }, payload: { permission: "read" }
    });
    const historyCount = (db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count;
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO user_github_settings
      (user_id, token_ciphertext, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(formerOwnerId, "former-owner-token", "former-owner", timestamp, timestamp);

    // Add a comment to the project
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Transfer note" }
    });

    const transferred = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/owner`, headers: { cookie }, payload: { userId: recipient.id }
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().project.ownerId).toBe(recipient.id);
    expect(transferred.json().project).toMatchObject({ commentCount: 1, unresolvedCommentCount: 1 });
    const recipientProject = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie: recipientCookie } });
    expect(recipientProject.json().project).toMatchObject({ ownerId: recipient.id, permission: "owner" });
    expect(db.prepare("SELECT permission FROM project_members WHERE project_id = ? AND user_id = ?").get(project.id, formerOwnerId)).toEqual({ permission: "edit" });
    expect(db.prepare("SELECT permission FROM project_members WHERE project_id = ? AND user_id = ?").get(project.id, recipient.id)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id) as { count: number }).count).toBe(historyCount);
    expect(db.prepare("SELECT token_ciphertext, github_login FROM user_github_settings WHERE user_id = ?").get(formerOwnerId)).toEqual({
      token_ciphertext: "former-owner-token", github_login: "former-owner"
    });
    const transferredGitStatus = await app.inject({ method: "GET", url: `/api/projects/${project.id}/git`, headers: { cookie: recipientCookie } });
    expect(transferredGitStatus.json().status).toMatchObject({ tokenConfigured: false, githubLogin: null });
    expect((await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/owner`, headers: { cookie }, payload: { userId: formerOwnerId }
    })).statusCode).toBe(403);
  });

  it("deletes a user's owned projects together with their histories", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "disposable-owner", displayName: "Disposable Owner", password: "owner-password", canCreateProjects: true }
    });
    const ownerId = createdUser.json().user.id as string;
    const ownerLogin = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "disposable-owner", password: "owner-password" }
    });
    const ownerCookie = sessionCookie(ownerLogin.headers);
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: ownerCookie }, payload: { name: "Delete with owner" }
    });
    const projectId = created.json().project.id as string;
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(projectId) as { count: number }).count).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(config.projectsDir, projectId, "output", ".texlite", "history"))).toBe(true);

    const deleted = await app.inject({
      method: "DELETE", url: `/api/admin/users/${ownerId}`, headers: { cookie }, payload: { deleteProjects: true }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, deletedProjects: 1 });
    expect(fs.existsSync(path.join(config.projectsDir, projectId))).toBe(false);
    expect(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_history_state WHERE project_id = ?").get(projectId) as { count: number }).count).toBe(0);
  });

  it("records the shared user who last changed project source", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "last-editor", displayName: "Last Editor", password: "editor-password" }
    });
    const editorId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "last-editor", password: "editor-password" }
    });
    const editorCookie = sessionCookie(login.headers);
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Shared paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${editorId}`, headers: { cookie }, payload: { permission: "edit" }
    });
    const changed = await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie: editorCookie },
      payload: { path: "main.tex", content: "\\documentclass{article}\n" }
    });
    expect(changed.statusCode).toBe(200);
    const details = await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie } });
    expect(details.json().project).toMatchObject({
      ownerUsername: "admin", lastModifiedUsername: "last-editor", lastModifiedDisplayName: "Last Editor"
    });
  });

  it("preserves comments and replies with a deleted-user author marker", async () => {
    const createdUser = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "former-reviewer", displayName: "Former Reviewer", password: "reviewer-password" }
    });
    const reviewerId = createdUser.json().user.id;
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "former-reviewer", password: "reviewer-password" }
    });
    const reviewerCookie = sessionCookie(login.headers);
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Reviewed paper" } });
    const project = created.json().project;
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/members/${reviewerId}`, headers: { cookie }, payload: { permission: "read" }
    });
    const comment = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie: reviewerCookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Former user comment" }
    });
    const commentId = comment.json().comment.id;
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${commentId}/replies`, headers: { cookie: reviewerCookie },
      payload: { content: "Former user reply" }
    });
    const deleted = await app.inject({
      method: "DELETE", url: `/api/admin/users/${reviewerId}`, headers: { cookie }, payload: { deleteProjects: false }
    });
    expect(deleted.statusCode).toBe(200);
    const comments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(comments.json().comments[0]).toMatchObject({
      authorUsername: null, authorDisplayName: null,
      replies: [{ authorUsername: null, authorDisplayName: null, content: "Former user reply" }]
    });
  });

  it("rejects ZIP path traversal", async () => {
    const multipart = multipartBody("unsafe.zip", makeZip({ "../main.tex": "unsafe" }));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "accept-language": "zh-CN", "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(fs.existsSync(path.join(root, "main.tex"))).toBe(false);
  });

  it("rejects duplicate ZIP entries instead of replacing an extracted file", async () => {
    const multipart = multipartBody("duplicates.zip", makeZipEntries([
      ["project/main.tex", "first"], ["project/main.tex", "second"]
    ]));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "accept-language": "zh-CN", "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("重复文件名");
  });

  it("rejects a multi-tex ZIP without a documentclass candidate", async () => {
    const multipart = multipartBody("fragments.zip", makeZip({
      "fragments/chapter.tex": "\\section{Chapter}",
      "fragments/appendix.tex": "\\section{Appendix}"
    }));
    const response = await app.inject({
      method: "POST", url: "/api/projects/import", headers: {
        cookie, "accept-language": "zh-CN", "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      }, payload: multipart.body
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("没有找到 LaTeX 主文档");
  });

  it("does not allow the active administrator to delete itself", async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const response = await app.inject({ method: "DELETE", url: `/api/admin/users/${me.json().user.id}`, headers: { cookie }, payload: { deleteProjects: true } });
    expect(response.statusCode).toBe(400);
  });

  it("validates project mainFile and allows temporarily having no main file", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Main File Validation" } });
    const project = created.json().project;
    expect(project.mainFile).toBe("main.tex");

    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "alt.tex", content: "\\documentclass{article}\n\\begin{document}Alt\\end{document}\n" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "refs.bib", content: "@article{sample, title={Sample}}\n" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${project.id}/file`, headers: { cookie },
      payload: { path: "chapter.tex", content: "% \\documentclass{book}\n\\section{A fragment}\n" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/folders`, headers: { cookie },
      payload: { path: "chapters" }
    });

    // 1. Changing mainFile to a valid existing .tex file succeeds
    const updateValid = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "alt.tex" }
    });
    expect(updateValid.statusCode).toBe(200);
    expect(updateValid.json().project.mainFile).toBe("alt.tex");

    const candidates = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/main-files`, headers: { cookie }
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toEqual({
      texFiles: ["alt.tex", "chapter.tex", "main.tex"],
      mainFiles: ["alt.tex", "main.tex"]
    });

    const updateFragment = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "chapter.tex" }
    });
    expect(updateFragment.statusCode).toBe(400);
    expect(updateFragment.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID", path: "chapter.tex" });

    // 2. Changing mainFile to empty string / null fails with 400 MAIN_FILE_INVALID
    const updateEmpty = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "" }
    });
    expect(updateEmpty.statusCode).toBe(400);
    expect(updateEmpty.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 3. Changing mainFile to a non-.tex file fails with 400 MAIN_FILE_INVALID
    const updateNonTex = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "refs.bib" }
    });
    expect(updateNonTex.statusCode).toBe(400);
    expect(updateNonTex.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 4. Changing mainFile to a directory fails with 400 MAIN_FILE_INVALID
    const updateDirectory = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "chapters" }
    });
    expect(updateDirectory.statusCode).toBe(400);
    expect(updateDirectory.json()).toMatchObject({ code: "MAIN_FILE_INVALID" });

    // 5. Changing mainFile to a non-existent .tex file fails with 400 MAIN_FILE_NOT_FOUND
    const updateMissing = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { mainFile: "missing.tex" }
    });
    expect(updateMissing.statusCode).toBe(400);
    expect(updateMissing.json()).toMatchObject({ code: "MAIN_FILE_NOT_FOUND" });

    // 6. Changing latexmkrc to a directory fails with 400 LATEXMKRC_INVALID
    const updateRcDir = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie },
      payload: { latexmkrc: "chapters" }
    });
    expect(updateRcDir.statusCode).toBe(400);
    expect(updateRcDir.json()).toMatchObject({ code: "LATEXMKRC_INVALID" });
  });

  it("uses a fragmentary tex file as the main-document fallback only when it is the sole tex file", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Single TeX fallback" }
    });
    const projectId = created.json().project.id as string;
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "main.tex", content: "\\section{Imported fragment}\n" }
    });

    const soleCandidate = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/main-files`, headers: { cookie }
    });
    expect(soleCandidate.json()).toEqual({ texFiles: ["main.tex"], mainFiles: ["main.tex"] });
    const soleUpdate = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { mainFile: "main.tex" }
    });
    expect(soleUpdate.statusCode).toBe(200);

    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "chapter.tex", content: "\\section{Another fragment}\n" }
    });
    const noCandidate = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/main-files`, headers: { cookie }
    });
    expect(noCandidate.json()).toEqual({ texFiles: ["chapter.tex", "main.tex"], mainFiles: [] });
    const invalidUpdate = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie }, payload: { mainFile: "main.tex" }
    });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(invalidUpdate.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID" });
    const invalidCompileState = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/compile/latest?mainFile=main.tex`, headers: { cookie }
    });
    expect(invalidCompileState.statusCode).toBe(400);
    expect(invalidCompileState.json()).toMatchObject({ code: "MAIN_DOCUMENT_INVALID" });
  });

  it("escapes SQL LIKE special characters when filtering projects by search term", async () => {
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "paper_draft_v1" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "paperXdraftXv1" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "accuracy 100%" }
    });
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "accuracy 1000" }
    });

    const searchUnderscore = await app.inject({
      method: "GET", url: "/api/projects?search=paper_draft", headers: { cookie }
    });
    expect(searchUnderscore.statusCode).toBe(200);
    const underscoreNames = searchUnderscore.json().projects.map((p: any) => p.name);
    expect(underscoreNames).toContain("paper_draft_v1");
    expect(underscoreNames).not.toContain("paperXdraftXv1");

    const searchPercent = await app.inject({
      method: "GET", url: "/api/projects?search=100%", headers: { cookie }
    });
    expect(searchPercent.statusCode).toBe(200);
    const percentNames = searchPercent.json().projects.map((p: any) => p.name);
    expect(percentNames).toContain("accuracy 100%");
    expect(percentNames).not.toContain("accuracy 1000");
  });

  it("batches and groups comment replies without N+1 query failures", async () => {
    const createProject = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Comment Batch Test" }
    });
    const project = createProject.json().project;

    const comment1Res = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 5, content: "Comment 1" }
    });
    const comment1 = comment1Res.json().comment;

    const comment2Res = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 6, endOffset: 10, content: "Comment 2" }
    });
    const comment2 = comment2Res.json().comment;

    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment1.id}/replies`, headers: { cookie },
      payload: { content: "Reply 1.1" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment1.id}/replies`, headers: { cookie },
      payload: { content: "Reply 1.2" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${project.id}/comments/${comment2.id}/replies`, headers: { cookie },
      payload: { content: "Reply 2.1" }
    });

    const getComments = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/comments?path=main.tex`, headers: { cookie }
    });
    expect(getComments.statusCode).toBe(200);
    const comments = getComments.json().comments;
    expect(comments).toHaveLength(2);

    const c1 = comments.find((c: any) => c.id === comment1.id);
    expect(c1.replies).toHaveLength(2);
    expect(c1.replies.map((r: any) => r.content)).toEqual(["Reply 1.1", "Reply 1.2"]);

    const c2 = comments.find((c: any) => c.id === comment2.id);
    expect(c2.replies).toHaveLength(1);
    expect(c2.replies[0].content).toBe("Reply 2.1");
  });

  it("exposes unresolvedCommentCount and commentCount on project lists and details", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Comment Count Project" }
    });
    const projectId = created.json().project.id as string;

    // Add 2 comments: 1 resolved, 1 unresolved
    const commentRes1 = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "Unresolved comment" }
    });
    expect(commentRes1.statusCode).toBe(201);
    const commentRes2 = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "main.tex", startOffset: 0, endOffset: 0, content: "To be resolved" }
    });
    expect(commentRes2.statusCode).toBe(201);
    const comment2 = commentRes2.json().comment;
    await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/comments/${comment2.id}`, headers: { cookie },
      payload: { resolved: true }
    });

    // Check project detail endpoint
    const detailRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}`, headers: { cookie }
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().project).toMatchObject({
      unresolvedCommentCount: 1,
      commentCount: 2
    });

    // Check project list endpoint
    const listRes = await app.inject({
      method: "GET", url: `/api/projects?search=Comment%20Count%20Project`, headers: { cookie }
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().projects.find((p: any) => p.id === projectId);
    expect(listed).toMatchObject({
      unresolvedCommentCount: 1,
      commentCount: 2
    });

    // Create a companion file and a directory file with comments
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "sections/intro.tex", content: "Introduction section" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "sections/intro.tex", startOffset: 0, endOffset: 5, content: "Intro comment" }
    });

    const withSectionRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(withSectionRes.json().project).toMatchObject({ unresolvedCommentCount: 2, commentCount: 3 });

    // Delete sections directory
    const deleteRes = await app.inject({
      method: "DELETE", url: `/api/projects/${projectId}/file?path=sections`, headers: { cookie }
    });
    expect(deleteRes.statusCode).toBe(200);

    // Comments for sections/intro.tex should be deleted from DB and project summary updated
    const afterDeleteRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(afterDeleteRes.json().project).toMatchObject({ unresolvedCommentCount: 1, commentCount: 2 });

    const commentsForDeleted = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=sections%2Fintro.tex`, headers: { cookie }
    });
    expect(commentsForDeleted.json().comments).toHaveLength(0);
  });

  it("escapes SQLite GLOB special characters when cleaning up comments on file deletion", async () => {
    expect(escapeGlobPattern("dir[1]")).toBe("dir[[]1]");
    expect(escapeGlobPattern("doc*name?")).toBe("doc[*]name[?]");

    const createProjectRes = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "GLOB Comment Project" }
    });
    const projectId = createProjectRes.json().project.id;

    // Create two directories: dir1 and dir[1]
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "dir1/note.tex", content: "dir1 content" }
    });
    await app.inject({
      method: "PUT", url: `/api/projects/${projectId}/file`, headers: { cookie },
      payload: { path: "dir[1]/note.tex", content: "dir[1] content" }
    });

    // Add comments to both
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "dir1/note.tex", startOffset: 0, endOffset: 4, content: "dir1 comment" }
    });
    await app.inject({
      method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie },
      payload: { path: "dir[1]/note.tex", startOffset: 0, endOffset: 6, content: "dir[1] comment" }
    });

    const beforeDelete = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(beforeDelete.json().project).toMatchObject({ commentCount: 2 });

    // Delete dir[1]
    const deleteRes = await app.inject({
      method: "DELETE", url: `/api/projects/${projectId}/file?path=dir%5B1%5D`, headers: { cookie }
    });
    expect(deleteRes.statusCode).toBe(200);

    // dir1 comment should NOT be deleted
    const dir1Comments = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=dir1%2Fnote.tex`, headers: { cookie }
    });
    expect(dir1Comments.json().comments).toHaveLength(1);

    // dir[1] comment should be deleted
    const dirBracketComments = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/comments?path=dir%5B1%5D%2Fnote.tex`, headers: { cookie }
    });
    expect(dirBracketComments.json().comments).toHaveLength(0);

    const afterDelete = await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie } });
    expect(afterDelete.json().project).toMatchObject({ commentCount: 1 });
  });

  it("localizes generic server errors from Accept-Language without exposing internal details", async () => {
    const testApp = await buildApp(config, db, { logger: false });
    testApp.get("/api/test-unexpected-error", async () => {
      throw new TypeError("Simulated internal runtime null dereference error");
    });
    await testApp.ready();

    const response = await testApp.inject({
      method: "GET",
      url: "/api/test-unexpected-error"
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({
      code: "SERVER_ERROR",
      error: "The server could not complete the request."
    });
    expect(body.error).not.toContain("Simulated internal runtime");
    const chineseResponse = await testApp.inject({
      method: "GET",
      url: "/api/test-unexpected-error",
      headers: { "accept-language": "zh-CN" }
    });
    expect(chineseResponse.json()).toEqual({ code: "SERVER_ERROR", error: "服务器内部错误" });
    await testApp.close();
  });

  it("rate limits repeated failed login attempts with 429 AUTH_RATE_LIMITED", async () => {
    const testUsername = "ratelimit-target";
    await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: testUsername, displayName: "Rate Limit Target", password: "correct-password-123" }
    });

    // 5 consecutive bad passwords
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: testUsername, password: "wrong-password" }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("AUTH_INVALID");
    }

    // 5th bad attempt triggers lockout
    const fifthRes = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: testUsername, password: "wrong-password" }
    });
    expect(fifthRes.statusCode).toBe(429);
    expect(fifthRes.json().code).toBe("AUTH_RATE_LIMITED");

    // Even with the correct password, it is locked out
    const lockedRes = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: testUsername, password: "correct-password-123" }
    });
    expect(lockedRes.statusCode).toBe(429);
    expect(lockedRes.json().code).toBe("AUTH_RATE_LIMITED");
  });

  it("returns HTTP 400 for safeRelativePath and short password validation errors", async () => {
    const projectRes = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "Error Handling Test Project" }
    });
    const projectId = projectRes.json().project.id;

    // Invalid relative path should return 400 INVALID_PATH
    const invalidPathRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/file/raw?path=..%2Fsecret`, headers: { cookie }
    });
    expect(invalidPathRes.statusCode).toBe(400);
    expect(invalidPathRes.json().code).toBe("INVALID_PATH");

    // Reserved .git path should return 400 RESERVED_PATH
    const reservedPathRes = await app.inject({
      method: "GET", url: `/api/projects/${projectId}/file/raw?path=.git%2Fconfig`, headers: { cookie }
    });
    expect(reservedPathRes.statusCode).toBe(400);
    expect(reservedPathRes.json().code).toBe("RESERVED_PATH");

    // Short password (< 8 chars) on user creation should return 400 PASSWORD_TOO_SHORT
    const shortPasswordRes = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "short-pass-user", displayName: "Short", password: "123" }
    });
    expect(shortPasswordRes.statusCode).toBe(400);
    expect(shortPasswordRes.json().code).toBe("PASSWORD_TOO_SHORT");
  });

  it("keeps citation updates explicit and prevents stale writes", async () => {
    const tagResponse = await app.inject({
      method: "POST", url: "/api/citations/tags", headers: { cookie },
      payload: { name: "Unassigned citation tag", color: "purple" }
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().tag.id as string;
    const tagsBeforeAssignment = await app.inject({ method: "GET", url: "/api/citations/tags", headers: { cookie } });
    expect(tagsBeforeAssignment.json().tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tagId, name: "Unassigned citation tag" })
    ]));

    const created = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Original", "@article{versioned2026, title={Original}, year={2026}}")
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().entry.revision).toBe(1);
    const entryId = created.json().entry.id as string;

    const duplicate = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Accidental replacement", "@article{versioned2026, title={Accidental replacement}, year={2026}}")
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("CITATION_KEY_EXISTS");

    const lookup = await app.inject({
      method: "POST", url: "/api/citations/lookup", headers: { cookie },
      payload: { keys: ["VERSIONED2026", "missing"] }
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().matches).toEqual([
      expect.objectContaining({ id: entryId, citationKey: "versioned2026", revision: 1 })
    ]);

    const tagged = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}/tags`, headers: { cookie },
      payload: { tagIds: [tagId], expectedRevision: 1 }
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().entry).toMatchObject({ revision: 2, bibtex: "@article{versioned2026, title={Original}, year={2026}}" });

    const staleEdit = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}`, headers: { cookie },
      payload: citationPayload("versioned2026", "Stale", "@article{versioned2026, title={Stale}, year={2026}}", { expectedRevision: 1 })
    });
    expect(staleEdit.statusCode).toBe(409);
    expect(staleEdit.json().code).toBe("CITATION_CONFLICT");

    const edited = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}`, headers: { cookie },
      payload: citationPayload("versioned2026", "Edited safely", "@article{versioned2026, title={Edited safely}, year={2026}}", { expectedRevision: 2 })
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().entry).toMatchObject({ revision: 3, title: "Edited safely" });
    expect(edited.json().entry.tags).toEqual([expect.objectContaining({ id: tagId })]);

    const staleTags = await app.inject({
      method: "PATCH", url: `/api/citations/${entryId}/tags`, headers: { cookie },
      payload: { tagIds: [], expectedRevision: 2 }
    });
    expect(staleTags.statusCode).toBe(409);
    const explicitOverwrite = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("versioned2026", "Updated from a project", "@article{versioned2026, title={Updated from a project}, year={2026}}", {
        overwrite: true, expectedRevision: 3
      })
    });
    expect(explicitOverwrite.statusCode).toBe(200);
    expect(explicitOverwrite.json()).toMatchObject({ updated: true, entry: { revision: 4, title: "Updated from a project" } });
    expect(explicitOverwrite.json().entry.tags).toEqual([expect.objectContaining({ id: tagId })]);
    const stored = await app.inject({ method: "GET", url: "/api/citations?q=versioned2026", headers: { cookie } });
    expect(stored.json().entries[0]).toMatchObject({ revision: 4, title: "Updated from a project" });
    expect(stored.json().entries[0].tags).toEqual([expect.objectContaining({ id: tagId })]);

    expect((await app.inject({ method: "DELETE", url: `/api/citations/${entryId}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/citations/tags/${tagId}`, headers: { cookie } })).statusCode).toBe(200);
  });

  it("manages private citation tags without deleting their citations", async () => {
    const createTag = (name: string) => app.inject({ method: "POST", url: "/api/citations/tags", headers: { cookie }, payload: { name, color: "green" } });
    const first = (await createTag("Managed citation tag")).json().tag;
    const other = (await createTag("Other managed tag")).json().tag;
    const entry = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("tagmanagement2026", "Kept paper", "@article{tagmanagement2026, title={Kept paper}}", { tagIds: [first.id, other.id] })
    });
    const entryId = entry.json().entry.id as string;
    const guest = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie }, payload: { username: "citation-tag-guest", password: "guest-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "citation-tag-guest", password: "guest-password" } });
    const guestCookie = sessionCookie(login.headers);
    const url = `/api/citations/tags/${first.id}`;
    try {
      expect((await app.inject({ method: "PATCH", url, payload: { name: "Unauthorized" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "PATCH", url, headers: { cookie: guestCookie }, payload: { name: "Unauthorized" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url, headers: { cookie: guestCookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { name: "OTHER MANAGED TAG" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { name: "" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { color: "invalid" } })).statusCode).toBe(400);
      const renamed = await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { name: "Renamed citation tag", color: "purple" } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().tag).toMatchObject({ id: first.id, name: "Renamed citation tag", color: "purple" });
      const filtered = await app.inject({ method: "GET", url: `/api/citations?tag=${first.id}`, headers: { cookie } });
      expect(filtered.json().entries).toEqual([expect.objectContaining({ id: entryId, tags: expect.arrayContaining([renamed.json().tag]) })]);
      expect((await app.inject({ method: "DELETE", url, headers: { cookie } })).statusCode).toBe(200);
      const kept = (await app.inject({ method: "GET", url: "/api/citations?q=tagmanagement2026", headers: { cookie } })).json().entries[0];
      expect(kept).toMatchObject({ id: entryId, bibtex: entry.json().entry.bibtex, revision: 1, tags: [other] });
      expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { name: "Missing" } })).statusCode).toBe(404);
    } finally {
      db.prepare("DELETE FROM citation_library_entries WHERE id = ?").run(entryId);
      db.prepare("DELETE FROM citation_library_tags WHERE id IN (?, ?)").run(first.id, other.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(guest.json().user.id);
    }
  });

  it("keeps citation libraries private per user", async () => {
    const tagResponse = await app.inject({
      method: "POST", url: "/api/citations/tags", headers: { cookie },
      payload: { name: "Security papers", color: "blue" }
    });
    expect(tagResponse.statusCode).toBe(201);
    const citationResponse = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie },
      payload: citationPayload("shared2026", "Shared paper", "@article{shared2026, title={Shared paper}, author={Author}, year={2026}}", { authors: "Author", tagIds: [tagResponse.json().tag.id] })
    });
    expect(citationResponse.statusCode).toBe(201);
    expect(citationResponse.json().entry.tags).toEqual([expect.objectContaining({ name: "Security papers", color: "blue" })]);
    const ownLibrary = await app.inject({ method: "GET", url: "/api/citations", headers: { cookie } });
    expect(ownLibrary.json().pagination).toEqual({ page: 1, pageSize: 60, total: 1, totalPages: 1 });
    expect((await app.inject({ method: "PATCH", url: "/api/citations/settings", headers: { cookie }, payload: { visibility: "public" } })).statusCode).toBe(403);

    const readerCreated = await app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie },
      payload: { username: "citation-reader", displayName: "Citation Reader", password: "reader-pass-123" }
    });
    const readerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "citation-reader", password: "reader-pass-123" } });
    const readerCookie = sessionCookie(readerLogin.headers);
    const readerLibrary = await app.inject({ method: "GET", url: "/api/citations", headers: { cookie: readerCookie } });
    expect(readerLibrary.statusCode).toBe(200);
    expect(readerLibrary.json().entries).toHaveLength(0);
    expect(readerLibrary.json().pagination).toEqual({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
    expect((await app.inject({ method: "GET", url: "/api/citations/tags", headers: { cookie: readerCookie } })).json().tags).toHaveLength(0);
    const unauthorizedEdit = await app.inject({
      method: "PATCH", url: `/api/citations/${citationResponse.json().entry.id}`, headers: { cookie: readerCookie },
      payload: { bibtex: "@article{hijack, title={No}}" }
    });
    expect(unauthorizedEdit.statusCode).toBe(404);
    const readerCitation = await app.inject({
      method: "POST", url: "/api/citations", headers: { cookie: readerCookie },
      payload: citationPayload("reader2026", "Reader paper", "@article{reader2026, title={Reader paper}, author={Reader}, year={2026}}", { authors: "Reader" })
    });
    expect(readerCitation.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/citations", headers: { cookie: readerCookie } })).json().entries)
      .toEqual([expect.objectContaining({ citationKey: "reader2026", ownerUsername: "citation-reader" })]);
    expect((await app.inject({ method: "GET", url: "/api/citations", headers: { cookie } })).json().entries)
      .toEqual([expect.objectContaining({ citationKey: "shared2026", ownerUsername: "admin" })]);
    expect(readerCreated.statusCode).toBe(201);
  });
});

function multipartBody(filename: string, file: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----texlite-test-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function makeZip(entries: Record<string, string>): Buffer {
  return makeZipEntries(Object.entries(entries));
}

function makeZipEntries(entries: Array<[string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [nameText, contentText] of entries) {
    const name = Buffer.from(nameText);
    const content = Buffer.from(contentText);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
