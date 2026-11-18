import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { downloadProjectTemplate } from "../src/server/projectTemplateDownload.js";
import { httpError } from "../src/server/http.js";
import { sourceRoot, outputRoot } from "../src/server/files.js";
import { hashPassword } from "../src/server/security.js";
import { createTestConfig } from "./helpers/testConfig";

vi.mock("../src/server/projectTemplateDownload.js", async (original) => ({ ...await original<typeof import("../src/server/projectTemplateDownload.js")>(), downloadProjectTemplate: vi.fn() }));

describe("creating projects from template URLs", () => {
  let root: string, app: FastifyInstance, db: DatabaseConnection, cookie: string, memberCookie: string;
  let archive: Buffer;
  const configRoot = () => createTestConfig(root);
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-template-import-"));
    const config = configRoot();
    db = openDatabase(config);
    const password = await hashPassword("template-test-password");
    const insert = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`);
    insert.run(randomUUID(), "owner", "Owner", password, "admin", 1, new Date().toISOString());
    insert.run(randomUUID(), "member", "Member", password, "user", 0, new Date().toISOString());
    app = await buildApp(config, db, { logger: false });
    const login = async (username: string) => {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "template-test-password" } });
      expect(response.statusCode).toBe(200);
      return String(response.headers["set-cookie"]).split(";")[0];
    };
    cookie = await login("owner"); memberCookie = await login("member");
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    for (const [name, text] of [["package/paper.tex", "\\documentclass{article}\n\\begin{document}Template\\end{document}"], ["package/.latexmkrc", "die 'must not run';"]]) {
      await writer.add(name, new TextReader(text));
    }
    archive = Buffer.from(await writer.close());
  });
  beforeEach(() => {
    fs.rmSync(path.join(root, "tmp", "template-cache"), { recursive: true, force: true });
    vi.mocked(downloadProjectTemplate).mockReset().mockResolvedValue(archive);
  });
  afterAll(async () => { await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const create = (headers = { cookie }, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/projects", headers,
    payload: { name: "My paper", templateUrl: "https://example.org/download?id=1", ...extra } });

  it("reuses ZIP import, keeps the default engine and disables latexmkrc, and records an initial snapshot", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const project = response.json().project;
    expect(project).toMatchObject({ name: "My paper", mainFile: "paper.tex", engine: "xelatex", latexmkrc: null, permission: "owner" });
    expect(fs.readFileSync(path.join(sourceRoot(configRoot(), project.id), "paper.tex"), "utf8")).toContain("Template");
    expect(fs.readdirSync(outputRoot(configRoot(), project.id)).filter((name) => name !== ".texlite")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_history_versions WHERE project_id = ?").get(project.id)).toMatchObject({ count: 1 });
    expect(downloadProjectTemplate).toHaveBeenCalledWith("https://example.org/download?id=1", configRoot().maxUploadBytes, expect.any(AbortSignal));
    fs.writeFileSync(path.join(sourceRoot(configRoot(), project.id), "paper.tex"), "User edits");
    const second = await create();
    expect(second.statusCode).toBe(201);
    expect(downloadProjectTemplate).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(sourceRoot(configRoot(), second.json().project.id), "paper.tex"), "utf8")).toContain("Template");
  });

  it("checks authentication, creation permission and project name before downloading", async () => {
    expect((await create({ cookie: "" })).statusCode).toBe(401);
    expect((await create({ cookie: memberCookie })).statusCode).toBe(403);
    expect((await create({ cookie }, { name: " " })).statusCode).toBe(400);
    expect(downloadProjectTemplate).not.toHaveBeenCalled();
  });

  it("keeps download and malformed-ZIP failures from leaving projects or directories behind, and allows retry", async () => {
    const before = db.prepare("SELECT COUNT(*) AS count FROM projects").get();
    const directories = fs.readdirSync(configRoot().projectsDir);
    vi.mocked(downloadProjectTemplate).mockRejectedValueOnce(httpError(400, "TEMPLATE_DOWNLOAD_FAILED"));
    expect((await create()).json().code).toBe("TEMPLATE_DOWNLOAD_FAILED");
    vi.mocked(downloadProjectTemplate).mockResolvedValueOnce(Buffer.from("<html>Download page</html>"));
    expect((await create()).statusCode).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual(before);
    expect(fs.readdirSync(configRoot().projectsDir)).toEqual(directories);
    expect((await create()).statusCode).toBe(201);
  });

  it.runIf(process.platform === "win32")("rejects case-colliding template files without leaving a project behind", async () => {
    const directories = fs.readdirSync(configRoot().projectsDir);
    const projects = db.prepare("SELECT COUNT(*) AS count FROM projects").get();
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add("Main.tex", new TextReader("first"));
    await writer.add("main.tex", new TextReader("second"));
    vi.mocked(downloadProjectTemplate).mockResolvedValueOnce(Buffer.from(await writer.close()));
    const response = await create();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "ZIP_PATH_CONFLICT", path: "main.tex" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual(projects);
    expect(fs.readdirSync(configRoot().projectsDir)).toEqual(directories);
  });

  it("rechecks permission after the download rather than using the cached authenticated user", async () => {
    db.prepare("UPDATE users SET can_create_projects = 1 WHERE username = 'member'").run();
    vi.mocked(downloadProjectTemplate).mockImplementationOnce(async () => {
      db.prepare("UPDATE users SET can_create_projects = 0 WHERE username = 'member'").run();
      return archive;
    });
    expect((await create({ cookie: memberCookie })).json().code).toBe("PROJECT_CREATE_FORBIDDEN");
  });
});
