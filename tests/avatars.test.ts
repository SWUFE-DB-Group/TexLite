import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVATAR_STYLES, isAvatarStyle } from "../src/shared/avatars";
import * as avatars from "../src/server/avatars";
import { loadConfig } from "../src/server/config";
import { openDatabase, type DatabaseConnection } from "../src/server/db";
import type { CollaborationService } from "../src/server/collaboration";
import { registerAvatarRoutes } from "../src/server/routes/avatars";
import { digestToken } from "../src/server/security";

describe("local DiceBear avatar rendering", () => {
  it("supports only Characters styles and preserves upstream license metadata", async () => {
    expect(isAvatarStyle("identicon")).toBe(false);
    expect(isAvatarStyle("shapes")).toBe(false);
    expect(isAvatarStyle("../secret")).toBe(false);
    expect(isAvatarStyle("https://example.org/avatar.svg")).toBe(false);
    for (const style of AVATAR_STYLES) {
      const svg = await avatars.generateUserAvatar("alice", style);
      expect(svg, style).toContain("<svg");
      expect(svg, style).toContain("<metadata");
      expect(svg, style).not.toContain("api.dicebear.com");
    }
    const first = await avatars.generateUserAvatar("alice", "lorelei");
    expect(await avatars.generateUserAvatar("alice", "lorelei")).toBe(first);
    expect(await avatars.generateUserAvatar("bob", "lorelei")).not.toBe(first);
  });
});

describe("avatar persistence and requests", () => {
  let root: string;
  let db: DatabaseConnection;
  let app: FastifyInstance;
  const changed = vi.fn();
  const headers = { cookie: "texlite_session=avatar-session" };
  const save = (style: unknown) => app.inject({ method: "PUT", url: "/api/me/avatar", headers, payload: { style } });
  const get = (url = "/api/users/a/avatar.svg?style=lorelei", extra: Record<string, string> = {}) => app.inject({ url, headers: { ...headers, ...extra } });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-avatars-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ storage: { dataDir: root } }));
    db = openDatabase(loadConfig(path.join(root, "config.json")));
    db.exec(`INSERT INTO users (id, username, display_name, password_hash, role, created_at)
      VALUES ('a', 'alice', 'Alice', 'hash', 'user', '2026-10-21'), ('b', 'bob', 'Bob', 'hash', 'user', '2026-10-21')`);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'a', '2999-01-01', '2026-10-21')")
      .run(digestToken("avatar-session"));
    changed.mockReset();
    app = Fastify();
    await app.register(cookie);
    registerAvatarRoutes(app, { db, collaboration: { updateUserAvatar: changed } as unknown as CollaborationService });
    await app.ready();
  });
  afterEach(async () => {
    await app.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("leaves initials as the default, saves style+SVG atomically, and seeds by username", async () => {
    expect((await get()).statusCode).toBe(404);
    expect(db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_style: null, avatar_svg: null });
    const response = await save("lorelei");
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: "a", avatarStyle: "lorelei" });
    expect(response.json().user).not.toHaveProperty("avatar_svg");
    expect(db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get())
      .toEqual({ avatar_style: "lorelei", avatar_svg: await avatars.generateUserAvatar("alice", "lorelei") });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: "a", avatar_style: "lorelei" }));
    expect(db.prepare("SELECT avatar_style FROM users WHERE id = 'b'").get()).toEqual({ avatar_style: null });
  });

  it("serves stored SVG without regeneration, including browser revalidation", async () => {
    await save("lorelei");
    const render = vi.spyOn(avatars, "generateUserAvatar");
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("image/svg+xml");
    expect(first.headers["cache-control"]).toBe("private, max-age=86400");
    expect(first.headers["content-security-policy"]).toContain("sandbox");
    expect(render).not.toHaveBeenCalled();
    const second = await get(undefined, { "if-none-match": String(first.headers.etag) });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(render).not.toHaveBeenCalled();
  });
  it("automatically renders and persists previously saved style-only avatars once", async () => {
    db.exec("UPDATE users SET avatar_style = 'lorelei' WHERE id = 'a'");
    const render = vi.spyOn(avatars, "generateUserAvatar");
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(render).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_svg: first.body });
    expect((await get()).body).toBe(first.body);
    expect(render).toHaveBeenCalledTimes(1);
  });
  it("lets simultaneous sessions load a style-only avatar during upgrade", async () => {
    db.exec("UPDATE users SET avatar_style = 'lorelei' WHERE id = 'a'");
    const [first, second] = await Promise.all([get(), get()]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });

  it("changes styles and restores default without retaining an SVG", async () => {
    await save("lorelei");
    const original = (await get()).body;
    await save("pixel-art");
    expect((await get("/api/users/a/avatar.svg?style=pixel-art")).body).not.toBe(original);
    expect((await get()).statusCode).toBe(404);
    expect((await save(null)).json().user.avatarStyle).toBeNull();
    expect(db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_style: null, avatar_svg: null });
  });

  it("previews only the current user's Characters styles without persisting them", async () => {
    const response = await get("/api/users/a/avatar.svg?style=lorelei&preview=1");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<svg");
    expect(response.body).toBe(await avatars.generateUserAvatar("alice", "lorelei"));
    expect(db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_style: null, avatar_svg: null });
    expect((await get("/api/users/b/avatar.svg?style=lorelei&preview=1")).statusCode).toBe(403);
    expect((await get("/api/users/a/avatar.svg?style=shapes&preview=1")).statusCode).toBe(400);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["shapes", "../secret", "https://example.org/avatar.svg", "", 123])("rejects unsupported or unsafe styles: %j", async (style) => {
    expect((await save(style)).statusCode).toBe(400);
    expect(changed).not.toHaveBeenCalled();
  });

  it("retains the previous avatar when rendering fails", async () => {
    await save("lorelei");
    const previous = db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get();
    vi.spyOn(avatars, "generateUserAvatar").mockRejectedValueOnce(new Error("Render failed"));
    expect((await save("pixel-art")).statusCode).toBe(500);
    expect(db.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual(previous);
  });

  it("requires authentication before serving or changing avatars", async () => {
    expect((await app.inject({ url: "/api/users/a/avatar.svg" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/me/avatar", payload: { style: "lorelei" } })).statusCode).toBe(401);
  });
});
