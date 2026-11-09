import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { hashPassword } from "../src/server/security.js";
import { createTestConfig } from "./helpers/testConfig.js";
import { loginEstablishedUser } from "./establishedUser.js";

describe("TikZ gallery add-on", () => {
  let root: string, library: string, cookie: string;
  let config: Config, db: DatabaseConnection, app: FastifyInstance;
  const write = (relative: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(library, relative)), { recursive: true });
    fs.writeFileSync(path.join(library, relative), content);
  };
  const catalog = (version = 1) => JSON.stringify({ version, categories: [], items: [{ id: "a", tex: "figures/a/figure.tex", preview: "figures/a/preview.svg" }] });
  const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ method: "GET", url, headers });
  const file = (relative: string) => get(`/api/tikz-gallery/file?path=${encodeURIComponent(relative)}`);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-tikz-gallery-"));
    library = path.join(root, "library");
    config = createTestConfig(root, { tikzGalleryEnabled: true, tikzGalleryDir: library });
    fs.mkdirSync(config.clientDir, { recursive: true });
    db = openDatabase(config);
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'admin', 'Administrator', ?, 'admin', 0, 0, 1, ?)`).run(randomUUID(), await hashPassword("administrator password"), new Date().toISOString());
    app = await buildApp(config, db, { logger: false });
    const login = await loginEstablishedUser(app, { method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "administrator password" } });
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(";")[0]!;
  });
  afterAll(async () => { await app.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => {
    config.tikzGalleryEnabled = true;
    fs.rmSync(library, { recursive: true, force: true });
    write("catalog.json", catalog());
    write("figures/a/figure.tex", "\\documentclass{standalone}");
    write("figures/a/preview.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
    write("figures/a/meta.json", "{}");
    write(".git/config", "secret");
  });

  it("serves listed figures to signed-in users and keeps previews from running as TexLite", async () => {
    expect((await get("/api/tikz-gallery/catalog")).json()).toMatchObject({ version: 1 });
    expect((await file("figures/a/figure.tex")).body).toBe("\\documentclass{standalone}");
    const preview = await file("figures/a/preview.svg");
    expect(preview.headers["content-type"]).toContain("image/svg+xml");
    expect(preview.headers["content-security-policy"]).toContain("sandbox");
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect((await get("/api/tikz-gallery/catalog", {})).statusCode).toBe(401);
    expect((await get("/api/tikz-gallery/file?path=figures/a/figure.tex", {})).statusCode).toBe(401);
  });

  it("exposes nothing the catalog does not list, nor anything outside the add-on", async () => {
    fs.writeFileSync(path.join(root, "outside.tex"), "outside");
    fs.symlinkSync(path.join(root, "outside.tex"), path.join(library, "figures/a/link.tex"));
    write("catalog.json", JSON.stringify({ version: 1, items: [
      { tex: "figures/a/figure.tex", preview: "figures/a/preview.svg" },
      { tex: "figures/a/link.tex", preview: "../outside.tex" }, { tex: ".git/config", preview: "figures/a/meta.json" }
    ] }));
    expect((await file("figures/a/figure.tex")).statusCode).toBe(200);
    for (const relative of [".git/config", "figures/a/meta.json", "figures/a/link.tex", "../outside.tex", "catalog.json"]) {
      expect((await file(relative)).statusCode, relative).toBe(404);
    }
  });

  it("explains a disabled, missing or incompatible add-on, and picks up an update without a restart", async () => {
    write("catalog.json", catalog(2));
    expect((await get("/api/tikz-gallery/catalog")).json()).toMatchObject({ code: "TIKZ_GALLERY_INCOMPATIBLE" });
    write("catalog.json", `${catalog()} `);
    expect((await get("/api/tikz-gallery/catalog")).statusCode).toBe(200);
    fs.rmSync(path.join(library, "catalog.json"));
    expect((await get("/api/tikz-gallery/catalog")).json()).toMatchObject({ code: "TIKZ_GALLERY_UNAVAILABLE" });
    config.tikzGalleryEnabled = false;
    expect((await get("/api/tikz-gallery/catalog")).json()).toMatchObject({ code: "TIKZ_GALLERY_DISABLED" });
    expect((await file("figures/a/figure.tex")).json()).toMatchObject({ code: "TIKZ_GALLERY_DISABLED" });
  });

  it("is off by default and looks in addon/ beside the configuration file", () => {
    const configPath = path.join(root, "config", "texlite.config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const saved = process.env.TEXLITE_DATA_DIR;
    process.env.TEXLITE_DATA_DIR = path.join(root, "config", "data");
    try {
      fs.writeFileSync(configPath, "{}");
      expect(loadConfig(configPath)).toMatchObject({ tikzGalleryEnabled: false, tikzGalleryDir: path.join(root, "config", "addon", "texlite-tikz") });
      fs.writeFileSync(configPath, JSON.stringify({ tikzGallery: { enabled: true, path: "figures" } }));
      expect(loadConfig(configPath)).toMatchObject({ tikzGalleryEnabled: true, tikzGalleryDir: path.join(root, "config", "figures") });
      fs.writeFileSync(configPath, JSON.stringify({ tikzGallery: { enabled: "yes" } }));
      expect(() => loadConfig(configPath)).toThrow("tikzGallery.enabled");
    } finally {
      if (saved === undefined) delete process.env.TEXLITE_DATA_DIR; else process.env.TEXLITE_DATA_DIR = saved;
    }
  });
});
