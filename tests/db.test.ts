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
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxSegments: 20_000,
    git: "git", gitOperationTimeoutMs: 30_000,
    githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
  };
}

describe("database migrations", () => {
  it("upgrades existing agent tasks with a durable native-cleanup checkpoint without resetting completed work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-cleanup-migration-"));
    const config = migrationConfig(root, path.join(root, "texlite.db"));
    let database = openDatabase(config);
    try {
      database.exec(`ALTER TABLE agent_tasks DROP COLUMN native_cleanup_done;
        DELETE FROM texlite_schema_migrations WHERE version = 11;
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
          { version: 11, name: "track_agent_native_cleanup_completion" }
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
          { version: 11, name: "track_agent_native_cleanup_completion" }
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
      expect(database.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }]);
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
        expect(migrated.prepare("SELECT version FROM texlite_schema_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }]);
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
