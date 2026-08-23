import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { reanchorFileComments } from "../src/server/anchors.js";

describe("source comment anchors", () => {
  const fixtures: Array<{ root: string; db: DatabaseConnection }> = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("marks a comment orphaned when a selected range is replaced", () => {
    const fixture = createFixture();
    const oldSource = "before\nalpha target\nafter\n";
    const selectedText = "alpha";
    const startOffset = oldSource.indexOf(selectedText);
    fixture.db.prepare("INSERT INTO comments (id, project_id, file_path, selected_text, start_offset, end_offset, context_before, context_after, content, created_at, updated_at) VALUES ('comment-1', 'project-1', 'main.tex', ?, ?, ?, ?, ?, 'Review', ?, ?)")
      .run(selectedText, startOffset, startOffset + selectedText.length,
        oldSource.slice(Math.max(0, startOffset - 48), startOffset),
        oldSource.slice(startOffset + selectedText.length, startOffset + selectedText.length + 48),
        new Date().toISOString(), new Date().toISOString());

    reanchorFileComments(fixture.db, "project-1", "main.tex", oldSource, "before\nbeta target\nafter\n");

    const row = fixture.db.prepare("SELECT selected_text, orphaned, start_offset, end_offset FROM comments WHERE id = 'comment-1'").get() as {
      selected_text: string; orphaned: number; start_offset: number; end_offset: number;
    };
    expect(row).toMatchObject({ selected_text: selectedText, orphaned: 1 });
    expect(row.end_offset).toBeGreaterThanOrEqual(row.start_offset);
  });

  it("does not relocate repeated text without matching context", () => {
    const fixture = createFixture();
    const oldSource = "first needle\nsecond context\n";
    const selectedText = "needle";
    const startOffset = oldSource.indexOf(selectedText);
    fixture.db.prepare("INSERT INTO comments (id, project_id, file_path, selected_text, start_offset, end_offset, context_before, context_after, content, created_at, updated_at) VALUES ('comment-2', 'project-1', 'main.tex', ?, ?, ?, ?, ?, 'Review', ?, ?)")
      .run(selectedText, startOffset, startOffset + selectedText.length,
        oldSource.slice(Math.max(0, startOffset - 48), startOffset),
        oldSource.slice(startOffset + selectedText.length, startOffset + selectedText.length + 48),
        new Date().toISOString(), new Date().toISOString());

    // The selected occurrence was replaced, while an unrelated duplicate was
    // introduced elsewhere without the original context.
    reanchorFileComments(fixture.db, "project-1", "main.tex", oldSource, "first replacement\nother needle\n");

    const row = fixture.db.prepare("SELECT selected_text, orphaned FROM comments WHERE id = 'comment-2'").get() as {
      selected_text: string; orphaned: number;
    };
    expect(row).toMatchObject({ selected_text: selectedText, orphaned: 1 });
  });

  it("keeps a stale anchor orphaned when its old source no longer matches", () => {
    const fixture = createFixture();
    const oldSource = "current text\n";
    fixture.db.prepare("INSERT INTO comments (id, project_id, file_path, selected_text, start_offset, end_offset, context_before, context_after, content, created_at, updated_at) VALUES ('comment-3', 'project-1', 'main.tex', 'missing', 0, 7, '', '', 'Review', ?, ?)")
      .run(new Date().toISOString(), new Date().toISOString());

    reanchorFileComments(fixture.db, "project-1", "main.tex", oldSource, "missing text\n");

    const row = fixture.db.prepare("SELECT selected_text, orphaned FROM comments WHERE id = 'comment-3'").get() as {
      selected_text: string; orphaned: number;
    };
    expect(row).toMatchObject({ selected_text: "missing", orphaned: 1 });
  });

  function createFixture(): { root: string; db: DatabaseConnection } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-anchors-"));
    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "Anchor Test", adminEmail: "",
      host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
      allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
      historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
    };
    const db = openDatabase(config);
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at) VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at) VALUES ('project-1', 'user-1', 'user-1', 'Paper', 'main.tex', NULL, 'xelatex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    const fixture = { root, db };
    fixtures.push(fixture);
    return fixture;
  }
});
