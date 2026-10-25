import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { createSourceAnchor, reanchorFileComments } from "../src/server/anchors.js";

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

  it.each([false, true])("maps Unicode offsets through the diff fallback (incomplete edit chain: %s)", (incompleteChain) => {
    const fixture = createFixture();
    const source = "中文 😀\nWe use large models.\n";
    const id = insertComment(fixture.db, source, "large models");
    const changed = "前言 𠀀\n" + source.replace("😀", "😁").replace("large models", "large language models");
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, changed,
      incompleteChain ? [[{ from: 0, to: 0, insert: "incomplete", insertLength: 10 }]] : undefined);
    const from = changed.indexOf("large language models");
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, selected_text: "large language models", start_offset: from, end_offset: from + 21 });
  });

  it("keeps an unchanged astral character anchored when nearby Unicode edits require a diff fallback", () => {
    const fixture = createFixture();
    const source = "Start 😁𠀁😁 end.";
    const id = insertComment(fixture.db, source, "𠀁");
    const changed = "Start 😀𠀁a𠀀 end.";
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, changed);
    const from = changed.indexOf("𠀁");
    expect(anchorRow(fixture.db, id)).toMatchObject({
      orphaned: 0, selected_text: "𠀁", start_offset: from, end_offset: from + 2
    });
  });

  it.each([false, true])("does not move a deleted quote to an existing duplicate (actual edits: %s)", (actualEdits) => {
    const fixture = createFixture();
    const source = "Before target after.\nBefore target after.\n";
    const id = insertComment(fixture.db, source, "target");
    const from = source.indexOf("target");
    const deleted = source.slice(0, from) + source.slice(from + 6);
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, deleted,
      actualEdits ? [[{ from, to: from + 6, insert: "", insertLength: 0 }]] : undefined);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "target" });

    const unrelated = "% note\n" + deleted;
    reanchorFileComments(fixture.db, "project-1", "main.tex", deleted, unrelated,
      actualEdits ? [[{ from: 0, to: 0, insert: "% note\n", insertLength: 7 }]] : undefined);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "target" });

    const restored = "% note\n" + source;
    reanchorFileComments(fixture.db, "project-1", "main.tex", unrelated, restored,
      actualEdits ? [[{ from: from + 7, to: from + 7, insert: "target", insertLength: 6 }]] : undefined);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, start_offset: from + 7, end_offset: from + 13 });
  });

  it("recovers a quote when deleting an extra character completes a partial restoration", () => {
    const fixture = createFixture();
    const source = "Before target after.\nBefore target after.\n";
    const id = insertComment(fixture.db, source, "target");
    const from = source.indexOf("target");
    const replaced = source.slice(0, from) + "tarXget" + source.slice(from + 6);
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, replaced,
      [[{ from, to: from + 6, insert: "tarXget", insertLength: 7 }]]);
    expect(anchorRow(fixture.db, id).orphaned).toBe(1);
    reanchorFileComments(fixture.db, "project-1", "main.tex", replaced, source,
      [[{ from: from + 3, to: from + 4, insert: "", insertLength: 0 }]]);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, start_offset: from, end_offset: from + 6 });
  });

  it.each([
    ["before\nalpha target\nafter\n", "before\nalXpha target\nafter\n", "alpha", "alXpha"],
    ["before\nalpha target\nafter\n", "before\nblpha target\nafter\n", "alpha", "blpha"],
    ["before\nalpha target\nafter\n", "before\nalphX target\nafter\n", "alpha", "alphX"],
    ["before\nalpha target\nafter\n", "before\nalpha target\nafter\n", "alpha", "alpha"],
    ["before\nalpha target\nafter\n", "prefix\nbefore\nalpha new target\nafter\n", "alpha target", "alpha new target"],
    ["before\nalpha target\nafter\n", "before\nalpha\nafter\n", "alpha target", "alpha"]
  ])("follows partial edits to the selected source: %s -> %s", (before, after, selected, expected) => {
    const fixture = createFixture();
    const id = insertComment(fixture.db, before, selected);
    reanchorFileComments(fixture.db, "project-1", "main.tex", before, after);
    const row = anchorRow(fixture.db, id);
    expect(row).toMatchObject({ orphaned: 0, selected_text: expected, start_offset: after.indexOf(expected), end_offset: after.indexOf(expected) + expected.length });
  });

  it.each(["before\nother target\nafter\n", "before\n target\nafter\n", ""])("restores a quote after replacement/deletion followed by undo: %j", (replaced) => {
    const fixture = createFixture();
    const source = "before\nneedle target\nafter\n";
    const id = insertComment(fixture.db, source, "needle");
    const original = anchorRow(fixture.db, id);
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, replaced);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "needle", context_before: original.context_before, context_after: original.context_after });
    reanchorFileComments(fixture.db, "project-1", "main.tex", replaced, source);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, selected_text: "needle", start_offset: source.indexOf("needle"), end_offset: source.indexOf("needle") + 6 });
  });

  it("retains recovery context across unrelated saves and a database reopen", () => {
    const fixture = createFixture();
    const source = "before\nneedle target\nafter\n";
    const id = insertComment(fixture.db, source, "needle");
    let current = source.replace("needle", "");
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, current);
    const snapshot = anchorRow(fixture.db, id);
    for (const prefix of ["% note\n", "% another\n"]) {
      const next = prefix + current;
      reanchorFileComments(fixture.db, "project-1", "main.tex", current, next);
      current = next;
      expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "needle", context_before: snapshot.context_before, context_after: snapshot.context_after });
    }
    fixture.db.close();
    fixture.db = openDatabase(fixture.config);
    const restored = current.replace(" target", "needle target");
    reanchorFileComments(fixture.db, "project-1", "main.tex", current, restored);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, start_offset: restored.indexOf("needle") });
  });

  it("uses actual whole-range replacements even when most characters stay identical", () => {
    const fixture = createFixture();
    const source = "before\nlarge models\nafter\n";
    const id = insertComment(fixture.db, source, "large models");
    const from = source.indexOf("large models");
    const replaced = source.replace("large models", "small models");
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, replaced,
      [[{ from, to: from + 12, insert: "small models", insertLength: 12 }]]);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "large models" });
    const partial = replaced.replace("small models", "large model");
    reanchorFileComments(fixture.db, "project-1", "main.tex", replaced, partial);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "large models" });
    reanchorFileComments(fixture.db, "project-1", "main.tex", partial, source);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, start_offset: from, end_offset: from + 12 });
  });

  it("replays partial edits before a full replacement in the same save window", () => {
    const fixture = createFixture();
    const source = "before\nlarge models\nafter\n";
    const id = insertComment(fixture.db, source, "large models");
    const from = source.indexOf("large models");
    const replaced = source.replace("large models", "small models");
    reanchorFileComments(fixture.db, "project-1", "main.tex", source, replaced, [
      [{ from: from + 5, to: from + 5, insert: " language", insertLength: 9 }],
      [{ from, to: from + 21, insert: "small models", insertLength: 12 }]
    ]);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 1, selected_text: "large language models" });
    const restored = source.replace("large models", "large language models");
    reanchorFileComments(fixture.db, "project-1", "main.tex", replaced, restored);
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, selected_text: "large language models" });
  });

  it("restores a whole-file selection with no surrounding context only after an exact undo", () => {
    const fixture = createFixture();
    const id = insertComment(fixture.db, "original manuscript", "original manuscript");
    reanchorFileComments(fixture.db, "project-1", "main.tex", "original manuscript", "");
    reanchorFileComments(fixture.db, "project-1", "main.tex", "", "another original manuscript elsewhere");
    expect(anchorRow(fixture.db, id).orphaned).toBe(1);
    reanchorFileComments(fixture.db, "project-1", "main.tex", "another original manuscript elsewhere", "original manuscript");
    expect(anchorRow(fixture.db, id)).toMatchObject({ orphaned: 0, start_offset: 0, end_offset: 19 });
  });

  function insertComment(db: DatabaseConnection, source: string, selected: string): string {
    const id = "tracked-comment";
    const anchor = createSourceAnchor(source, source.indexOf(selected), source.indexOf(selected) + selected.length);
    db.prepare(`INSERT INTO comments (id, project_id, file_path, selected_text, start_offset, end_offset,
      context_before, context_after, content, created_at, updated_at) VALUES (?, 'project-1', 'main.tex', ?, ?, ?, ?, ?, 'Review', ?, ?)`)
      .run(id, anchor.selectedText, anchor.startOffset, anchor.endOffset, anchor.contextBefore, anchor.contextAfter,
        new Date().toISOString(), new Date().toISOString());
    return id;
  }

  function anchorRow(db: DatabaseConnection, id: string) {
    return db.prepare("SELECT selected_text, orphaned, start_offset, end_offset, context_before, context_after FROM comments WHERE id = ?").get(id) as {
      selected_text: string; orphaned: number; start_offset: number; end_offset: number; context_before: string; context_after: string;
    };
  }

  function createFixture(): { root: string; db: DatabaseConnection; config: Config } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-anchors-"));
    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "Anchor Test", adminEmail: "",
      host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
      allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
      pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxSegments: 20_000,
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
    };
    const db = openDatabase(config);
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at) VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 1, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at) VALUES ('project-1', 'user-1', 'user-1', 'Paper', 'main.tex', NULL, 'xelatex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    const fixture = { root, db, config };
    fixtures.push(fixture);
    return fixture;
  }
});
