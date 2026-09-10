import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/server/app.js";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";

describe("application mounted below the origin root", () => {
  let root = "";
  let app: FastifyInstance;
  let db: DatabaseConnection;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-base-path-app-"));
    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "Mounted TexLite", adminEmail: "",
      host: "127.0.0.1", port: 3000, basePath: "/tools/texlite",
      dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
      clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
      latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex"], extraArgs: [],
      allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
      pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: 10, historyMaxStorageBytes: 16 * 1024 * 1024,
      editHistoryMaxStorageBytes: 4 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
    };
    fs.mkdirSync(path.join(config.clientDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(config.clientDir, "index.html"),
      '<!doctype html><html><head><base href="/" /><meta name="texlite-base-path" content="/" /></head><body></body></html>');
    fs.writeFileSync(path.join(config.clientDir, "assets", "app-deadbeef.js"), "export {};\n");
    db = openDatabase(config);
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'admin', 'Administrator', ?, 'admin', 0, 0, 1, ?)`)
      .run(randomUUID(), await hashPassword("administrator password"), new Date().toISOString());
    app = await buildApp(config, db, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("mounts APIs, assets and deep SPA routes only below the configured path", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
    const health = await app.inject({ method: "GET", url: "/tools/texlite/api/health" });
    expect(health.statusCode).toBe(200);

    const publicConfig = await app.inject({ method: "GET", url: "/tools/texlite/api/config" });
    expect(publicConfig.json()).toMatchObject({ siteName: "Mounted TexLite", basePath: "/tools/texlite" });

    const mountedRoot = await app.inject({ method: "GET", url: "/tools/texlite" });
    expect(mountedRoot.statusCode).toBe(200);
    expect(mountedRoot.body).toContain('<base href="/tools/texlite/" />');

    const mountedRootWithSlash = await app.inject({ method: "GET", url: "/tools/texlite/" });
    expect(mountedRootWithSlash.statusCode).toBe(200);
    expect(mountedRootWithSlash.body).toContain('<base href="/tools/texlite/" />');

    const shell = await app.inject({ method: "GET", url: "/tools/texlite/project/project-1" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('<base href="/tools/texlite/" />');
    expect(shell.body).toContain('<meta name="texlite-base-path" content="/tools/texlite" />');

    const asset = await app.inject({ method: "GET", url: "/tools/texlite/assets/app-deadbeef.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const missingApi = await app.inject({ method: "GET", url: "/tools/texlite/api/not-found" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ code: "API_NOT_FOUND" });
  });

  it("scopes authentication cookies to the mounted application without changing a root deployment", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/tools/texlite/api/auth/login",
      payload: { username: "admin", password: "administrator password" }
    });
    expect(login.statusCode).toBe(200);
    const cookies = login.headers["set-cookie"];
    const values = Array.isArray(cookies) ? cookies : [cookies];
    expect(values.some((cookie) => cookie?.includes("texlite_session=") && cookie.includes("Path=/tools/texlite/"))).toBe(true);
    expect(values.some((cookie) => cookie?.includes("Path=/;") && cookie.includes("Max-Age=0"))).toBe(false);
  });

  it("accepts an authenticated collaboration WebSocket below the mounted path", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/tools/texlite/api/auth/login",
      payload: { username: "admin", password: "administrator password" }
    });
    const cookies = login.headers["set-cookie"];
    const values = Array.isArray(cookies) ? cookies : [cookies];
    const sessionCookie = values.find((cookie) => cookie?.startsWith("texlite_session=") && cookie.includes("Path=/tools/texlite/"))?.split(";")[0];
    expect(sessionCookie).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/tools/texlite/api/projects",
      headers: { cookie: sessionCookie },
      payload: { name: "Mounted collaboration" }
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id as string;

    const socket = await app.injectWS(`/tools/texlite/api/collaboration/${projectId}`, { headers: { cookie: sessionCookie } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  });
});
