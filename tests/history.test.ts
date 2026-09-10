import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { sourceRoot } from "../src/server/files.js";
import { ProjectHistoryService } from "../src/server/history.js";

interface HistoryFixture {
  root: string;
  config: Config;
  db: DatabaseConnection;
  history: ProjectHistoryService;
  projectId: string;
}

describe("project history retention", () => {
  const fixtures: HistoryFixture[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const fixture of fixtures.splice(0)) {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses fixed two-minute autosave windows", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fixture.history.record(fixture.projectId, "user-1", "initial");

    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    writeSource(fixture, "main.tex", "first autosave");
    const first = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"]);
    vi.setSystemTime(new Date("2026-01-01T00:01:59.000Z"));
    writeSource(fixture, "main.tex", "merged autosave");
    const merged = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"]);
    vi.setSystemTime(new Date("2026-01-01T00:02:11.000Z"));
    writeSource(fixture, "main.tex", "next window");
    const next = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"]);

    expect(merged?.id).toBe(first?.id);
    expect(merged?.createdAt).toBe("2026-01-01T00:00:10.000Z");
    expect(next?.id).not.toBe(first?.id);
    expect(fixture.history.list(fixture.projectId).filter((version) => version.reason === "autosave")).toHaveLength(2);
  });

  it("rejects restoring an autosave that changed after it was inspected", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fixture.history.record(fixture.projectId, "user-1", "initial");

    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    writeSource(fixture, "main.tex", "first inspected autosave");
    const inspected = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"])!;

    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    writeSource(fixture, "main.tex", "newer content in the same autosave window");
    const merged = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"])!;

    expect(merged.id).toBe(inspected.id);
    expect(merged.snapshotHash).not.toBe(inspected.snapshotHash);
    let failure: unknown;
    try {
      fixture.history.assertSnapshotHash(fixture.projectId, inspected.id, inspected.snapshotHash);
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toMatchObject({ statusCode: 409, code: "HISTORY_VERSION_CHANGED" });
    expect(() => fixture.history.assertSnapshotHash(fixture.projectId, merged.id, merged.snapshotHash)).not.toThrow();
  });

  it("pages snapshots with a stable cursor when several records share a timestamp", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ids: string[] = [];
    for (let index = 1; index <= 5; index++) {
      writeSource(fixture, "main.tex", `snapshot-${index}`);
      ids.push(fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!.id);
    }

    const newest = fixture.history.listPage(fixture.projectId, 2);
    const middle = fixture.history.listPage(fixture.projectId, 2, newest.nextCursor!);
    const oldest = fixture.history.listPage(fixture.projectId, 2, middle.nextCursor!);

    expect(newest.nextCursor).not.toBeNull();
    expect(middle.nextCursor).not.toBeNull();
    expect(oldest.nextCursor).toBeNull();
    expect([...newest.versions, ...middle.versions, ...oldest.versions].map((version) => version.id)).toEqual([...ids].reverse());
    expect(() => fixture.history.listPage(fixture.projectId, 2, "not-a-history-cursor")).toThrow();
  });

  it("finds the immediately preceding snapshot independently of a loaded page", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    writeSource(fixture, "main.tex", "second");
    const second = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    writeSource(fixture, "main.tex", "third");
    const third = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;

    expect(fixture.history.previousVersion(fixture.projectId, third.id)?.id).toBe(second.id);
    expect(fixture.history.previousVersion(fixture.projectId, second.id)?.id).toBe(first.id);
    expect(fixture.history.previousVersion(fixture.projectId, first.id)).toBeNull();
  });

  it("retains protected versions while enforcing count and storage soft limits", () => {
    const fixture = createFixture({ maxVersions: 2, maxStorageBytes: 20 });
    const initial = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    writeSource(fixture, "main.tex", "BBBBBBBBBB");
    const labeled = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    fixture.history.setLabel(fixture.projectId, labeled.id, "Milestone");
    writeSource(fixture, "main.tex", "CCCCCCCCCC");
    const current = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    writeSource(fixture, "main.tex", "DDDDDDDDDD");
    const latest = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;

    expect(fixture.history.version(initial.id, fixture.projectId)).not.toBeNull();
    expect(fixture.history.version(labeled.id, fixture.projectId)?.label).toBe("Milestone");
    expect(fixture.history.version(latest.id, fixture.projectId)).not.toBeNull();
    expect(fixture.history.version(current.id, fixture.projectId)).toBeNull();
    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.ordinaryVersionCount).toBeLessThanOrEqual(2);
    expect(stats.storageLimitExceeded).toBe(true);
    expect(stats.protectedBytes).toBeGreaterThan(stats.maxStorageBytes);
  });

  it("strictly enforces ordinary version count cap without counting deviation", () => {
    const fixture = createFixture({ maxVersions: 3, maxStorageBytes: 512 * 1024 * 1024 });
    fixture.history.record(fixture.projectId, "user-1", "initial");

    for (let i = 1; i <= 6; i++) {
      writeSource(fixture, "main.tex", `version-${i}`);
      fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"]);
    }

    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.ordinaryVersionCount).toBe(3);
    const versions = fixture.history.list(fixture.projectId).filter((v) => v.reason !== "initial" && !v.label);
    expect(versions).toHaveLength(3);
  });

  it("does not prune ordinary versions by count when maxVersions is 0 (unlimited)", () => {
    const fixture = createFixture({ maxVersions: 0, maxStorageBytes: 512 * 1024 * 1024 });
    fixture.history.record(fixture.projectId, "user-1", "initial");

    for (let i = 1; i <= 6; i++) {
      writeSource(fixture, "main.tex", `version-${i}`);
      fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"]);
    }

    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.ordinaryVersionCount).toBe(6);
    expect(stats.maxVersions).toBe(0);
    const versions = fixture.history.list(fixture.projectId).filter((v) => v.reason !== "initial" && !v.label);
    expect(versions).toHaveLength(6);
  });

  it("can defer retention without delaying the durable history version", () => {
    vi.useFakeTimers();
    const fixture = createFixture({ maxVersions: 2, maxStorageBytes: 512 * 1024 * 1024 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fixture.history.record(fixture.projectId, "user-1", "initial");

    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:0${i * 3}:00.000Z`));
      writeSource(fixture, "main.tex", `version-${i}`);
      fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"], { deferRetention: true });
    }

    expect(fixture.history.stats(fixture.projectId).ordinaryVersionCount).toBe(3);
    fixture.history.enforceRetention(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId).ordinaryVersionCount).toBe(2);
  });

  it("removes unreferenced objects left by a deferred coalesced autosave", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fixture.history.record(fixture.projectId, "user-1", "initial");

    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    writeSource(fixture, "main.tex", "first autosave");
    fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"], { deferRetention: true });
    const staleDigest = createHash("sha256").update("first autosave").digest("hex");
    const staleObject = path.join(
      fixture.config.projectsDir, fixture.projectId, "output", ".texlite", "history", "objects", staleDigest.slice(0, 2), staleDigest
    );
    expect(fs.existsSync(staleObject)).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    writeSource(fixture, "main.tex", "merged autosave");
    fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"], { deferRetention: true });
    expect(fs.existsSync(staleObject)).toBe(true);

    fixture.history.enforceRetention(fixture.projectId);
    expect(fs.existsSync(staleObject)).toBe(false);
  });

  it("keeps a correct current baseline after deleting the latest visible version", () => {
    const fixture = createFixture();
    fixture.history.record(fixture.projectId, "user-1", "initial");
    writeSource(fixture, "chapters/intro.tex", "current companion");
    const latest = fixture.history.record(fixture.projectId, "user-1", "file", ["chapters/intro.tex"])!;
    expect(fixture.history.deleteVersion(fixture.projectId, latest.id)).toBe(true);

    writeSource(fixture, "main.tex", "new main");
    const afterDelete = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    expect(fixture.history.readTextFile(fixture.projectId, afterDelete.id, "chapters/intro.tex")).toBe("current companion");

    fixture.history.clear(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId)).toMatchObject({ versionCount: 0, objectCount: 0, objectBytes: 0 });
    writeSource(fixture, "main.tex", "after clear");
    const rebuilt = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    expect(fixture.history.readTextFile(fixture.projectId, rebuilt.id, "chapters/intro.tex")).toBe("current companion");
  });

  it("returns an actionable error when a stored snapshot object is missing", () => {
    const fixture = createFixture();
    writeSource(fixture, "main.tex", "snapshot payload");
    const version = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    const digest = createHash("sha256").update("snapshot payload").digest("hex");
    const object = path.join(
      fixture.config.projectsDir, fixture.projectId, "output", ".texlite", "history", "objects", digest.slice(0, 2), digest
    );
    fs.rmSync(object);

    let previewError: unknown;
    try {
      fixture.history.readTextFile(fixture.projectId, version.id, "main.tex");
    } catch (error) {
      previewError = error;
    }
    expect(previewError).toMatchObject({ statusCode: 410, code: "HISTORY_OBJECT_MISSING", details: { path: "main.tex" } });

    let restoreError: unknown;
    try {
      fixture.history.restore(fixture.projectId, version.id, "main.tex");
    } catch (error) {
      restoreError = error;
    }
    expect(restoreError).toMatchObject({ statusCode: 410, code: "HISTORY_OBJECT_MISSING", details: { path: "main.tex" } });
    expect(fs.readdirSync(sourceRoot(fixture.config, fixture.projectId)).some((entry) => entry.includes(".history-") && entry.endsWith(".tmp"))).toBe(false);

    writeSource(fixture, "main.tex", "current live source");
    let treeRestoreError: unknown;
    try {
      fixture.history.restore(fixture.projectId, version.id);
    } catch (error) {
      treeRestoreError = error;
    }
    expect(treeRestoreError).toMatchObject({ statusCode: 410, code: "HISTORY_OBJECT_MISSING", details: { path: "main.tex" } });
    expect(fs.readFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "main.tex"), "utf8")).toBe("current live source");
    expect(fs.readdirSync(path.dirname(sourceRoot(fixture.config, fixture.projectId)))
      .some((entry) => entry.startsWith(".history-restore-") || entry.startsWith(".history-backup-"))).toBe(false);
  });

  it("batch-prunes multiple obsolete versions in a single pass when storage limit is exceeded", () => {
    const fixture = createFixture({ maxVersions: 10, maxStorageBytes: 3_000 });
    fixture.history.record(fixture.projectId, "user-1", "initial");

    for (let i = 1; i <= 5; i++) {
      writeSource(fixture, "main.tex", `payload-${i}-${"X".repeat(1000)}`);
      fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"]);
    }

    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.storageLimitExceeded).toBe(false);
    expect(stats.totalBytes).toBeLessThanOrEqual(3_000);
    expect(stats.versionCount).toBeLessThan(6);
  });

  it("bounds metadata even when settings-only snapshots reuse all file objects", () => {
    const fixture = createFixture({ maxVersions: 0, maxStorageBytes: 3_000 });
    fixture.history.record(fixture.projectId, "user-1", "initial");
    for (let index = 0; index < 30; index++) {
      fixture.db.prepare("UPDATE projects SET latexmkrc = ? WHERE id = ?").run(String(index % 2), fixture.projectId);
      fixture.history.record(fixture.projectId, "user-1", "settings", []);
    }
    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.objectBytes).toBe(5);
    expect(stats.metadataBytes).toBeGreaterThan(0);
    expect(stats.totalBytes).toBe(stats.metadataBytes + stats.objectBytes);
    expect(stats.totalBytes).toBeLessThanOrEqual(3_000);
    expect(stats.versionCount).toBeLessThan(31);
    expect(stats.protectedBytes).toBeLessThanOrEqual(stats.totalBytes);
    fixture.history.clear(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId)).toMatchObject({ totalBytes: 0, metadataBytes: 0, protectedBytes: 0 });
  });

  it("coalesces different authors within one project window without attributing the snapshot to one author", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.db.prepare(`INSERT INTO users SELECT 'user-2', 'peer', 'Peer', password_hash, role, disabled, must_change_password, can_create_projects, created_at FROM users WHERE id = 'user-1'`).run();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = fixture.history.record(fixture.projectId, "user-1", "autosave")!;
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    writeSource(fixture, "main.tex", "peer edit");
    expect(fixture.history.record(fixture.projectId, "user-2", "autosave", ["main.tex"])?.id).toBe(first.id);
    expect(fixture.history.version(first.id)?.author).toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:02:01Z"));
    writeSource(fixture, "main.tex", "next window");
    expect(fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"])?.id).not.toBe(first.id);
  });

  function createFixture(options: { maxVersions?: number; maxStorageBytes?: number } = {}): HistoryFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-history-"));
    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "History Test", adminEmail: "",
      host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
      allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
      pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
      historyMaxVersions: options.maxVersions ?? 200,
      historyMaxStorageBytes: options.maxStorageBytes ?? 512 * 1024 * 1024,
      editHistoryMaxStorageBytes: 32 * 1024 * 1024,
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
    };
    const db = openDatabase(config);
    const projectId = "project-1";
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES ('user-1', 'owner', 'Owner', 'hash', 'admin', 0, 0, 1, '2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO projects
      (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
      VALUES (?, 'user-1', 'user-1', 'Paper', 'main.tex', NULL, 'xelatex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(projectId);
    fs.mkdirSync(sourceRoot(config, projectId), { recursive: true });
    writeSource({ config, projectId }, "main.tex", "A");
    writeSource({ config, projectId }, "chapters/intro.tex", "keep");
    const fixture = { root, config, db, history: new ProjectHistoryService(config, db), projectId };
    fixtures.push(fixture);
    return fixture;
  }
});

function writeSource(fixture: Pick<HistoryFixture, "config" | "projectId">, relative: string, content: string): void {
  const target = path.join(sourceRoot(fixture.config, fixture.projectId), relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
