import { createTestConfig } from "./helpers/testConfig";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, pruneExpiredSessions } from "../src/server/db.js";

function migrationConfig(root: string, databasePath: string): Config {
  return createTestConfig(root, {
    siteName: "Migration", databasePath, allowedEngines: ["pdflatex", "xelatex", "lualatex"], maxUploadBytes: 50 * 1024 * 1024
  });
}

describe("database migrations", () => {
  it("adds empty citation notes on upgrade and preserves content, revisions and saved notes across restarts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-citation-notes-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE citation_library_entries DROP COLUMN notes;
        DELETE FROM texlite_schema_migrations WHERE version >= 19;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('owner', 'owner', 'Owner', 'hash', 'user', '2026-11-03');
        INSERT INTO citation_library_entries (id, user_id, citation_key, entry_type, bibtex, revision, created_at, updated_at)
          VALUES ('entry', 'owner', 'old', 'article', '@article{old,title={Original}}', 3, '2026-11-02', '2026-11-03');`);
      const before = database.prepare("SELECT * FROM citation_library_entries").get() as object;
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM citation_library_entries").get()).toEqual({ ...before, notes: "" });
      database.prepare("UPDATE citation_library_entries SET notes = ? WHERE id = 'entry'").run("# 阅读笔记\n\n**Keep** this.");
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 19").get();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM citation_library_entries").get()).toEqual({ ...before, notes: "# 阅读笔记\n\n**Keep** this." });
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 19").get()).toEqual(applied);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("adds a citation venue column without changing existing entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-citation-venue-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE citation_library_entries DROP COLUMN venue;
        DELETE FROM texlite_schema_migrations WHERE version >= 21;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('owner', 'owner', 'Owner', 'hash', 'user', '2026-11-03');
        INSERT INTO citation_library_entries (id, user_id, citation_key, entry_type, bibtex, revision, created_at, updated_at)
          VALUES ('entry', 'owner', 'old', 'article', '@article{old,title={Original}}', 3, '2026-11-02', '2026-11-03');`);
      const before = database.prepare("SELECT * FROM citation_library_entries").get() as object;
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM citation_library_entries").get()).toEqual({ ...before, venue: null });
      database.prepare("UPDATE citation_library_entries SET venue = ? WHERE id = 'entry'").run("Journal of Testing");
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 21").get();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM citation_library_entries").get()).toEqual({ ...before, venue: "Journal of Testing" });
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 21").get()).toEqual(applied);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("adds agent flags to snapshots and edit segments, leaving existing history unflagged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-history-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE project_history_versions DROP COLUMN has_agent;
        ALTER TABLE project_edit_segments DROP COLUMN has_agent;
        DELETE FROM texlite_schema_migrations WHERE version >= 22;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('owner', 'owner', 'Owner', 'hash', 'user', '2026-11-03');
        INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at) VALUES ('p', 'owner', 'Paper', 'main.tex', 'pdflatex', '2026-11-03', '2026-11-03');
        INSERT INTO project_history_versions (id, project_id, author_id, reason, manifest_json, changed_paths_json, created_at)
          VALUES ('v', 'p', 'owner', 'autosave', '{}', '["main.tex"]', '2026-11-03');
        INSERT INTO project_edit_segments (id, project_id, file_path, author_id, kind, before_hash, after_hash, steps_json, created_at, updated_at)
          VALUES ('s', 'p', 'main.tex', 'owner', 'edit', 'a', 'b', '[]', '2026-11-03', '2026-11-03');`);
      const version = database.prepare("SELECT * FROM project_history_versions").get() as object;
      const segment = database.prepare("SELECT * FROM project_edit_segments").get() as object;
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM project_history_versions").get()).toEqual({ ...version, has_agent: 0 });
      expect(database.prepare("SELECT * FROM project_edit_segments").get()).toEqual({ ...segment, has_agent: 0 });
      database.prepare("UPDATE project_history_versions SET has_agent = 1").run();
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 22").get();
      database.close(); database = openDatabase(config);
      // Reopening neither reapplies the migration nor resets recorded flags.
      expect(database.prepare("SELECT has_agent FROM project_history_versions").get()).toEqual({ has_agent: 1 });
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 22").get()).toEqual(applied);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("indexes the objects of existing snapshots and keeps the index in step with later snapshot changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-history-objects-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    const manifest = (files: Record<string, [string, number]>) => JSON.stringify({ version: 1, settings: {},
      files: Object.fromEntries(Object.entries(files).map(([filePath, [digest, size]]) => [filePath, { digest, size }])) });
    const objects = () => database.prepare("SELECT version_id, project_id, digest, size FROM project_history_version_objects ORDER BY version_id, digest").all();
    const counts = () => database.prepare("SELECT project_id, digest, size, refs FROM project_history_objects ORDER BY digest").all();
    try {
      database.exec(`DROP TRIGGER project_history_versions_objects_insert;
        DROP TRIGGER project_history_versions_objects_update;
        DROP TABLE project_history_version_objects;
        DROP TABLE project_history_objects;
        DELETE FROM texlite_schema_migrations WHERE version >= 23;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('owner', 'owner', 'Owner', 'hash', 'user', '2026-11-03');
        INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at) VALUES ('p', 'owner', 'Paper', 'main.tex', 'pdflatex', '2026-11-03', '2026-11-03');`);
      const insert = { run: (id: string, json: string) => database.prepare(`INSERT INTO project_history_versions
        (id, project_id, author_id, reason, manifest_json, changed_paths_json, created_at)
        VALUES (?, 'p', 'owner', 'autosave', ?, '["main.tex"]', '2026-11-03')`).run(id, json) };
      // Two paths with identical contents share one object.
      insert.run("old", manifest({ "main.tex": ["a", 1], "copy.tex": ["a", 1], "refs.bib": ["b", 2] }));
      database.close(); database = openDatabase(config);
      expect(objects()).toEqual([
        { version_id: "old", project_id: "p", digest: "a", size: 1 },
        { version_id: "old", project_id: "p", digest: "b", size: 2 }
      ]);
      insert.run("other", manifest({ "main.tex": ["a", 1] }));
      expect(counts()).toEqual([{ project_id: "p", digest: "a", size: 1, refs: 2 }, { project_id: "p", digest: "b", size: 2, refs: 1 }]);
      database.prepare("DELETE FROM project_history_versions WHERE id = 'other'").run();
      insert.run("new", manifest({ "main.tex": ["c", 3] }));
      database.prepare("UPDATE project_history_versions SET manifest_json = ? WHERE id = 'new'").run(manifest({ "main.tex": ["d", 4] }));
      database.prepare("DELETE FROM project_history_versions WHERE id = 'old'").run();
      expect(objects()).toEqual([{ version_id: "new", project_id: "p", digest: "d", size: 4 }]);
      expect(counts()).toEqual([{ project_id: "p", digest: "d", size: 4, refs: 1 }]);
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 23").get();
      database.close(); database = openDatabase(config);
      expect(objects()).toEqual([{ version_id: "new", project_id: "p", digest: "d", size: 4 }]);
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 23").get()).toEqual(applied);
      // Deleting the project removes its snapshots and their index rows.
      database.prepare("DELETE FROM projects WHERE id = 'p'").run();
      expect(objects()).toEqual([]);
      expect(counts()).toEqual([]);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("automatically adds citation folders without changing existing references and retains folders across restarts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-citation-folders-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`DROP TABLE citation_library_entry_collections;
        DROP TABLE citation_library_collections;
        DELETE FROM texlite_schema_migrations WHERE version >= 18;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('owner', 'owner', 'Owner', 'hash', 'user', '2026-11-02');
        INSERT INTO citation_library_entries (id, user_id, citation_key, entry_type, bibtex, revision, created_at, updated_at)
          VALUES ('entry', 'owner', 'old', 'article', '@article{old,title={Original}}', 3, '2026-11-02', '2026-11-02');`);
      const before = database.prepare("SELECT * FROM citation_library_entries").all();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM citation_library_entries").all()).toEqual(before);
      expect(database.prepare("SELECT * FROM citation_library_collections").all()).toEqual([]);
      database.exec(`INSERT INTO citation_library_collections (id, user_id, name, created_at) VALUES ('folder', 'owner', 'Paper', '2026-11-02');
        INSERT INTO citation_library_entry_collections (entry_id, collection_id) VALUES ('entry', 'folder');`);
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 18").get();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 18").get()).toEqual(applied);
      expect(database.prepare("SELECT * FROM citation_library_entry_collections").all()).toEqual([{ entry_id: "entry", collection_id: "folder" }]);
      database.prepare("DELETE FROM citation_library_collections WHERE id = 'folder'").run();
      expect(database.prepare("SELECT * FROM citation_library_entry_collections").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM citation_library_entries").all()).toEqual(before);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("adds encrypted-link storage without rotating or deleting pre-existing hash-only links", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-view-copy-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE project_view_links DROP COLUMN token_ciphertext;
        DELETE FROM texlite_schema_migrations WHERE version >= 17;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES ('owner', 'owner', 'Owner', 'hash', 'admin', '2026-11-01');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at)
          VALUES ('paper', 'owner', 'Existing paper', '2026-11-01', '2026-11-01');
        INSERT INTO project_view_links (id, project_id, token_hash, created_at, expires_at)
          VALUES ('link', 'paper', 'existing-token-hash', '2026-11-01', '2099-01-01');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT token_hash, token_ciphertext, expires_at FROM project_view_links WHERE id = 'link'").get())
        .toEqual({ token_hash: "existing-token-hash", token_ciphertext: null, expires_at: "2099-01-01" });
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 17").get();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 17").get()).toEqual(applied);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("removes previously revoked view links while preserving active and expired links", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-view-revocation-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE project_view_links ADD COLUMN revoked_at TEXT;
        DELETE FROM texlite_schema_migrations WHERE version >= 16;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES ('owner', 'owner', 'Owner', 'hash', 'admin', '2026-11-01');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at)
          VALUES ('paper', 'owner', 'Existing paper', '2026-11-01', '2026-11-01');
        INSERT INTO project_view_links (id, project_id, token_hash, label, created_at, expires_at, revoked_at) VALUES
          ('active', 'paper', 'active-hash', 'Active reader', '2026-11-01', '2099-01-01', NULL),
          ('expired', 'paper', 'expired-hash', 'Past review', '2026-11-01', '2000-01-01', NULL),
          ('revoked', 'paper', 'revoked-hash', 'Revoked reader', '2026-11-01', NULL, '2026-11-02');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT id, token_hash, label, expires_at FROM project_view_links ORDER BY id").all()).toEqual([
        { id: "active", token_hash: "active-hash", label: "Active reader", expires_at: "2099-01-01" },
        { id: "expired", token_hash: "expired-hash", label: "Past review", expires_at: "2000-01-01" }
      ]);
      expect(database.prepare("PRAGMA table_info(project_view_links)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "revoked_at" })]));
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 16").get();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 16").get()).toEqual(applied);
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_view_links").get()).toEqual({ count: 2 });
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("automatically adds anonymous reader links to an existing database without changing accounts or memberships", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-view-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`DROP TABLE project_view_links;
        DELETE FROM texlite_schema_migrations WHERE version >= 15;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES ('owner', 'owner', 'Owner', 'hash', 'admin', '2026-11-01');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at)
          VALUES ('paper', 'owner', 'Existing paper', '2026-11-01', '2026-11-01');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT name FROM projects").get()).toEqual({ name: "Existing paper" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT * FROM project_members").all()).toEqual([]);
      database.prepare("INSERT INTO project_view_links (id, project_id, token_hash, created_at) VALUES ('link', 'paper', 'hash', '2026-11-01')").run();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT id FROM project_view_links").all()).toEqual([{ id: "link" }]);
      database.prepare("DELETE FROM projects WHERE id = 'paper'").run();
      expect(database.prepare("SELECT * FROM project_view_links").all()).toEqual([]);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("restores suggestion-only reviewers from the development schema without losing review or recovery state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-reviewer-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE comments ADD COLUMN reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE comment_suggestions DROP COLUMN reviewer_id;
        DELETE FROM texlite_schema_migrations WHERE version >= 14;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES
          ('a', 'author', 'Author', 'hash', 'admin', '2026-11-01'), ('r', 'reviewer', 'Reviewer', 'hash', 'user', '2026-11-01');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p', 'a', 'Paper', '2026-11-01', '2026-11-01');
        INSERT INTO comments (id, project_id, file_path, author_id, content, reviewer_id, created_at, updated_at) VALUES
          ('edit', 'p', 'main.tex', 'a', 'Edit note', 'r', '2026-11-01', '2026-11-01'), ('plain', 'p', 'main.tex', 'a', 'Plain note', 'r', '2026-11-01', '2026-11-01');
        INSERT INTO comment_suggestions (comment_id, original_text, replacement_text, decided_by, decided_at, apply_update, apply_range)
          VALUES ('edit', 'old', 'new', 'r', '2026-11-01T12:00:00Z', X'0000', '[]');
        INSERT INTO comment_mentions (id, project_id, comment_id, mentioned_user_id, created_at, read_at, read_reason, kind) VALUES
          ('review', 'p', 'edit', 'r', '2026-11-01', '2026-11-02', 'manual', 'review'),
          ('retired-review', 'p', 'plain', 'r', '2026-11-01', NULL, NULL, 'review'),
          ('mention', 'p', 'plain', 'a', '2026-11-01', NULL, NULL, 'mention');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("PRAGMA table_info(comments)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "reviewer_id" })]));
      expect(database.prepare("SELECT id, content FROM comments ORDER BY id").all()).toEqual([
        { id: "edit", content: "Edit note" }, { id: "plain", content: "Plain note" }
      ]);
      expect(database.prepare("SELECT * FROM comment_suggestions").get()).toMatchObject({ reviewer_id: "r", original_text: "old", replacement_text: "new", status: "pending",
        decided_by: "r", decided_at: "2026-11-01T12:00:00Z", apply_update: Buffer.from([0, 0]), apply_range: "[]" });
      expect(database.prepare("SELECT id, read_at, kind FROM comment_mentions ORDER BY id").all()).toEqual([
        { id: "mention", read_at: null, kind: "mention" }, { id: "review", read_at: "2026-11-02", kind: "review" }
      ]);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT reviewer_id FROM comment_suggestions").get()).toEqual({ reviewer_id: "r" });
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("automatically upgrades existing comments and mentions without changing their content or read status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-suggestion-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`DROP TABLE comment_suggestions;
        ALTER TABLE comment_mentions DROP COLUMN kind;
        DELETE FROM texlite_schema_migrations WHERE version >= 12;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('u', 'owner', 'Owner', 'hash', 'admin', '2026-11-01');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p', 'u', 'Paper', '2026-11-01', '2026-11-01');
        INSERT INTO comments (id, project_id, file_path, author_id, content, created_at, updated_at) VALUES ('c', 'p', 'main.tex', 'u', 'Keep this discussion', '2026-11-01', '2026-11-01');
        INSERT INTO comment_mentions (id, project_id, comment_id, mentioned_user_id, created_at, read_at, read_reason) VALUES ('m', 'p', 'c', 'u', '2026-11-01', '2026-11-02', 'manual');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT content, resolved FROM comments WHERE id = 'c'").get()).toEqual({ content: "Keep this discussion", resolved: 0 });
      expect(database.prepare("SELECT kind, read_at, read_reason FROM comment_mentions WHERE id = 'm'").get()).toEqual({ kind: "mention", read_at: "2026-11-02", read_reason: "manual" });
      database.exec("INSERT INTO comment_suggestions (comment_id, original_text, replacement_text, reviewer_id) VALUES ('c', 'old', 'new', 'u')");
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT original_text, status FROM comment_suggestions WHERE comment_id = 'c'").get()).toEqual({ original_text: "old", status: "pending" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM texlite_schema_migrations WHERE version = 12").get()).toEqual({ count: 1 });
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("upgrades existing agent tasks with a durable native-cleanup checkpoint without resetting completed work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-cleanup-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE agent_tasks DROP COLUMN native_cleanup_done;
        DELETE FROM texlite_schema_migrations WHERE version >= 11;
        INSERT INTO agent_tasks (id, project_id, user_id, project_name, user_name, agent_id, title,
          state, cleanup_state, ever_started, created_at, updated_at)
        VALUES ('task', 'project', 'writer', 'Paper', 'Writer', 'claude', 'Revise',
          'stopped', 'failed', 1, '2026-10-28', '2026-10-28');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT native_cleanup_done, ever_started, cleanup_state FROM agent_tasks WHERE id = 'task'").get())
        .toEqual({ native_cleanup_done: 0, ever_started: 1, cleanup_state: "failed" });
      const migration = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 11").get();
      expect(migration).toMatchObject({ name: "track_agent_native_cleanup_completion" });
      database.prepare("UPDATE agent_tasks SET native_cleanup_done = 1 WHERE id = 'task'").run();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT native_cleanup_done FROM agent_tasks WHERE id = 'task'").get()).toEqual({ native_cleanup_done: 1 });
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 11").get()).toEqual(migration);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("automatically adds shared snapshot file choices and preserves them across restarts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-history-files-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`DROP TABLE project_history_files; DELETE FROM texlite_schema_migrations WHERE version >= 9;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES ('u', 'owner', 'Owner', 'hash', 'user', '2026-10-23');
        INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at)
          VALUES ('p', 'u', 'Paper', 'main.tex', 'pdflatex', '2026-10-23', '2026-10-23');`);
      database.close(); database = openDatabase(config);
      database.prepare("INSERT INTO project_history_files VALUES ('p', 'main.tex', 0)").run();
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT path, included FROM project_history_files WHERE project_id = 'p'").all())
        .toEqual([{ path: "main.tex", included: 0 }]);
      database.prepare("DELETE FROM projects WHERE id = 'p'").run();
      expect(database.prepare("SELECT * FROM project_history_files").all()).toEqual([]);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("invalidates old seeded images once while preserving chosen styles and newly generated SVGs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-avatar-seed-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`DELETE FROM texlite_schema_migrations WHERE version >= 8;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at, avatar_style, avatar_svg)
          VALUES ('a', 'alice', 'Alice', 'hash', 'user', '2026-10-21', 'lorelei', '<svg>old ID seed</svg>');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get())
        .toEqual({ avatar_style: "lorelei", avatar_svg: null });
      database.prepare("UPDATE users SET avatar_svg = ? WHERE id = 'a'").run("<svg>new username seed</svg>");
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_svg FROM users WHERE id = 'a'").get())
        .toEqual({ avatar_svg: "<svg>new username seed</svg>" });
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("migrates existing users to initial avatars and retains saved SVGs on reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-avatar-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE users DROP COLUMN avatar_style; ALTER TABLE users DROP COLUMN avatar_svg;
        DELETE FROM texlite_schema_migrations WHERE version >= 6;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
        VALUES ('a', 'alice', 'Alice', 'hash', 'user', '2026-10-21');`);
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_style: null, avatar_svg: null });
      database.exec("UPDATE users SET avatar_style = 'lorelei', avatar_svg = '<svg/>' WHERE id = 'a'");
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_style: "lorelei", avatar_svg: "<svg/>" });
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("automatically adds SVG storage after the already-recorded style-only migration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-avatar-svg-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE users DROP COLUMN avatar_svg;
        DELETE FROM texlite_schema_migrations WHERE version >= 7;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at, avatar_style)
        VALUES ('a', 'alice', 'Alice', 'hash', 'user', '2026-10-21', 'lorelei');`);
      expect(database.prepare("SELECT name FROM texlite_schema_migrations WHERE version = 6").get())
        .toEqual({ name: "add_user_avatar_style" });
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_style, avatar_svg FROM users WHERE id = 'a'").get())
        .toEqual({ avatar_style: "lorelei", avatar_svg: null });
      const migration = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 7").get();
      expect(migration).toMatchObject({ name: "add_user_avatar_svg" });
      database.prepare("UPDATE users SET avatar_svg = ? WHERE id = 'a'").run("<svg/>");
      database.close(); database = openDatabase(config);
      expect(database.prepare("SELECT avatar_svg FROM users WHERE id = 'a'").get()).toEqual({ avatar_svg: "<svg/>" });
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 7").get()).toEqual(migration);
    } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("upgrades version 3 comments without inventing resolution metadata and preserves new records on reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-resolution-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      // Recreate the released version-3 shape with an already-resolved comment.
      database.exec(`
        ALTER TABLE comments DROP COLUMN resolved_by;
        ALTER TABLE comments DROP COLUMN resolved_at;
        DELETE FROM texlite_schema_migrations WHERE version >= 4;
        DROP TABLE update_check_cache;
        DROP TABLE dismissed_updates;
        INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES ('owner', 'owner', 'Owner', 'hash', 'admin', '2026-01-01T00:00:00Z');
        INSERT INTO projects (id, owner_id, name, created_at, updated_at)
          VALUES ('paper', 'owner', 'Paper', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO comments (id, project_id, file_path, author_id, content, resolved, created_at, updated_at)
          VALUES ('legacy', 'paper', 'main.tex', 'owner', 'Review', 1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
      `);
      database.close();
      database = openDatabase(config);
      expect(database.prepare("SELECT resolved, resolved_by, resolved_at, updated_at FROM comments WHERE id = 'legacy'").get())
        .toEqual({ resolved: 1, resolved_by: null, resolved_at: null, updated_at: "2026-01-02T00:00:00Z" });
      const applied = database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 4").get();
      expect(applied).toMatchObject({ name: "add_comment_resolution_metadata" });
      database.prepare("UPDATE comments SET resolved_by = 'owner', resolved_at = ? WHERE id = 'legacy'")
        .run("2026-01-03T00:00:00Z");
      database.close();
      database = openDatabase(config);
      expect(database.prepare("SELECT * FROM texlite_schema_migrations WHERE version = 4").get()).toEqual(applied);
      expect(database.prepare("SELECT resolved_by, resolved_at FROM comments WHERE id = 'legacy'").get())
        .toEqual({ resolved_by: "owner", resolved_at: "2026-01-03T00:00:00Z" });
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves legacy project tags and initializes modification metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-migration-"));
    const databasePath = path.join(root, "texlite.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
        main_file TEXT NOT NULL DEFAULT 'main.tex', latexmkrc TEXT, engine TEXT NOT NULL DEFAULT 'xelatex',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_tags (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (project_id, name)
      );
      CREATE TABLE compile_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL, log TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
      );
      INSERT INTO users VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, '2025-01-01T00:00:00.000Z');
      INSERT INTO projects VALUES ('project-1', 'user-1', 'Legacy', 'main.tex', NULL, 'xelatex',
        '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');
      INSERT INTO project_tags VALUES ('tag-1', 'project-1', 'Research', 'purple', '2025-01-01T00:00:00.000Z');
      INSERT INTO compile_runs VALUES ('run-1', 'project-1', 'user-1', 'succeeded', '',
        '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:01.000Z');
    `);
    legacy.close();

    const config = migrationConfig(root, databasePath);
    let migrated = openDatabase(config);
    try {
      expect(migrated.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(migrated.pragma("synchronous", { simple: true })).toBe(1);
      expect(migrated.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(migrated.prepare("SELECT last_modified_by FROM projects WHERE id = 'project-1'").get())
        .toEqual({ last_modified_by: "user-1" });
      expect(migrated.prepare("SELECT can_create_projects FROM users WHERE id = 'user-1'").get())
        .toEqual({ can_create_projects: 1 });
      expect(migrated.prepare(`SELECT tag.name, tag.color FROM tags tag
        JOIN project_tag_links link ON link.tag_id = tag.id WHERE link.project_id = 'project-1'`).get())
        .toEqual({ name: "Research", color: "purple" });
      expect(migrated.prepare(`SELECT tag.name, tag.color, tag.user_id FROM user_tags tag
        JOIN user_project_tag_links link ON link.tag_id = tag.id WHERE link.project_id = 'project-1'`).get())
        .toEqual({ name: "Research", color: "purple", user_id: "user-1" });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_git_settings'").get())
        .toEqual({ name: "project_git_settings" });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_history_state'").get())
        .toEqual({ name: "project_history_state" });
      expect((migrated.prepare("PRAGMA table_info(citation_library_entries)").all() as Array<{ name: string }>)
        .some((column) => column.name === "revision")).toBe(true);
      expect((migrated.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>)
        .some((column) => column.name === "icon")).toBe(true);
      expect((migrated.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>)
        .some((column) => column.name === "chktex_enabled")).toBe(true);
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_expires_at'").get())
        .toEqual({ name: "sessions_expires_at" });
      expect(migrated.prepare("SELECT main_file FROM compile_runs WHERE id = 'run-1'").get())
        .toEqual({ main_file: "main.tex" });
      expect(migrated.prepare("SELECT version, name FROM texlite_schema_migrations").all())
        .toEqual([
          { version: 1, name: "baseline_schema_and_legacy_upgrade" },
          { version: 2, name: "add_project_chktex_enabled" },
          { version: 3, name: "move_github_tokens_to_user_accounts" },
          { version: 4, name: "add_comment_resolution_metadata" },
          { version: 5, name: "add_update_notifications" },
          { version: 6, name: "add_user_avatar_style" },
          { version: 7, name: "add_user_avatar_svg" },
          { version: 8, name: "use_username_avatar_seed" },
          { version: 9, name: "add_snapshot_file_tracking" },
          { version: 10, name: "add_external_agent_tasks" },
          { version: 11, name: "track_agent_native_cleanup_completion" },
          { version: 12, name: "add_comment_suggestions" },
          { version: 13, name: "move_reviewer_to_comments" },
          { version: 14, name: "keep_reviewers_on_suggestions" },
          { version: 15, name: "add_project_view_links" },
          { version: 16, name: "remove_revoked_project_view_links" },
          { version: 17, name: "store_encrypted_view_link_tokens" },
          { version: 18, name: "add_citation_collections" },
          { version: 19, name: "add_citation_notes" },
          { version: 20, name: "add_user_git_identity" },
          { version: 21, name: "add_citation_venue" },
          { version: 22, name: "add_agent_history_flags" },
          { version: 23, name: "add_history_version_objects" },
          { version: 24, name: "add_edit_segment_age_index" }
        ]);

      // The old untracked migration copied this tag at every startup. Once
      // the baseline has been recorded, a deliberate deletion stays deleted.
      migrated.prepare("DELETE FROM user_tags WHERE id = 'tag-1'").run();
      migrated.close();
      migrated = openDatabase(config);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM user_tags WHERE id = 'tag-1'").get())
        .toEqual({ count: 0 });
      expect(migrated.prepare("SELECT version, name FROM texlite_schema_migrations").all())
        .toEqual([
          { version: 1, name: "baseline_schema_and_legacy_upgrade" },
          { version: 2, name: "add_project_chktex_enabled" },
          { version: 3, name: "move_github_tokens_to_user_accounts" },
          { version: 4, name: "add_comment_resolution_metadata" },
          { version: 5, name: "add_update_notifications" },
          { version: 6, name: "add_user_avatar_style" },
          { version: 7, name: "add_user_avatar_svg" },
          { version: 8, name: "use_username_avatar_seed" },
          { version: 9, name: "add_snapshot_file_tracking" },
          { version: 10, name: "add_external_agent_tasks" },
          { version: 11, name: "track_agent_native_cleanup_completion" },
          { version: 12, name: "add_comment_suggestions" },
          { version: 13, name: "move_reviewer_to_comments" },
          { version: 14, name: "keep_reviewers_on_suggestions" },
          { version: 15, name: "add_project_view_links" },
          { version: 16, name: "remove_revoked_project_view_links" },
          { version: 17, name: "store_encrypted_view_link_tokens" },
          { version: 18, name: "add_citation_collections" },
          { version: 19, name: "add_citation_notes" },
          { version: 20, name: "add_user_git_identity" },
          { version: 21, name: "add_citation_venue" },
          { version: 22, name: "add_agent_history_flags" },
          { version: 23, name: "add_history_version_objects" },
          { version: 24, name: "add_edit_segment_age_index" }
        ]);

      migrated.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run("expired-session", "user-1", "2025-01-03T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
      migrated.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run("active-session", "user-1", "2025-01-05T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
      expect(pruneExpiredSessions(migrated, "2025-01-04T00:00:00.000Z")).toBe(1);
      expect(migrated.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "active-session" }]);
    } finally {
      migrated.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replay legacy tags when an existing database already has private-tag tables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-versioned-migration-"));
    const databasePath = path.join(root, "texlite.db");
    const config = migrationConfig(root, databasePath);
    let database = openDatabase(config);
    try {
      database.prepare(`INSERT INTO users
        (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
        VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 0, '2025-01-01T00:00:00.000Z')`).run();
      database.prepare(`INSERT INTO projects
        (id, owner_id, last_modified_by, name, main_file, engine, created_at, updated_at)
        VALUES ('project-1', 'user-1', NULL, 'Paper', 'main.tex', 'xelatex',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run();
      database.prepare(`INSERT INTO compile_runs
        (id, project_id, requested_by, main_file, status, log, created_at)
        VALUES ('run-1', 'project-1', 'user-1', '', 'succeeded', '', '2025-01-01T00:00:00.000Z')`).run();
      // This is a current pre-versioned database after its owner deleted the
      // private counterpart of a legacy project tag.
      database.prepare(`INSERT INTO project_tags (id, project_id, name, color, created_at)
        VALUES ('legacy-tag', 'project-1', 'Deleted', 'blue', '2025-01-01T00:00:00.000Z')`).run();
      database.exec("DROP TABLE texlite_schema_migrations");
      database.close();

      database = openDatabase(config);
      expect(database.prepare("SELECT COUNT(*) AS count FROM user_tags").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }]);
      expect(database.prepare("SELECT last_modified_by FROM projects WHERE id = 'project-1'").get())
        .toEqual({ last_modified_by: null });
      expect(database.prepare("SELECT main_file FROM compile_runs WHERE id = 'run-1'").get())
        .toEqual({ main_file: "" });
      expect(database.prepare("SELECT can_create_projects FROM users WHERE id = 'user-1'").get())
        .toEqual({ can_create_projects: 0 });
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("moves the latest project GitHub token to its owner's account and clears project copies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-github-token-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.prepare(`INSERT INTO users
        (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
        VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 0, '2025-01-01T00:00:00.000Z')`).run();
      for (const projectId of ["project-1", "project-2"]) {
        database.prepare(`INSERT INTO projects (id, owner_id, name, main_file, engine, created_at, updated_at)
          VALUES (?, 'user-1', ?, 'main.tex', 'xelatex', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`)
          .run(projectId, projectId);
      }
      database.prepare(`INSERT INTO project_git_settings
        (project_id, token_ciphertext, github_login, default_branch, created_at, updated_at)
        VALUES ('project-1', 'older-ciphertext', 'old-login', 'main', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')`).run();
      database.prepare(`INSERT INTO project_git_settings
        (project_id, token_ciphertext, github_login, default_branch, created_at, updated_at)
        VALUES ('project-2', 'newer-ciphertext', 'new-login', 'main', '2025-01-01T00:00:00.000Z', '2025-01-03T00:00:00.000Z')`).run();

      database.exec("DROP TABLE texlite_schema_migrations");
      database.close();
      database = openDatabase(config);
      expect(database.prepare("SELECT token_ciphertext, github_login FROM user_github_settings WHERE user_id = 'user-1'").get())
        .toEqual({ token_ciphertext: "newer-ciphertext", github_login: "new-login" });
      expect(database.prepare("SELECT token_ciphertext, github_login FROM project_git_settings ORDER BY project_id").all())
        .toEqual([{ token_ciphertext: null, github_login: null }, { token_ciphertext: null, github_login: null }]);
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds a configurable Git author identity to existing account settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-git-identity-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.prepare(`INSERT INTO users
        (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
        VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 0, '2025-01-01T00:00:00.000Z')`).run();
      database.prepare(`INSERT INTO user_github_settings
        (user_id, token_ciphertext, github_login, git_username, git_email, created_at, updated_at)
        VALUES ('user-1', 'token', 'login', 'Old Name', 'old@example.com',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run();

      // Simulate a database created before migration 20.
      database.prepare("DELETE FROM texlite_schema_migrations WHERE version >= 20").run();
      database.exec("ALTER TABLE user_github_settings DROP COLUMN git_username");
      database.exec("ALTER TABLE user_github_settings DROP COLUMN git_email");
      database.close();

      database = openDatabase(config);
      const columns = (database.prepare("PRAGMA table_info(user_github_settings)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["git_username", "git_email"]));
      expect(database.prepare(`SELECT token_ciphertext, github_login, git_username, git_email
        FROM user_github_settings WHERE user_id = 'user-1'`).get())
        .toEqual({ token_ciphertext: "token", github_login: "login", git_username: null, git_email: null });
      expect(database.prepare("SELECT COUNT(*) AS count FROM texlite_schema_migrations WHERE version = 20").get())
        .toEqual({ count: 1 });

      database.prepare("UPDATE user_github_settings SET git_username = ?, git_email = ? WHERE user_id = ?")
        .run("Ada Lovelace", "ada@example.com", "user-1");
      database.close();
      database = openDatabase(config);
      expect(database.prepare("SELECT git_username, git_email FROM user_github_settings WHERE user_id = 'user-1'").get())
        .toEqual({ git_username: "Ada Lovelace", git_email: "ada@example.com" });
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a migration only after its transaction succeeds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-migration-rollback-"));
    const databasePath = path.join(root, "texlite.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL,
        must_change_password INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, main_file TEXT NOT NULL,
        engine TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_tags (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO users VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, '2025-01-01T00:00:00.000Z');
      INSERT INTO projects VALUES ('project-1', 'Paper', 'main.tex', 'xelatex',
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO project_tags VALUES ('tag-1', 'project-1', 'Invalid', 'blue', '2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const config = migrationConfig(root, databasePath);
    try {
      expect(() => openDatabase(config)).toThrow(/no such column: owner_id/);

      const inspection = new Database(databasePath);
      try {
        expect(inspection.prepare("SELECT COUNT(*) AS count FROM texlite_schema_migrations").get())
          .toEqual({ count: 0 });
        expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_tags'").get())
          .toBeUndefined();
        inspection.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'user-1'");
      } finally {
        inspection.close();
      }

      const migrated = openDatabase(config);
      try {
        expect(migrated.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }]);
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a database created by a newer schema release", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-migration-version-"));
    const databasePath = path.join(root, "texlite.db");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE texlite_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      INSERT INTO texlite_schema_migrations VALUES (999, 'future_schema', '2026-01-01T00:00:00.000Z');
    `);
    database.close();

    try {
      expect(() => openDatabase(migrationConfig(root, databasePath)))
        .toThrow(/version 999 is newer than this TexLite release/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a recorded migration whose identity does not match this release", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-migration-name-"));
    const databasePath = path.join(root, "texlite.db");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE texlite_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      INSERT INTO texlite_schema_migrations VALUES (1, 'different_baseline', '2026-01-01T00:00:00.000Z');
    `);
    database.close();

    try {
      expect(() => openDatabase(migrationConfig(root, databasePath)))
        .toThrow(/migration 1 does not match this TexLite release/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
