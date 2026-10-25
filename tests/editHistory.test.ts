import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import {
  createEditHistorySpan,
  hashText,
  ProjectEditHistoryService,
  type EditHistorySegmentInput,
  type EditHistorySpan
} from "../src/server/editHistory.js";
import { EditHistoryRetry } from "../src/server/editHistoryRetry.js";

interface Fixture {
  root: string;
  db: DatabaseConnection;
  history: ProjectEditHistoryService;
  projectId: string;
}

interface FixtureOptions {
  editHistoryMaxStorageBytes?: number;
}

const fixtures: Fixture[] = [];

describe("selection edit history", () => {
  it.each(["edit", "format"] as const)("keeps complete %s replacements while shortening only displayed passages", (kind) => {
    const fixture = createFixture();
    const original = "Initial paragraph.";
    const expanded = "中文段落 😀 with evidence.\n".repeat(400);
    const final = "Final paragraph.";
    const first = replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, expanded, kind);
    first.steps[0].spans = [createEditHistorySpan(0, 0, original, expanded)];
    const second = replaceSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", expanded, final, kind);
    second.steps[0].spans = [createEditHistorySpan(0, 0, expanded, final)];
    fixture.history.record(fixture.projectId, [first, second]);

    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", final, 0, final.length);
    expect(result.chainComplete).toBe(true);
    expect(result.entries[0]).toMatchObject({ content: final, contentTruncated: false, authors: [{ id: "bob" }] });
    expect(result.entries[1]).toMatchObject({ contentTruncated: true, authors: [{ id: "alice" }] });
    expect(result.entries[1].content).toBe(`${expanded.slice(0, 2999)}…${expanded.slice(-2999)}`);
    // Passing a shortened display block back into reconstruction would lose this baseline.
    expect(result.baseline).toEqual({ content: original, contentTruncated: false });
    expect(fixture.history.stats(fixture.projectId).payloadBytes).toBeGreaterThan(Buffer.byteLength(expanded) * 2);
  });

  it("reads legacy truncated records without inventing lost text or hiding newer reversible edits", () => {
    const fixture = createFixture();
    const original = "Old paragraph. ".repeat(150);
    const replaced = "New paragraph. ".repeat(150);
    const legacy = replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, replaced, "edit");
    legacy.steps[0].spans[0].deletedPreview = "Old…";
    legacy.steps[0].spans[0].insertedPreview = "New…";
    legacy.steps[0].spans[0].truncated = true;
    const final = "Final paragraph.";
    fixture.history.record(fixture.projectId, [legacy,
      replaceSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", replaced, final, "edit")]);
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", final, 0, final.length);
    expect(result.entries.map((entry) => entry.content)).toEqual([final, replaced]);
    expect(result.baseline).toEqual({ content: null, contentTruncated: false });
  });

  it("omits an over-budget complete replacement and stops newer history at its explicit boundary", () => {
    const fixture = createFixture({ editHistoryMaxStorageBytes: 1000 });
    const original = "Initial";
    const huge = "大段修改".repeat(1000);
    const skipped = replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, huge, "edit");
    fixture.history.record(fixture.projectId, [skipped]);
    expect(fixture.history.stats(fixture.projectId)).toMatchObject({ segmentCount: 0, payloadBytes: 0 });
    expect(fixture.history.selectionHistory(fixture.projectId, "main.tex", huge, 0, huge.length))
      .toMatchObject({ entries: [], baseline: null, chainComplete: false });
    const final = huge + "!";
    fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", huge, final, "edit")]);
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", final, huge.length - 4, final.length);
    expect(result).toMatchObject({ chainComplete: false, baseline: { content: huge.slice(-4), contentTruncated: false } });
    expect(result.entries[0].content).toBe(final.slice(-5));
    expect(fixture.history.stats(fixture.projectId).payloadBytes).toBeLessThanOrEqual(1000);
  });

  it.each(["author", "kind", "createdAt", "updatedAt", "stepTime", "hash", "path", "emptySteps", "span", "step"])(
    "rejects a whole internal batch with an invalid %s instead of silently repairing or dropping it", (field) => {
      const fixture = createFixture();
      const valid = replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", "old", "new", "edit");
      const invalid = replaceSegment("main.tex", "alice", "2026-01-01T10:03:00.000Z", "new", "next", "edit");
      switch (field) {
        case "author": invalid.authorId = ""; break;
        case "kind": Object.assign(invalid, { kind: "unknown" }); break;
        case "createdAt": invalid.createdAt = "not-a-timestamp"; break;
        case "updatedAt": invalid.updatedAt = "not-a-timestamp"; break;
        case "stepTime": invalid.steps[0].createdAt = "not-a-timestamp"; break;
        case "hash": invalid.afterHash = hashText("unrelated"); break;
        case "path": invalid.filePath = "../main.tex"; break;
        case "emptySteps": invalid.steps = []; break;
        case "span": invalid.steps[0].spans.push({ ...invalid.steps[0].spans[0], insertedLength: -1 }); break;
        case "step": invalid.steps.push({ ...invalid.steps[0], beforeHash: "invalid-hash" }); break;
      }
      const original = structuredClone([valid, invalid]);
      expect(() => fixture.history.record(fixture.projectId, [valid, invalid])).toThrow();
      expect(fixture.history.stats(fixture.projectId)).toMatchObject({ segmentCount: 0, payloadBytes: 0 });
      expect([valid, invalid]).toEqual(original);
    }
  );

  it("reports invalid internal history through the existing bounded retry and warning path", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const invalid = replaceSegment("main.tex", "alice", "invalid-time", "old", "new", "edit");
    const report = vi.fn();
    const retry = new EditHistoryRetry((id, edits) => fixture.history.record(id, edits), () => true, report);
    try {
      retry.save(fixture.projectId, [invalid]);
      expect(report).toHaveBeenLastCalledWith(fixture.projectId, "retrying", expect.any(Error));
      vi.advanceTimersByTime(15_000);
      expect(report).toHaveBeenLastCalledWith(fixture.projectId, "incomplete", expect.any(Error));
      expect(fixture.history.stats(fixture.projectId).segmentCount).toBe(0);
    } finally {
      retry.dispose();
      vi.useRealTimers();
    }
  });

  it("stops at a damaged stored step without reconstructing a partial chain or inventing its timestamp", () => {
    const fixture = createFixture();
    const segment = replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", "old", "new", "edit");
    fixture.history.record(fixture.projectId, [segment]);
    for (const invalid of [
      { ...segment.steps[0], beforeHash: "invalid-hash" },
      { ...segment.steps[0], createdAt: "invalid-time" }
    ]) {
      fixture.db.prepare("UPDATE project_edit_segments SET steps_json = ? WHERE project_id = ?")
        .run(JSON.stringify([...segment.steps, invalid]), fixture.projectId);
      expect(fixture.history.selectionHistory(fixture.projectId, "main.tex", "new", 0, 3))
        .toMatchObject({ entries: [], baseline: null, chainComplete: false });
    }
  });

  it("returns each author's current avatar style and clears identity for deleted users", () => {
    const fixture = createFixture();
    fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", "old", "new", "edit")]);
    fixture.db.prepare("UPDATE users SET avatar_style = 'lorelei' WHERE id = 'alice'").run();
    const authors = () => fixture.history.selectionHistory(fixture.projectId, "main.tex", "new", 0, 3).entries[0].authors;
    expect(authors()).toEqual([{ id: "alice", username: "alice", name: "Alice", avatarStyle: "lorelei" }]);
    fixture.db.prepare("UPDATE users SET avatar_style = NULL WHERE id = 'alice'").run();
    expect(authors()[0].avatarStyle).toBeNull();
    fixture.db.prepare("DELETE FROM users WHERE id = 'alice'").run();
    expect(authors()).toEqual([{ id: null, username: null, name: null, avatarStyle: null }]);
  });

  it("reports payload usage and clears only this project's edit records and boundaries", () => {
    const fixture = createFixture();
    fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", "old", "new", "edit")]);
    expect(fixture.history.stats(fixture.projectId).segmentCount).toBe(1);
    expect(fixture.history.stats(fixture.projectId).payloadBytes).toBeGreaterThan(0);
    fixture.history.clear("another-project");
    expect(fixture.history.stats(fixture.projectId).segmentCount).toBe(1);
    fixture.db.prepare("INSERT INTO project_edit_history_boundaries VALUES (?, ?, ?, ?)")
      .run(fixture.projectId, "main.tex", hashText("old"), "2026-01-01T10:00:00.000Z");
    fixture.history.clear(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId)).toMatchObject({ segmentCount: 0, payloadBytes: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM project_edit_history_boundaries WHERE project_id = ?").get(fixture.projectId)).toEqual({ n: 0 });
    fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "alice", "2026-01-01T10:03:00.000Z", "new", "next", "edit")]);
    expect(fixture.history.selectionHistory(fixture.projectId, "main.tex", "next", 0, 4).baseline?.content).toBe("new");
  });

  it("uses the stored payload byte count for quota statistics", () => {
    const fixture = createFixture();
    fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", "old", "new", "edit")]);
    fixture.db.prepare("UPDATE project_edit_segments SET steps_bytes = 17 WHERE project_id = ?").run(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId).payloadBytes).toBe(17);
  });
  it("keeps adjacent replacements outside the selection on both sides", () => {
    for (const [original, first, second, final, start] of [
      ["abcBAD", "abcOLD", "abcXYZ", "abQQXYZ", 4],
      ["BADabc", "OLDabc", "XYZabc", "XYZQQbc", 0]
    ] as const) {
      const fixture = createFixture();
      fixture.history.record(fixture.projectId, [
        replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, first, "edit"),
        replaceSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", first, second, "edit"),
        replaceSegment("main.tex", "owner", "2026-01-01T10:06:00.000Z", second, final, "edit")
      ]);
      const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", final, start, start + 3);
      expect(result.entries.map((entry) => entry.content)).toEqual(["XYZ", "OLD"]);
      expect(result.entries.flatMap((entry) => entry.authors.map((author) => author.id))).toEqual(["bob", "alice"]);
      expect(result.baseline).toEqual({ content: "BAD", contentTruncated: false });
      expect(result.chainComplete).toBe(true);
    }
  });

  it("reports the display limit separately and supplies the last displayed block's baseline", () => {
    const fixture = createFixture();
    let source = "version-0";
    for (let index = 1; index <= 62; index++) {
      const next = `version-${index}`;
      const time = new Date(Date.UTC(2026, 0, 1, 0, index * 3)).toISOString();
      fixture.history.record(fixture.projectId, [replaceSegment("main.tex", "alice", time, source, next, "edit")]);
      source = next;
    }
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", source, 0, source.length);
    expect(result.entries).toHaveLength(60);
    expect(result.hasMore).toBe(true);
    expect(result.baseline).toEqual({ content: "version-2", contentTruncated: false });
  });
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("maps a current selection backwards through another user's later edit", () => {
    const fixture = createFixture();
    const original = "The abstract is rough.\n";
    const afterAlice = "The abstract is concise.\n";
    const afterBob = "The introduction is concise.\n";

    fixture.history.record(fixture.projectId, [
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, afterAlice, "edit"),
      replaceSegment("main.tex", "bob", "2026-01-01T10:00:05.000Z", afterAlice, afterBob, "edit")
    ]);

    const start = afterBob.indexOf("concise");
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", afterBob, start, start + "concise".length);

    expect(result.chainComplete).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ authors: [{ id: "alice", name: "Alice" }] });
    expect(result.entries[0]).toMatchObject({ content: "concise", contentTruncated: false });
    expect(result.baseline).toEqual({ content: "rough", contentTruncated: false });
    expect(result.hasMore).toBe(false);
  });

  it("keeps users whose edits do not affect the selected text out of its attribution", () => {
    const fixture = createFixture();
    const original = "A rough abstract.\n";
    const afterAlice = "A concise abstract.\n";
    const afterBob = "A concise introduction.\n";
    const afterAliceAgain = "A concise introduction!\n";

    fixture.history.record(fixture.projectId, [
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, afterAlice, "edit"),
      replaceSegment("main.tex", "bob", "2026-01-01T10:00:05.000Z", afterAlice, afterBob, "edit"),
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:10.000Z", afterBob, afterAliceAgain, "edit")
    ]);

    const start = afterAliceAgain.indexOf("introduction");
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", afterAliceAgain, start, start + "introduction".length);

    expect(result.entries.map((entry) => entry.authors.map((author) => author.id))).toEqual([["bob"]]);
  });

  it("consolidates a nearby multi-user editing window and retains its current passage", () => {
    const fixture = createFixture();
    const original = "The rough abstract.\n";
    const afterAlice = "The concise abstract.\n";
    const afterAliceAgain = "The concise research abstract.\n";
    const afterBob = "The clear research abstract.\n";
    fixture.history.record(fixture.projectId, [
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, afterAlice, "edit"),
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:20.000Z", afterAlice, afterAliceAgain, "edit"),
      replaceSegment("main.tex", "bob", "2026-01-01T10:00:40.000Z", afterAliceAgain, afterBob, "edit")
    ]);

    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", afterBob, 0, afterBob.length);

    expect(result.chainComplete).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      authors: [{ id: "bob", name: "Bob" }, { id: "alice", name: "Alice" }],
      createdAt: "2026-01-01T10:00:00.000Z", updatedAt: "2026-01-01T10:00:40.000Z",
      content: afterBob, contentTruncated: false
    });
  });

  it("returns chronological selected states that can be compared by the client", () => {
    const fixture = createFixture();
    const original = "The rough abstract.\n";
    const afterAlice = "The concise abstract.\n";
    const afterBob = "The clear abstract.\n";
    fixture.history.record(fixture.projectId, [
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, afterAlice, "edit"),
      replaceSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", afterAlice, afterBob, "edit")
    ]);

    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", afterBob, 0, afterBob.length);

    expect(result.entries).toHaveLength(2);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: afterBob, authors: [{ id: "bob", name: "Bob", username: "bob", avatarStyle: null }] }),
      expect.objectContaining({ content: afterAlice, authors: [{ id: "alice", name: "Alice", username: "alice", avatarStyle: null }] })
    ]));
  });

  it("coalesces consecutive windows when their selected content is unchanged", () => {
    const fixture = createFixture();
    const source = "The concise abstract.\n";
    fixture.history.record(fixture.projectId, [
      noOpSelectionSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", source),
      noOpSelectionSegment("main.tex", "bob", "2026-01-01T10:03:00.000Z", source)
    ]);

    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", source, 0, source.length);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      content: source,
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:03:00.000Z",
      authors: [{ id: "bob", name: "Bob" }, { id: "alice", name: "Alice" }]
    });
  });

  it("stops rather than guessing across an unrecorded source replacement", () => {
    const fixture = createFixture();
    const original = "The abstract is rough.\n";
    const afterAlice = "The abstract is concise.\n";
    fixture.history.record(fixture.projectId, [
      replaceSegment("main.tex", "alice", "2026-01-01T10:00:00.000Z", original, afterAlice, "edit")
    ]);

    const replaced = "The restored document is unrelated.\n";
    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", replaced, 4, 12);

    expect(result).toMatchObject({ entries: [], chainComplete: false });
  });

  it("enforces an independent byte budget and reports the resulting history boundary", () => {
    const maxStorageBytes = 2_500;
    const fixture = createFixture({ editHistoryMaxStorageBytes: maxStorageBytes });
    let source = "The initial abstract.\n";
    const inputs: EditHistorySegmentInput[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = `${source.trimEnd()} ${"evidence ".repeat(120)}revision-${index}.\n`;
      inputs.push(replaceSegment("main.tex", "alice", `2026-01-01T10:0${index}:00.000Z`, source, next, "edit"));
      source = next;
    }

    fixture.history.record(fixture.projectId, inputs);

    const stored = fixture.db.prepare(`SELECT after_hash, LENGTH(CAST(steps_json AS BLOB)) AS bytes, steps_bytes
      FROM project_edit_segments WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC`).all(fixture.projectId) as Array<{ after_hash: string; bytes: number; steps_bytes: number }>;
    const totalBytes = stored.reduce((total, row) => total + row.bytes, 0);
    expect(stored.length).toBeLessThan(inputs.length);
    expect(stored[0]?.after_hash).toBe(hashText(source));
    expect(totalBytes).toBeLessThanOrEqual(maxStorageBytes);
    expect(fixture.history.stats(fixture.projectId).payloadBytes).toBe(totalBytes);
    expect(stored.every((row) => row.steps_bytes === row.bytes)).toBe(true);

    const result = fixture.history.selectionHistory(fixture.projectId, "main.tex", source, 0, source.length);
    expect(result.chainComplete).toBe(false);
  });
});

function replaceSegment(
  filePath: string,
  authorId: string,
  createdAt: string,
  before: string,
  after: string,
  kind: EditHistorySegmentInput["kind"]
): EditHistorySegmentInput {
  const span = replacementSpan(before, after);
  return {
    filePath, authorId, kind,
    beforeHash: hashText(before), afterHash: hashText(after),
    createdAt, updatedAt: createdAt,
    steps: [{ beforeHash: hashText(before), afterHash: hashText(after), createdAt, spans: [span] }]
  };
}

function noOpSelectionSegment(
  filePath: string,
  authorId: string,
  createdAt: string,
  source: string
): EditHistorySegmentInput {
  const hash = hashText(source);
  const span: EditHistorySpan = {
    beforeStart: 0, beforeEnd: 0, afterStart: 0, afterEnd: 0,
    deletedLength: 0, insertedLength: 0, deletedPreview: "", insertedPreview: "", truncated: false
  };
  return {
    filePath, authorId, kind: "edit", beforeHash: hash, afterHash: hash,
    createdAt, updatedAt: createdAt,
    steps: [{ beforeHash: hash, afterHash: hash, createdAt, spans: [span] }]
  };
}

function replacementSpan(before: string, after: string): EditHistorySpan {
  const prefix = commonPrefix(before, after);
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (suffix < maxSuffix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix += 1;
  const deleted = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  return {
    beforeStart: prefix, beforeEnd: prefix + deleted.length,
    afterStart: prefix, afterEnd: prefix + inserted.length,
    deletedLength: deleted.length, insertedLength: inserted.length,
    deletedPreview: deleted, insertedPreview: inserted, truncated: false
  };
}

function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-edit-history-"));
  const config: Config = {
    configPath: path.join(root, "config.json"), siteName: "Edit history test", adminEmail: "",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath: path.join(root, "texlite.db"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
    allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 0, historyMaxStorageBytes: 128 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
  };
  const db = openDatabase(config);
  for (const [id, username, name] of [["owner", "owner", "Owner"], ["alice", "alice", "Alice"], ["bob", "bob", "Bob"]] as const) {
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, 'hash', 'user', 0, 0, 1, '2026-01-01T00:00:00.000Z')`).run(id, username, name);
  }
  const projectId = "project-1";
  db.prepare(`INSERT INTO projects (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
    VALUES (?, 'owner', 'owner', 'Paper', 'main.tex', NULL, 'xelatex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(projectId);
  const fixture = { root, db, history: new ProjectEditHistoryService(db, options.editHistoryMaxStorageBytes), projectId };
  fixtures.push(fixture);
  return fixture;
}
