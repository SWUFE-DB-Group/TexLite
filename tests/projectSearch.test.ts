import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { createSessionToken } from "../src/server/security.js";
import { resolveSourcePath } from "../src/server/files.js";
import { searchProject } from "../src/server/projectSearch.js";
import type { ProjectSearchResult } from "../src/shared/projectSearch.js";
import { CollaborationService } from "../src/server/collaboration.js";

let root: string, config: Config, db: DatabaseConnection, app: FastifyInstance, projectId: string;
const cookies = new Map<string, string>();
const request = (user: string, body: object, id = projectId) => app.inject({ method: "POST", url: `/api/projects/${id}/search`, headers: { cookie: cookies.get(user) ?? "" }, payload: { caseSensitive: false, wholeWord: false, ...body } });
const replace = (user: string, body: object) => app.inject({ method: "POST", url: `/api/projects/${projectId}/search/replace`, headers: { cookie: cookies.get(user) ?? "" }, payload: body });
async function replacement(query: string, text: string) {
  const { matches } = (await request("owner", { query })).json<ProjectSearchResult>();
  const targets = [...new Set(matches.map((match) => match.path))].map((path) => ({ path,
    sourceHash: matches.find((match) => match.path === path)!.sourceHash,
    ranges: matches.filter((match) => match.path === path).map(({ from, to }) => ({ from, to })) }));
  return { query, caseSensitive: false, wholeWord: false, replacement: text, targets };
}
function write(file: string, text: string | Buffer) { fs.writeFileSync(resolveSourcePath(config, projectId, file), text); }
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-project-search-"));
  const filename = path.join(root, "config.json");
  fs.writeFileSync(filename, JSON.stringify({ storage: { dataDir: path.join(root, "data") }, updates: { enabled: false } }));
  config = loadConfig(filename); db = openDatabase(config); cookies.clear();
  for (const id of ["owner", "reader", "other"]) {
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, created_at) VALUES (?, ?, ?, 'hash', ?, 1, ?)")
      .run(id, id, id, id === "owner" ? "admin" : "user", "2026-11-04");
    const session = createSessionToken(); cookies.set(id, `texlite_session=${session.token}`);
    db.prepare("INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(session.digest, id, "2099-01-01", "2026-11-04");
  }
  app = await buildApp(config, db, { logger: false }); await app.ready();
  const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: cookies.get("owner")! }, payload: { name: "Search test" } });
  expect(created.statusCode, created.body).toBe(201); projectId = created.json().project.id;
  db.prepare("INSERT INTO project_members (project_id,user_id,permission,created_at) VALUES (?,?,'read',?)").run(projectId, "reader", "2026-11-04");
  write("main.tex", "Zou2025 zou2025a zou2025\r\n");
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("project-wide text search", () => {
  it("defaults to case-sensitive whole-word matching", async () => {
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/search`, headers: { cookie: cookies.get("owner")! }, payload: { query: "zou2025" } });
    expect(response.json().matches).toMatchObject([{ column: 18 }]);
    expect(response.json().matches).toHaveLength(1);
  });
  it("searches known text types, but excludes binary content and all unknown extensions", async () => {
    for (const file of ["custom.bib", "README.md", "data.json", "script.bat", ".gitignore"]) write(file, "zou2025");
    write("paper.pdf", "zou2025"); write("unknown.custom", "zou2025");
    write("binary.tex", Buffer.from("zou2025\0binary"));
    write("invalid-utf8.txt", Buffer.from([122, 111, 117, 50, 48, 50, 53, 255]));
    const response = await request("reader", { query: "zou2025" });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ProjectSearchResult>();
    expect(result.matches).toHaveLength(8);
    expect([...new Set(result.matches.map((match) => match.path))].sort()).toEqual([".gitignore", "README.md", "custom.bib", "data.json", "main.tex", "script.bat"]);
    expect(result.limited).toBe(false);
  });

  it("treats metacharacters literally and respects case and Unicode whole-word boundaries", async () => {
    const sensitive = await request("owner", { query: "zou2025", caseSensitive: true, wholeWord: true });
    expect(sensitive.json().matches).toMatchObject([{ path: "main.tex", line: 1, column: 18 }]);
    write("main.tex", "论文 论文a a论文\nliteral .* (x)\n");
    const whole = await request("owner", { query: "论文", wholeWord: true });
    expect(whole.json().matches).toHaveLength(1);
    const literal = await request("owner", { query: ".*" });
    const [match] = literal.json().matches;
    expect(match.preview.slice(match.matchStart, match.matchEnd)).toBe(".*");
    expect(match.line).toBe(2);
  });

  it("crops long lines around the actual match without losing CRLF line or column positions", async () => {
    const source = "first\r\n" + "x".repeat(900) + "needle" + "x".repeat(300) + "needle" + "x".repeat(100);
    write("main.tex", source);
    const response = await request("owner", { query: "needle" });
    const matches = response.json<ProjectSearchResult>().matches;
    expect(matches.map(({ line, column }) => ({ line, column }))).toEqual([{ line: 2, column: 901 }, { line: 2, column: 1207 }]);
    for (const match of matches) {
      expect(match.preview.length).toBeLessThan(200);
      expect(match.preview.slice(match.matchStart, match.matchEnd)).toBe("needle");
      expect(source.slice(match.from, match.to)).toBe("needle");
    }
  });

  it("bounds match output and reports omitted oversized files", async () => {
    write("main.tex", "word ".repeat(501));
    const response = await request("owner", { query: "word" });
    expect(response.json().matches).toHaveLength(500); expect(response.json().limited).toBe(true);
    const smallConfig = { ...config, maxUploadBytes: 20 };
    const skipped = await searchProject(smallConfig, projectId, { query: "word", caseSensitive: false, wholeWord: false });
    expect(skipped).toEqual({ matches: [], limited: true });
  });

  it("requires project access and rejects malformed searches before scanning files", async () => {
    expect((await request("anonymous", { query: "zou" })).statusCode).toBe(401);
    expect((await request("other", { query: "zou" })).statusCode).toBe(404);
    expect((await request("owner", { query: "zou" }, "missing")).statusCode).toBe(404);
    for (const query of [{ query: "" }, { query: "x".repeat(257) }, { query: "a\nb" }, { query: "x", caseSensitive: "true" }, { query: "x", wholeWord: 1 }]) {
      expect((await request("owner", query)).statusCode).toBe(400);
    }
  });

  it("replaces only the selected occurrence, then all remaining matches, preserving CRLF and literal dollar text", async () => {
    write("main.tex", "key key\r\nkeep key\r\n"); write("data.bib", "@article{key,title={key}}\n");
    const body = await replacement("key", "$&");
    const selected = await replace("owner", { ...body, targets: [{ ...body.targets.find((target) => target.path === "main.tex")!, ranges: [{ from: 4, to: 7 }] }] });
    expect(selected.statusCode, selected.body).toBe(200); expect(selected.json()).toEqual({ replaced: 1, files: 1 });
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe("key $&\r\nkeep key\r\n");
    const all = await replace("owner", await replacement("key", "new-key"));
    expect(all.statusCode, all.body).toBe(200); expect(all.json()).toEqual({ replaced: 4, files: 2 });
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe("new-key $&\r\nkeep new-key\r\n");
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "data.bib"), "utf8")).toBe("@article{new-key,title={new-key}}\n");
    expect(db.prepare("SELECT last_modified_by FROM projects WHERE id = ?").get(projectId)).toMatchObject({ last_modified_by: "owner" });
  });

  it("uses exact UTF-16 ranges after Chinese, astral characters and CRLF line breaks", async () => {
    const source = "中文 😀 key key\r\n😀 key\r\n";
    write("main.tex", source);
    const matches = (await request("owner", { query: "key" })).json<ProjectSearchResult>().matches;
    expect(matches.map(({ from, to }) => source.slice(from, to))).toEqual(["key", "key", "key"]);
    expect(matches[1]).toMatchObject({ from: source.indexOf("key", source.indexOf("key") + 1), line: 1, column: 11 });
    expect(matches[2]).toMatchObject({ from: source.lastIndexOf("key"), line: 2, column: 4 });
    const body = await replacement("key", "changed");
    const selected = matches[1];
    const response = await replace("owner", { ...body, targets: [{ path: selected.path, sourceHash: selected.sourceHash, ranges: [{ from: selected.from, to: selected.to }] }] });
    expect(response.statusCode, response.body).toBe(200);
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe("中文 😀 key changed\r\n😀 key\r\n");
  });

  it("rejects partial or nonmatching ranges before editing any target file", async () => {
    write("first.tex", "key"); write("last.tex", "key KEY keyish");
    const body = await replacement("key", "changed");
    const first = body.targets.find((target) => target.path === "first.tex")!;
    const last = body.targets.find((target) => target.path === "last.tex")!;
    for (const range of [{ from: 0, to: 2 }, { from: 1, to: 4 }, { from: 99, to: 102 }, { from: 4, to: 7 }, { from: 8, to: 11 }]) {
      const response = await replace("owner", { ...body, caseSensitive: true, wholeWord: true, targets: [first, { ...last, ranges: [range] }] });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("SEARCH_SOURCE_CHANGED");
      expect(fs.readFileSync(resolveSourcePath(config, projectId, "first.tex"), "utf8")).toBe("key");
      expect(fs.readFileSync(resolveSourcePath(config, projectId, "last.tex"), "utf8")).toBe("key KEY keyish");
    }
  });

  it("validates all source hashes before editing any file, and rejects replayed replacements", async () => {
    write("first.tex", "key"); write("last.tex", "key");
    const body = await replacement("key", "new");
    write("last.tex", "A collaborator changed key");
    const stale = await replace("owner", body);
    expect(stale.statusCode, stale.body).toBe(409); expect(stale.json().code).toBe("SEARCH_SOURCE_CHANGED");
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "first.tex"), "utf8")).toBe("key");
    const current = await replacement("key", "key key");
    expect((await replace("owner", current)).statusCode).toBe(200);
    expect((await replace("owner", current)).statusCode).toBe(409);
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "first.tex"), "utf8")).toBe("key key");
  });

  it("allows deletion, ignores identical replacements, and rejects binary, unknown or oversized results", async () => {
    write("main.tex", "key key\n");
    const unchanged = await replace("owner", await replacement("key", "key"));
    expect(unchanged.json()).toEqual({ replaced: 0, files: 0 });
    const body = await replacement("key", "");
    for (const file of ["paper.pdf", "unknown.custom", "binary.tex"]) {
      write(file, file === "binary.tex" ? "key\0" : "key");
      const invalid = await replace("owner", { ...body, targets: [{ ...body.targets[0], path: file }] });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    expect((await replace("owner", { ...body, replacement: "bad\0text" })).statusCode).toBe(400);
    const uploadLimit = config.maxUploadBytes; config.maxUploadBytes = 8;
    expect((await replace("owner", { ...body, replacement: "larger" })).statusCode).toBe(413);
    config.maxUploadBytes = uploadLimit;
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe("key key\n");
    const deleted = await replace("owner", body); expect(deleted.json()).toEqual({ replaced: 2, files: 1 });
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe(" \n");
  });

  it("rejects reader/anonymous writes, malformed targets and a permission revocation during room preparation", async () => {
    const body = await replacement("zou2025", "changed");
    expect((await replace("reader", body)).statusCode).toBe(403);
    expect((await replace("anonymous", body)).statusCode).toBe(401);
    expect((await replace("other", body)).statusCode).toBe(404);
    const target = body.targets[0];
    for (const targets of [[], [...body.targets, ...body.targets], [{ ...target, path: "../main.tex" }],
      ...[[null], [{ from: -1, to: 2 }], [{ from: 0, to: 0 }], [{ from: 0.5, to: 2 }],
        [{ from: 0, to: 7 }, { from: 0, to: 7 }], [{ from: 0, to: 7 }, { from: 2, to: 9 }]]
        .map((ranges) => [{ ...target, ranges }])]) {
      expect((await replace("owner", { ...body, targets })).statusCode).toBe(400);
    }
    db.prepare("UPDATE project_members SET permission = 'edit' WHERE project_id = ? AND user_id = 'reader'").run(projectId);
    const prepare = CollaborationService.prototype.prepareSourceEditRoom;
    vi.spyOn(CollaborationService.prototype, "prepareSourceEditRoom").mockImplementationOnce(async function (this: CollaborationService, id) {
      await prepare.call(this, id);
      db.prepare("UPDATE project_members SET permission = 'read' WHERE project_id = ? AND user_id = 'reader'").run(id);
    });
    expect((await replace("reader", body)).statusCode).toBe(403);
    expect(fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8")).toBe("Zou2025 zou2025a zou2025\r\n");
  });
});
