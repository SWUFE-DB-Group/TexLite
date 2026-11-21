import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import * as security from "../src/server/security.js";
import * as files from "../src/server/files.js";
import * as zip from "../src/server/zip.js";
import * as templateDownload from "../src/server/projectTemplateDownload.js";
import { createTestConfig } from "./helpers/testConfig";
import { deferred } from "./helpers/deferred";

let root: string, app: FastifyInstance, db: DatabaseConnection;
const password = "original-password";
const cookie = (user: string) => ({ cookie: `texlite_session=${user}-token` });
const login = (username: string, loginPassword = password) => app.inject({
  method: "POST", url: "/api/auth/login", payload: { username, password: loginPassword }
});
const patch = (actor: string, target: string, payload: Record<string, unknown>) => app.inject({
  method: "PATCH", url: `/api/admin/users/${target}`, headers: cookie(actor), payload
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-permissions-"));
  const config = createTestConfig(root);
  db = openDatabase(config);
  const hash = await security.hashPassword(password);
  for (const [id, role] of [["admin-a", "admin"], ["admin-b", "admin"], ["editor", "user"]]) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)`).run(id, id, id, hash, role, now);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(security.digestToken(`${id}-token`), id, new Date(Date.now() + 60_000).toISOString(), now);
  }
  app = await buildApp(config, db, { logger: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function pauseHashFor(password: string) {
  const entered = deferred<void>(), release = deferred<void>();
  const hashPassword = security.hashPassword;
  vi.spyOn(security, "hashPassword").mockImplementation(async (input) => {
    if (input === password) { entered.resolve(); await release.promise; }
    return hashPassword(input);
  });
  return { entered, release };
}

it("does not issue a login session with an old password verified before an admin reset", async () => {
  const checked = deferred<void>(), release = deferred<void>();
  const verifyPassword = security.verifyPassword;
  vi.spyOn(security, "verifyPassword").mockImplementationOnce(async (...args) => {
    const valid = await verifyPassword(...args);
    checked.resolve();
    await release.promise;
    return valid;
  });
  const pending = login("editor").then((response) => response);
  try {
    await checked.promise;
    expect((await patch("admin-a", "editor", { password: "reset-password" })).statusCode).toBe(200);
  } finally { release.resolve(); }
  const denied = await pending;
  expect(denied.statusCode).toBe(401);
  expect(denied.headers["set-cookie"]).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM sessions WHERE user_id = 'editor'").get()).toBeUndefined();
  expect((await login("editor", "reset-password")).json().user.mustChangePassword).toBe(true);
});

it("does not let an in-flight personal password change override an admin reset", async () => {
  const { entered, release } = pauseHashFor("personal-password");
  const pending = app.inject({ method: "PUT", url: "/api/me/password", headers: cookie("editor"),
    payload: { currentPassword: password, newPassword: "personal-password" } }).then((response) => response);
  try {
    await entered.promise;
    expect((await patch("admin-a", "editor", { password: "reset-password" })).statusCode).toBe(200);
  } finally { release.resolve(); }
  expect((await pending).json().code).toBe("AUTH_REQUIRED");
  expect((await login("editor", "personal-password")).statusCode).toBe(401);
  expect((await login("editor", "reset-password")).json().user.mustChangePassword).toBe(true);
});

it("preserves a concurrent demotion, disablement and creation restriction during a password reset", async () => {
  const { entered, release } = pauseHashFor("reset-password");
  const pending = patch("admin-a", "admin-b", { password: "reset-password" }).then((response) => response);
  try {
    await entered.promise;
    expect((await patch("admin-a", "admin-b", { role: "user", disabled: true, canCreateProjects: false })).statusCode).toBe(200);
  } finally { release.resolve(); }
  const response = await pending;
  expect(response.statusCode).toBe(200);
  expect(response.json().user).toMatchObject({ role: "user", disabled: true, canCreateProjects: false, mustChangePassword: true });
  expect(db.prepare("SELECT 1 FROM sessions WHERE user_id = 'admin-b'").get()).toBeUndefined();
});

it("rejects a reset from an administrator demoted while hashing the new password", async () => {
  const { entered, release } = pauseHashFor("reset-password");
  const pending = patch("admin-b", "editor", { password: "reset-password" }).then((response) => response);
  try {
    await entered.promise;
    expect((await patch("admin-a", "admin-b", { role: "user" })).statusCode).toBe(200);
  } finally { release.resolve(); }
  expect((await pending).json().code).toBe("ADMIN_REQUIRED");
  expect((await login("editor", password)).statusCode).toBe(200);
});

it.each(["upload", "template"])("rejects project creation revoked before the %s archive commits", async (kind) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add("main.tex", new TextReader("\\documentclass{article}\n\\begin{document}Test\\end{document}"));
  const archive = Buffer.from(await writer.close());
  vi.spyOn(templateDownload, "downloadProjectTemplate").mockResolvedValue(archive);
  const entered = deferred<void>(), release = deferred<void>();
  const extract = zip.extractProjectZip;
  vi.spyOn(zip, "extractProjectZip").mockImplementationOnce(async (...args) => {
    const result = await extract(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const multipart = Buffer.concat([Buffer.from('--texlite-test\r\nContent-Disposition: form-data; name="file"; filename="paper.zip"\r\nContent-Type: application/zip\r\n\r\n'),
    archive, Buffer.from("\r\n--texlite-test--\r\n")]);
  const pending = (kind === "template" ? app.inject({ method: "POST", url: "/api/projects", headers: cookie("editor"),
    payload: { name: "From template", templateUrl: "https://example.test/paper.zip" } })
    : app.inject({ method: "POST", url: "/api/projects/import",
      headers: { ...cookie("editor"), "content-type": "multipart/form-data; boundary=texlite-test" }, payload: multipart }))
    .then((response) => response);
  try {
    await entered.promise;
    expect((await patch("admin-a", "editor", { canCreateProjects: false })).statusCode).toBe(200);
  } finally { release.resolve(); }
  const denied = await pending;
  expect(denied.statusCode).toBe(403);
  expect(denied.json().code).toBe("PROJECT_CREATE_FORBIDDEN");
  expect(db.prepare("SELECT 1 FROM projects").get()).toBeUndefined();
  expect(fs.readdirSync(path.join(root, "projects"))).toEqual([]);
});

it.each(["creation", "membership", "session"])("rejects a project copy when %s is revoked before commit", async (kind) => {
  const created = await app.inject({ method: "POST", url: "/api/projects", headers: cookie("admin-a"), payload: { name: "Source" } });
  expect(created.statusCode).toBe(201);
  const { id } = created.json().project;
  db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, 'editor', 'read', ?)").run(id, new Date().toISOString());
  const entered = deferred<void>(), release = deferred<void>();
  const copy = files.duplicateProjectFiles;
  vi.spyOn(files, "duplicateProjectFiles").mockImplementationOnce(async (...args) => {
    await copy(...args);
    entered.resolve();
    await release.promise;
  });
  const pending = app.inject({ method: "POST", url: `/api/projects/${id}/duplicate`, headers: cookie("editor"), payload: {} }).then((response) => response);
  try {
    await entered.promise;
    const response = kind === "creation" ? await patch("admin-a", "editor", { canCreateProjects: false })
      : kind === "membership" ? await app.inject({ method: "DELETE", url: `/api/projects/${id}/members/editor`, headers: cookie("admin-a") })
      : await app.inject({ method: "POST", url: "/api/auth/logout", headers: cookie("editor") });
    expect(response.statusCode).toBe(200);
  } finally { release.resolve(); }
  const denied = await pending;
  expect(denied.json().code).toBe({ creation: "PROJECT_CREATE_FORBIDDEN", membership: "PROJECT_NOT_FOUND", session: "AUTH_REQUIRED" }[kind]);
  expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id }]);
  expect(fs.readdirSync(path.join(root, "projects"))).toEqual([id]);
});
