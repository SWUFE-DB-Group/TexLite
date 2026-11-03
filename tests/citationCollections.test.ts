import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { createSessionToken } from "../src/server/security.js";
import type { CitationLibraryEntry } from "../src/client/types";
import type { CitationCollection, CitationCollectionCatalog } from "../src/shared/citationCollections.js";
import { CITATION_FOLDER_FORMAT, CITATION_FOLDER_VERSION, MAX_CITATION_FOLDER_BYTES, MAX_CITATION_NOTES_BYTES, type CitationFolderBundle } from "../src/shared/citationTransfer.js";

let root: string, db: DatabaseConnection, app: FastifyInstance;
const cookies = new Map<string, string>();
const call = (method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, user = "alice") => app.inject({ method, url, payload, headers: { cookie: cookies.get(user) ?? "" } });
const list = (query = "") => call("GET", `/api/citations${query}`);
const folders = async () => (await call("GET", "/api/citations/collections")).json<CitationCollectionCatalog>();
async function folder(name: string, user = "alice"): Promise<CitationCollection> {
  const response = await call("POST", "/api/citations/collections", { name }, user);
  expect(response.statusCode, response.body).toBe(201);
  return response.json().collection;
}
async function entry(key: string, collectionIds?: string[], extras: object = {}, user = "alice"): Promise<CitationLibraryEntry> {
  const response = await call("POST", "/api/citations", { citationKey: key, entryType: "article", title: key, bibtex: `@article{${key}, title={${key}}}`, collectionIds, ...extras }, user);
  expect(response.statusCode, response.body).toBe(201);
  return response.json().entry;
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-citation-folders-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ storage: { dataDir: path.join(root, "data") }, updates: { enabled: false } }));
  const config = loadConfig(file); db = openDatabase(config); cookies.clear();
  for (const id of ["alice", "bob", "admin"]) {
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'hash', ?, ?)").run(id, id, id, id === "admin" ? "admin" : "user", new Date().toISOString());
    const token = createSessionToken();
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, '2099-01-01', ?)").run(token.digest, id, new Date().toISOString());
    cookies.set(id, `texlite_session=${token.token}`);
  }
  app = await buildApp(config, db, { logger: false }); await app.ready();
});
afterEach(async () => { await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("private citation folders", () => {
  it("saves private Markdown notes with revision checks, preserves them on project updates and supports explicit clearing", async () => {
    const notes = "# 阅读笔记\n\n- **Useful** result\n- [Source](https://example.org)\n";
    const stored = await entry("noted", undefined, { notes });
    expect(stored.notes).toBe(notes);
    expect((await entry("empty")).notes).toBe("");
    const updated = await call("PATCH", `/api/citations/${stored.id}`, { ...stored, notes: "Revised", expectedRevision: 1 });
    expect(updated.json().entry).toMatchObject({ notes: "Revised", revision: 2 });
    expect((await call("PATCH", `/api/citations/${stored.id}`, { ...stored, notes: "Stale", expectedRevision: 1 })).statusCode).toBe(409);
    const { notes: _notes, ...projectEntry } = updated.json().entry;
    const fromProject = await call("POST", "/api/citations", { ...projectEntry, bibtex: "@article{noted, title={Updated from project}}", overwrite: true, expectedRevision: 2 });
    expect(fromProject.json().entry).toMatchObject({ notes: "Revised", revision: 3 });
    const tagged = await call("PATCH", `/api/citations/${stored.id}/tags`, { tagIds: [], expectedRevision: 3 });
    expect(tagged.json().entry.notes).toBe("Revised");
    const cleared = await call("PATCH", `/api/citations/${stored.id}`, { ...stored, notes: "", expectedRevision: 4 });
    expect(cleared.json().entry).toMatchObject({ notes: "", revision: 5 });
    expect((await call("PATCH", `/api/citations/${stored.id}`, { ...stored, expectedRevision: 5 }, "bob")).statusCode).toBe(404);
    expect((await call("POST", "/api/citations", { ...stored, citationKey: "invalidNotes", notes: null })).statusCode).toBe(400);
    expect((await call("POST", "/api/citations", { ...stored, citationKey: "hugeNotes", notes: "中".repeat(MAX_CITATION_NOTES_BYTES / 3 + 1) })).statusCode).toBe(413);
  });

  it("round-trips a complete folder with notes across users, replaces duplicate keys and adds numeric suffixes to duplicate folder names", async () => {
    const source = await folder("论文主题");
    const notes = "## 中文笔记\n\n**Result** `\\alpha`\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const noted = await entry("PAPER", [source.id], { notes });
    const original = (await list("?q=paper")).json().entries[0];
    for (let index = 0; index < 61; index++) await entry(`ref${index}`, [source.id]);
    const exported = await call("GET", `/api/citations/collections/${source.id}/export?notes=true&pageSize=1`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-disposition"]).toContain(encodeURIComponent("论文主题.texlite-citations.json"));
    const bundle = exported.json<CitationFolderBundle>();
    expect(bundle).toMatchObject({ format: CITATION_FOLDER_FORMAT, version: CITATION_FOLDER_VERSION, name: "论文主题" });
    expect(bundle.entries).toHaveLength(62);
    expect(bundle.entries.find((entry) => entry.citationKey === "PAPER")).toMatchObject({ bibtex: noted.bibtex, notes });
    expect(Object.keys(bundle.entries[0]).sort()).toEqual(["authors", "bibtex", "citationKey", "entryType", "notes", "title", "year"]);
    expect((await call("GET", `/api/citations/collections/${source.id}/export`)).body).not.toContain(notes);
    const existingFolder = await folder("论文主题", "bob"); await folder("论文主题-1", "bob");
    const tag = (await call("POST", "/api/citations/tags", { name: "Keep", color: "blue" }, "bob")).json().tag;
    const existing = await entry("paper", [existingFolder.id], { notes: "Old", tagIds: [tag.id] }, "bob");
    const imported = await call("POST", "/api/citations/collections/import", bundle, "bob");
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json()).toMatchObject({ imported: 62, collection: { name: "论文主题-2", entryCount: 62 } });
    const id = imported.json().collection.id;
    const bob = (await call("GET", `/api/citations?collection=${id}&q=paper`, undefined, "bob")).json().entries[0];
    expect(bob).toMatchObject({ id: existing.id, citationKey: "PAPER", notes, revision: 2 });
    expect(bob.collectionIds).toEqual(expect.arrayContaining([id, existingFolder.id]));
    expect(bob.tags).toEqual([tag]);
    expect((await call("GET", `/api/citations?q=paper`)).json().entries[0]).toEqual(original);
    expect((await call("GET", `/api/citations/collections/${source.id}/export?notes=true`, undefined, "bob")).statusCode).toBe(404);
    expect((await call("POST", "/api/citations/collections/import", bundle, "anonymous")).statusCode).toBe(401);
    // Re-importing is deterministic and never reuses an existing folder.
    expect((await call("POST", "/api/citations/collections/import", bundle, "bob")).json().collection.name).toBe("论文主题-3");
  });

  it("rejects invalid imports without partial changes and rolls back database failures, while allowing empty folders", async () => {
    const existing = await entry("paper", undefined, { notes: "Keep" });
    const before = (await list()).json().entries[0];
    const bundle: CitationFolderBundle = { format: CITATION_FOLDER_FORMAT, version: CITATION_FOLDER_VERSION, name: "Import",
      entries: [{ ...existing, notes: "Replacement" }] };
    for (const payload of [
      { ...bundle, format: "unknown" }, { ...bundle, version: 2 }, { ...bundle, name: " " },
      { ...bundle, entries: [bundle.entries[0], { ...bundle.entries[0], notes: null }] },
      { ...bundle, entries: [bundle.entries[0], { ...bundle.entries[0], bibtex: "" }] },
      { ...bundle, entries: [{ ...bundle.entries[0], notes: "x".repeat(MAX_CITATION_NOTES_BYTES + 1) }] }
    ]) expect((await call("POST", "/api/citations/collections/import", payload)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await folders()).collections).toEqual([]);
    expect((await list()).json().entries[0]).toEqual(before);
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON citation_library_entries WHEN NEW.citation_key = 'fail' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const failure = await call("POST", "/api/citations/collections/import", { ...bundle, entries: [bundle.entries[0], { ...bundle.entries[0], citationKey: "fail" }] });
    expect(failure.statusCode).toBe(500);
    expect((await folders()).collections).toEqual([]);
    expect((await list()).json().entries[0]).toEqual(before);
    const empty = await folder("Empty");
    const emptyBundle = (await call("GET", `/api/citations/collections/${empty.id}/export?notes=true`)).json();
    const imported = await call("POST", "/api/citations/collections/import", emptyBundle);
    expect(imported.json()).toMatchObject({ collection: { name: "Empty-1", entryCount: 0 }, imported: 0 });
    const duplicates = await call("POST", "/api/citations/collections/import", { ...bundle, entries: [bundle.entries[0], { ...bundle.entries[0], citationKey: "PAPER", notes: "Last wins" }] });
    expect(duplicates.json().imported).toBe(1);
    expect((await list()).json().entries[0]).toMatchObject({ id: existing.id, notes: "Last wins", revision: 2 });
  });

  it("bounds folder transfers without returning truncated exports or leaving a database iterator open", async () => {
    const source = await folder("Large");
    const notes = "x".repeat(MAX_CITATION_NOTES_BYTES);
    // Just over the transfer limit, built directly to avoid hundreds of HTTP calls.
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO citation_library_entries (id,user_id,citation_key,entry_type,bibtex,notes,created_at,updated_at) VALUES (?,'alice',?,'misc','@misc{x}',?,'2026','2026')");
      const place = db.prepare("INSERT INTO citation_library_entry_collections (entry_id, collection_id) VALUES (?, ?)");
      for (let i = 0; i < MAX_CITATION_FOLDER_BYTES / MAX_CITATION_NOTES_BYTES; i++) { insert.run(`large${i}`, `large${i}`, notes); place.run(`large${i}`, source.id); }
    })();
    const response = await call("GET", `/api/citations/collections/${source.id}/export?notes=true`);
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe("CITATION_FOLDER_TOO_LARGE");
    await folder("Still writable");
    const tooLarge = await call("POST", "/api/citations/collections/import", { padding: "x".repeat(MAX_CITATION_FOLDER_BYTES) });
    expect(tooLarge.statusCode).toBe(413);
    expect((await folders()).collections).toHaveLength(2);
  });
  it("compares project entries without returning library text, treating only line endings and outer whitespace as insignificant", async () => {
    const stored = await entry("paper", undefined, { bibtex: "@article{paper,\n title={Original}\n}" });
    const unchanged = await call("POST", "/api/citations/lookup", { entries: [{ citationKey: "PAPER", bibtex: ` \r\n${stored.bibtex.replaceAll("\n", "\r\n")}\r\n ` }] });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().matches).toEqual([{ id: stored.id, citationKey: "paper", revision: 1, sameContent: true }]);
    const changed = await call("POST", "/api/citations/lookup", { entries: [{ citationKey: "paper", bibtex: stored.bibtex.replace("Original", "Edited") }, { citationKey: "missing", bibtex: "@article{missing, title={Missing}}" }] });
    expect(changed.json().matches).toEqual([{ id: stored.id, citationKey: "paper", revision: 1, sameContent: false }]);
    expect(changed.body).not.toContain("Original");
    expect((await call("POST", "/api/citations/lookup", { entries: [{ citationKey: "paper", bibtex: stored.bibtex }] }, "bob")).json().matches).toEqual([]);
    const before = (await list()).json().entries[0];
    expect(before.revision).toBe(1);
    for (const body of [{ entries: [null] }, { entries: [{ citationKey: "paper", bibtex: 123 }] }, { entries: [{ citationKey: "paper", bibtex: "" }] }, { keys: ["paper"], entries: [] }]) {
      expect((await call("POST", "/api/citations/lookup", body)).statusCode).toBe(400);
    }
    const huge = await call("POST", "/api/citations/lookup", { entries: [{ citationKey: "paper", bibtex: "a".repeat(512 * 1024 + 1) }] });
    expect(huge.statusCode).toBe(413);
    expect((await list()).json().entries[0]).toEqual(before);
  });
  it("creates, renames and validates case-insensitive per-user names", async () => {
    expect(await folders()).toEqual({ collections: [], total: 0, unfiled: 0 });
    const a = await folder("  Paper A  "); expect(a.name).toBe("Paper A");
    expect((await call("POST", "/api/citations/collections", { name: "paper a" })).statusCode).toBe(409);
    const b = await folder("Paper B");
    expect((await call("PATCH", `/api/citations/collections/${a.id}`, { name: "paper B" })).statusCode).toBe(409);
    expect((await call("PATCH", `/api/citations/collections/${a.id}`, { name: "Revised" })).statusCode).toBe(200);
    for (const name of ["", " ", 123, "x".repeat(81)]) expect((await call("POST", "/api/citations/collections", { name })).statusCode).toBe(400);
    await folder("Paper B", "bob");
    expect((await folders()).collections.map((item) => item.name)).toEqual([b.name, "Revised"]);
  });

  it("places one reference in multiple folders without duplicating it and combines folder, tag, search and pagination filters", async () => {
    const a = await folder("A"), b = await folder("B");
    const tag = (await call("POST", "/api/citations/tags", { name: "Method", color: "blue" })).json().tag;
    const one = await entry("one", [a.id, b.id, a.id], { tagIds: [tag.id] });
    await entry("two", [a.id], { tagIds: [tag.id] });
    await entry("three", [a.id]); await entry("unfiled");
    expect(one.collectionIds).toEqual([a.id, b.id]);
    expect((await list()).json().pagination.total).toBe(4);
    const filtered = (await list(`?collection=${a.id}&tag=${tag.id}&pageSize=1&page=2`)).json();
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.pagination).toMatchObject({ total: 2, totalPages: 2, page: 2 });
    expect((await list(`?collection=${a.id}&tag=${tag.id}&q=one`)).json().entries.map((item: CitationLibraryEntry) => item.id)).toEqual([one.id]);
    expect((await list("?collection=unfiled")).json().entries.map((item: CitationLibraryEntry) => item.citationKey)).toEqual(["unfiled"]);
    expect(await folders()).toEqual({ collections: [{ ...a, entryCount: 3 }, { ...b, entryCount: 1 }], total: 4, unfiled: 1 });
  });

  it("rejects stale or invalid assignments atomically and allows removing every placement", async () => {
    const a = await folder("A"), b = await folder("B"), saved = await entry("one", [a.id]);
    const target = `/api/citations/${saved.id}/collections`;
    const changed = await call("PATCH", target, { collectionIds: [b.id], expectedRevision: saved.revision });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().entry).toMatchObject({ collectionIds: [b.id], revision: 2, bibtex: saved.bibtex });
    expect((await call("PATCH", target, { collectionIds: [a.id], expectedRevision: 1 })).statusCode).toBe(409);
    for (const ids of [undefined, "bad", [12], [""], Array(101).fill(a.id)]) expect((await call("PATCH", target, { collectionIds: ids, expectedRevision: 2 })).statusCode).toBe(400);
    expect((await list()).json().entries[0].collectionIds).toEqual([b.id]);
    const clear = await call("PATCH", target, { collectionIds: [], expectedRevision: 2 });
    expect(clear.json().entry).toMatchObject({ collectionIds: [], revision: 3 });
    expect((await list("?collection=unfiled")).json().pagination.total).toBe(1);
  });

  it("adds the destination folder when saving an existing project reference without removing other placements or tags", async () => {
    const a = await folder("A"), b = await folder("B"), saved = await entry("one", [a.id]);
    const response = await call("POST", "/api/citations", { ...saved, title: "Updated", collectionIds: [b.id], overwrite: true, expectedRevision: saved.revision });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().entry.collectionIds).toEqual([a.id, b.id]);
    const updated = await call("PATCH", `/api/citations/${saved.id}`, { ...saved, title: "Edited again", expectedRevision: 2 });
    expect(updated.json().entry).toMatchObject({ collectionIds: [a.id, b.id], revision: 3 });
    const tagged = await call("PATCH", `/api/citations/${saved.id}/tags`, { tagIds: [], expectedRevision: 3 });
    expect(tagged.json().entry.collectionIds).toEqual([a.id, b.id]);
  });

  it("deletes folders without deleting references and cascades membership when an entry or user is deleted", async () => {
    const a = await folder("A"), b = await folder("B");
    const kept = await entry("one", [a.id, b.id]), unfiled = await entry("two", [a.id]);
    await call("DELETE", `/api/citations/collections/${a.id}`);
    const all = (await list()).json().entries as CitationLibraryEntry[];
    expect(all).toHaveLength(2);
    expect(all.find((item) => item.id === kept.id)).toMatchObject({ bibtex: kept.bibtex, collectionIds: [b.id] });
    expect(all.find((item) => item.id === unfiled.id)?.collectionIds).toEqual([]);
    await call("DELETE", `/api/citations/${kept.id}`);
    expect((await folders()).collections[0].entryCount).toBe(0);
    db.prepare("DELETE FROM users WHERE id = 'alice'").run();
    expect(db.prepare("SELECT * FROM citation_library_entry_collections").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM citation_library_collections").all()).toEqual([]);
  });

  it("exports every reference, not just the current page, with stable BibTeX and a safe Unicode filename", async () => {
    const a = await folder("论文/主题"), b = await folder("Other");
    for (let index = 0; index < 63; index++) await entry(`paper${String(index).padStart(2, "0")}`, [a.id]);
    await entry("excluded", [b.id]);
    const unicode = await entry("unicode", [a.id], { bibtex: "@article{unicode, title={{中文} \\LaTeX}, author={Bj{\\\"o}rn}}" });
    const response = await call("GET", `/api/citations/collections/${a.id}/export?pageSize=1&page=2&q=excluded`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-bibtex");
    expect(response.headers["content-disposition"]).toContain(encodeURIComponent("论文_主题.bib"));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.match(/@article\{/g)).toHaveLength(64);
    expect(response.body).toContain(unicode.bibtex);
    expect(response.body).not.toContain("excluded");
    expect(response.body.indexOf("paper00")).toBeLessThan(response.body.indexOf("paper62"));
    expect((await list(`?collection=${a.id}`)).json().entries).toHaveLength(60);
    const head = await call("HEAD", `/api/citations/collections/${a.id}/export`);
    expect(head.statusCode).toBe(200); expect(head.body).toBe("");
    // HEAD must not leave a lazy export iterator holding the database busy.
    const empty = await folder("Empty");
    expect((await call("GET", `/api/citations/collections/${empty.id}/export`)).body).toBe("");
  });

  it("isolates collections and membership operations by user, including administrators and exports", async () => {
    const a = await folder("Private"), own = await entry("private", [a.id]), foreign = await entry("other", undefined, {}, "bob");
    for (const user of ["bob", "admin", "anonymous"]) {
      const status = user === "anonymous" ? 401 : 404;
      for (const [method, url, payload] of [
        ["PATCH", `/api/citations/collections/${a.id}`, { name: "Hijacked" }],
        ["DELETE", `/api/citations/collections/${a.id}`, undefined],
        ["GET", `/api/citations/collections/${a.id}/export`, undefined],
        ["GET", `/api/citations?collection=${a.id}`, undefined],
        ["PATCH", `/api/citations/${own.id}/collections`, { collectionIds: [], expectedRevision: 1 }]
      ] as const) expect((await call(method, url, payload, user)).statusCode).toBe(status);
    }
    expect((await call("PATCH", `/api/citations/${foreign.id}/collections`, { collectionIds: [a.id], expectedRevision: 1 }, "bob")).statusCode).toBe(404);
    expect((await call("POST", "/api/citations", { citationKey: "wrong", entryType: "article", bibtex: "@article{wrong}", collectionIds: [a.id] }, "bob")).statusCode).toBe(404);
    expect((await call("GET", "/api/citations/collections", undefined, "bob")).json()).toEqual({ collections: [], total: 1, unfiled: 1 });
    expect((await list()).json().entries[0].collectionIds).toEqual([a.id]);
  });
});
