import fs from "node:fs";
import Database from "better-sqlite3";
import type { Config } from "./config.js";

export type DatabaseConnection = Database.Database;

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  disabled: number;
  must_change_password: number;
  can_create_projects: number;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  last_modified_by: string | null;
  name: string;
  main_file: string;
  latexmkrc: string | null;
  engine: "pdflatex" | "xelatex" | "lualatex";
  created_at: string;
  updated_at: string;
}

export function openDatabase(config: Config): DatabaseConnection {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.projectsDir, { recursive: true, mode: 0o700 });
  const db = new Database(config.databasePath, { timeout: 5000 });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK (can_create_projects IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      last_modified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      main_file TEXT NOT NULL DEFAULT 'main.tex',
      latexmkrc TEXT,
      engine TEXT NOT NULL DEFAULT 'xelatex' CHECK (engine IN ('pdflatex', 'xelatex', 'lualatex')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner_id ON projects(owner_id);

    CREATE TABLE IF NOT EXISTS project_tags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE INDEX IF NOT EXISTS project_tags_project_id ON project_tags(project_id);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_tag_links (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS project_tag_links_tag_id ON project_tag_links(tag_id);

    CREATE TABLE IF NOT EXISTS user_tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS user_tags_user_id ON user_tags(user_id);

    CREATE TABLE IF NOT EXISTS user_project_tag_links (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS user_project_tag_links_tag_id ON user_project_tag_links(tag_id);

    CREATE TABLE IF NOT EXISTS user_project_archives (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      archived_at TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS user_project_archives_project_id ON user_project_archives(project_id);

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      selected_text TEXT NOT NULL DEFAULT '',
      start_offset INTEGER NOT NULL DEFAULT 0,
      end_offset INTEGER NOT NULL DEFAULT 0,
      context_before TEXT NOT NULL DEFAULT '',
      context_after TEXT NOT NULL DEFAULT '',
      orphaned INTEGER NOT NULL DEFAULT 0 CHECK (orphaned IN (0, 1)),
      start_line INTEGER NOT NULL DEFAULT 1,
      end_line INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comments_project_file ON comments(project_id, file_path);

    CREATE TABLE IF NOT EXISTS comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comment_replies_comment_id ON comment_replies(comment_id, created_at);

    CREATE TABLE IF NOT EXISTS compile_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      main_file TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      log TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS compile_runs_project_created ON compile_runs(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_history_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL CHECK (reason IN ('initial', 'autosave', 'file', 'settings', 'git', 'restore', 'checkpoint')),
      label TEXT,
      manifest_json TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_history_versions_project_created
      ON project_history_versions(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_history_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      manifest_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_dictionary_words (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      word TEXT NOT NULL COLLATE NOCASE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, word)
    );
    CREATE INDEX IF NOT EXISTS project_dictionary_words_project_id ON project_dictionary_words(project_id);

    CREATE TABLE IF NOT EXISTS project_git_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      token_ciphertext TEXT,
      github_login TEXT,
      remote_url TEXT,
      repository_name TEXT,
      repository_html_url TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "latexmkrc")) {
    db.exec("ALTER TABLE projects ADD COLUMN latexmkrc TEXT");
  }
  if (!projectColumns.some((column) => column.name === "last_modified_by")) {
    db.exec("ALTER TABLE projects ADD COLUMN last_modified_by TEXT REFERENCES users(id) ON DELETE SET NULL");
  }
  const commentColumns = db.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string }>;
  const additions = [
    ["start_offset", "INTEGER NOT NULL DEFAULT 0"],
    ["end_offset", "INTEGER NOT NULL DEFAULT 0"],
    ["context_before", "TEXT NOT NULL DEFAULT ''"],
    ["context_after", "TEXT NOT NULL DEFAULT ''"],
    ["orphaned", "INTEGER NOT NULL DEFAULT 0"],
    ["edited_at", "TEXT"]
  ] as const;
  for (const [name, definition] of additions) {
    if (!commentColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE comments ADD COLUMN ${name} ${definition}`);
    }
  }
  const replyColumns = db.prepare("PRAGMA table_info(comment_replies)").all() as Array<{ name: string }>;
  if (!replyColumns.some((column) => column.name === "edited_at")) {
    db.exec("ALTER TABLE comment_replies ADD COLUMN edited_at TEXT");
  }
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "can_create_projects")) {
    db.exec("ALTER TABLE users ADD COLUMN can_create_projects INTEGER NOT NULL DEFAULT 0");
  }
  const compileRunColumns = db.prepare("PRAGMA table_info(compile_runs)").all() as Array<{ name: string }>;
  if (!compileRunColumns.some((column) => column.name === "main_file")) {
    db.exec("ALTER TABLE compile_runs ADD COLUMN main_file TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    UPDATE users SET can_create_projects = 1 WHERE role = 'admin';
    UPDATE projects SET last_modified_by = owner_id WHERE last_modified_by IS NULL;
    UPDATE compile_runs SET main_file = COALESCE(
      (SELECT project.main_file FROM projects project WHERE project.id = compile_runs.project_id), ''
    ) WHERE main_file = '';
    CREATE INDEX IF NOT EXISTS compile_runs_project_main_created
      ON compile_runs(project_id, main_file, created_at DESC);

    INSERT OR IGNORE INTO tags (id, name, color, created_by, created_at, updated_at)
    SELECT legacy.id, legacy.name, legacy.color, p.owner_id, legacy.created_at, legacy.created_at
    FROM project_tags legacy
    JOIN projects p ON p.id = legacy.project_id
    WHERE legacy.id = (
      SELECT first_tag.id FROM project_tags first_tag
      WHERE first_tag.name = legacy.name COLLATE NOCASE
      ORDER BY first_tag.created_at, first_tag.id LIMIT 1
    );

    INSERT OR IGNORE INTO project_tag_links (project_id, tag_id, created_at)
    SELECT legacy.project_id, tag.id, legacy.created_at
    FROM project_tags legacy
    JOIN tags tag ON tag.name = legacy.name COLLATE NOCASE;

    INSERT OR IGNORE INTO user_tags (id, user_id, name, color, created_at, updated_at)
    SELECT legacy.id, project.owner_id, legacy.name, legacy.color, legacy.created_at, legacy.created_at
    FROM project_tags legacy
    JOIN projects project ON project.id = legacy.project_id
    WHERE legacy.id = (
      SELECT first_tag.id FROM project_tags first_tag
      JOIN projects first_project ON first_project.id = first_tag.project_id
      WHERE first_project.owner_id = project.owner_id
        AND first_tag.name = legacy.name COLLATE NOCASE
      ORDER BY first_tag.created_at, first_tag.id LIMIT 1
    );

    INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at)
    SELECT legacy.project_id, user_tag.id, legacy.created_at
    FROM project_tags legacy
    JOIN projects project ON project.id = legacy.project_id
    JOIN user_tags user_tag ON user_tag.user_id = project.owner_id
      AND user_tag.name = legacy.name COLLATE NOCASE;

    INSERT OR IGNORE INTO user_tags (id, user_id, name, color, created_at, updated_at)
    SELECT tag.id, tag.created_by, tag.name, tag.color, tag.created_at, tag.updated_at
    FROM tags tag WHERE tag.created_by IS NOT NULL;

    INSERT OR IGNORE INTO user_project_tag_links (project_id, tag_id, created_at)
    SELECT link.project_id, link.tag_id, link.created_at
    FROM project_tag_links link JOIN user_tags user_tag ON user_tag.id = link.tag_id;
  `);
}

export function activeAdminCount(db: DatabaseConnection): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0"
  ).get() as { count: number };
  return Number(row.count);
}
