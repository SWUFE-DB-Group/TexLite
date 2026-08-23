import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, pruneExpiredSessions } from "../src/server/db.js";

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

    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "Migration", adminEmail: "",
      host: "127.0.0.1", port: 3000, dataDir: root, databasePath,
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
      maxUploadBytes: 50 * 1024 * 1024, pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 30_000,
      githubApiBaseUrl: "https://api.github.com"
    };
    const migrated = openDatabase(config);
    try {
      expect(migrated.prepare("SELECT last_modified_by FROM projects WHERE id = 'project-1'").get())
        .toEqual({ last_modified_by: "user-1" });
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
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_expires_at'").get())
        .toEqual({ name: "sessions_expires_at" });
      expect(migrated.prepare("SELECT main_file FROM compile_runs WHERE id = 'run-1'").get())
        .toEqual({ main_file: "main.tex" });

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
});
