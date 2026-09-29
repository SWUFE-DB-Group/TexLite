import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, pruneExpiredSessions } from "../src/server/db.js";

function migrationConfig(root: string, databasePath: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Migration", adminEmail: "",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath,
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
    maxUploadBytes: 50 * 1024 * 1024, pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024,
    git: "git", gitOperationTimeoutMs: 30_000,
    githubApiBaseUrl: "https://api.github.com"
  };
}

describe("database migrations", () => {
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
          { version: 3, name: "move_github_tokens_to_user_accounts" }
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
          { version: 3, name: "move_github_tokens_to_user_accounts" }
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
      expect(database.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
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
      expect(migrated.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
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
      INSERT INTO texlite_schema_migrations VALUES (4, 'future_schema', '2026-01-01T00:00:00.000Z');
    `);
    database.close();

    try {
      expect(() => openDatabase(migrationConfig(root, databasePath)))
        .toThrow(/version 4 is newer than this TexLite release/);
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
