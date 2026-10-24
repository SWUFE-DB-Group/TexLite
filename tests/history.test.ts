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

  it("does not save settings-only snapshots and captures settings with the next file change", () => {
    const fixture = createFixture({ maxVersions: 0, maxStorageBytes: 3_000 });
    fixture.history.record(fixture.projectId, "user-1", "initial");
    for (let index = 0; index < 30; index++) {
      fixture.db.prepare("UPDATE projects SET latexmkrc = ? WHERE id = ?").run(String(index % 2), fixture.projectId);
      expect(fixture.history.record(fixture.projectId, "user-1", "settings", [])).toBeNull();
    }
    const stats = fixture.history.stats(fixture.projectId);
    expect(stats.objectBytes).toBe(5);
    expect(stats.metadataBytes).toBeGreaterThan(0);
    expect(stats.totalBytes).toBe(stats.metadataBytes + stats.objectBytes);
    expect(stats.totalBytes).toBeLessThanOrEqual(3_000);
    expect(stats.versionCount).toBe(1);
    expect(stats.protectedBytes).toBeLessThanOrEqual(stats.totalBytes);
    writeSource(fixture, "main.tex", "changed");
    const next = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    expect(fixture.history.manifest(fixture.projectId, next.id)?.settings.latexmkrc).toBe("1");
    fixture.history.clear(fixture.projectId);
    expect(fixture.history.stats(fixture.projectId)).toMatchObject({ totalBytes: 0, metadataBytes: 0, protectedBytes: 0 });
  });

  it("hides existing empty snapshots without losing pagination or previous-version lookup", () => {
    const fixture = createFixture();
    const initial = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    // Simulate a settings-only snapshot written by an older TexLite release.
    fixture.db.prepare(`INSERT INTO project_history_versions
      (id, project_id, author_id, reason, manifest_json, changed_paths_json, created_at)
      SELECT 'legacy-empty', project_id, author_id, 'settings', manifest_json, '[]', created_at
      FROM project_history_versions WHERE id = ?`).run(initial.id);
    writeSource(fixture, "main.tex", "next");
    const next = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    expect(fixture.history.list(fixture.projectId).map(version => version.id)).toEqual([next.id, initial.id]);
    const newest = fixture.history.listPage(fixture.projectId, 1);
    const oldest = fixture.history.listPage(fixture.projectId, 1, newest.nextCursor!);
    expect(newest.versions.map(version => version.id)).toEqual([next.id]);
    expect(oldest.versions.map(version => version.id)).toEqual([initial.id]);
    expect(oldest.nextCursor).toBeNull();
    expect(fixture.history.previousVersion(fixture.projectId, next.id)?.id).toBe(initial.id);
  });

  it("records only text by default, including unknown UTF-8 files, and skips binary-only changes", () => {
    const fixture = createFixture();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    fs.writeFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), pdf);
    fs.writeFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "binary.txt"), Buffer.from([0xff, 0xfe]));
    writeSource(fixture, "notes.custom", "plain UTF-8 notes");
    const version = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    expect(Object.keys(fixture.history.manifest(fixture.projectId, version.id)!.files).sort()).toEqual(["chapters/intro.tex", "main.tex", "notes.custom"]);
    expect(fixture.history.readTextFile(fixture.projectId, version.id, "figure.pdf")).toBeNull();
    expect(fixture.history.readTextFile(fixture.projectId, version.id, "binary.txt")).toBeNull();
    expect(fixture.history.readTextFile(fixture.projectId, version.id, "main.tex")).toBe("A");
    fs.writeFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), "modified");
    expect(fixture.history.record(fixture.projectId, "user-1", "file", ["figure.pdf"])).toBeNull();
    expect(fixture.history.stats(fixture.projectId).objectBytes).toBe(Buffer.byteLength("Akeepplain UTF-8 notes"));
  });

  it("shares text classification between default recording, snapshot metadata and text comparisons", () => {
    const fixture = createFixture();
    const sources = {
      "build.bat": "@echo off\r\necho Hello\r\n", "scripts/RUN.CMD": "echo Ready\r\n",
      "notes.custom": "中文 notes\n", "custom-name": "plain text\n", "settings.ini": "[latex]\nengine=xelatex\n",
      "plot.eps": "%!PS-Adobe-3.0 EPSF-3.0\n"
    };
    for (const [filePath, content] of Object.entries(sources)) writeSource(fixture, filePath, content);
    writeSource(fixture, "figure.pdf", "ASCII bytes in a PDF resource");
    const source = sourceRoot(fixture.config, fixture.projectId);
    fs.writeFileSync(path.join(source, "binary.bat"), Uint8Array.of(0, 1, 255));
    fs.writeFileSync(path.join(source, "control.custom"), Uint8Array.of(27, 91));
    for (const filePath of ["figure.pdf", "binary.bat", "control.custom"]) fixture.history.setFileTracking(fixture.projectId, filePath, true);
    const version = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    const manifest = fixture.history.manifest(fixture.projectId, version.id)!;
    const tracked = fixture.history.trackedFiles(fixture.projectId);
    for (const [filePath, content] of Object.entries(sources)) {
      expect(tracked).toContainEqual(expect.objectContaining({ path: filePath, defaultIncluded: true, included: true }));
      expect(manifest.files[filePath].textContent).toBe(true);
      expect(fixture.history.isTextFile(fixture.projectId, filePath, manifest.files[filePath])).toBe(true);
      expect(fixture.history.readTextFile(fixture.projectId, version.id, filePath)).toBe(content);
    }
    for (const filePath of ["figure.pdf", "binary.bat", "control.custom"]) {
      expect(tracked).toContainEqual(expect.objectContaining({ path: filePath, defaultIncluded: false, included: true }));
      expect(manifest.files[filePath].textContent).toBe(false);
      expect(fixture.history.isTextFile(fixture.projectId, filePath, manifest.files[filePath])).toBe(false);
      expect(fixture.history.readTextFile(fixture.projectId, version.id, filePath)).toBeNull();
    }
  });

  it("classifies older snapshot contents without rewriting immutable manifests or creating false edits", () => {
    const fixture = createFixture();
    writeSource(fixture, "build.bat", "echo Hello\r\n");
    fs.writeFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "binary.bat"), Uint8Array.of(0, 255));
    fixture.history.setFileTracking(fixture.projectId, "binary.bat", true);
    const version = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    const manifest = fixture.history.manifest(fixture.projectId, version.id)!;
    for (const file of Object.values(manifest.files)) delete file.textContent;
    const legacyJson = JSON.stringify(manifest);
    fixture.db.prepare("UPDATE project_history_versions SET manifest_json = ? WHERE id = ?").run(legacyJson, version.id);
    fixture.db.prepare("UPDATE project_history_state SET manifest_json = ? WHERE project_id = ?").run(legacyJson, fixture.projectId);
    expect(fixture.history.isTextFile(fixture.projectId, "build.bat", manifest.files["build.bat"])).toBe(true);
    expect(fixture.history.isTextFile(fixture.projectId, "binary.bat", manifest.files["binary.bat"])).toBe(false);
    expect(fixture.history.readTextFile(fixture.projectId, version.id, "build.bat")).toBe("echo Hello\r\n");
    expect(fixture.history.readTextFile(fixture.projectId, version.id, "binary.bat")).toBeNull();
    expect(fixture.history.record(fixture.projectId, "user-1", "file")).toBeNull();
    expect(fixture.db.prepare("SELECT manifest_json FROM project_history_versions WHERE id = ?").get(version.id)).toEqual({ manifest_json: legacyJson });
  });

  it("preserves unmanaged files on project restore while removing later managed text", () => {
    const fixture = createFixture();
    writeSource(fixture, "private.txt", "original excluded text");
    fixture.history.setFileTracking(fixture.projectId, "private.txt", false);
    const version = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    writeSource(fixture, "main.tex", "changed main");
    writeSource(fixture, "later.tex", "later managed text");
    writeSource(fixture, "private.txt", "new excluded text");
    writeSource(fixture, "figure.pdf", "current image");
    const binary = Buffer.from([0, 1, 255]);
    fs.writeFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "binary.txt"), binary);
    fixture.history.restore(fixture.projectId, version.id);
    const source = sourceRoot(fixture.config, fixture.projectId);
    expect(fs.readFileSync(path.join(source, "main.tex"), "utf8")).toBe("A");
    expect(fs.existsSync(path.join(source, "later.tex"))).toBe(false);
    expect(fs.readFileSync(path.join(source, "private.txt"), "utf8")).toBe("new excluded text");
    expect(fs.readFileSync(path.join(source, "figure.pdf"), "utf8")).toBe("current image");
    expect(fs.readFileSync(path.join(source, "binary.txt"))).toEqual(binary);
  });

  it("can include binary files, stop future recording, and reset defaults without deleting old recovery data", () => {
    const fixture = createFixture();
    writeSource(fixture, "figure.pdf", "first PDF");
    const initial = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", true);
    const included = fixture.history.record(fixture.projectId, "user-1", "file", ["figure.pdf"])!;
    expect(included.changedPaths).toEqual(["figure.pdf"]);
    expect(fixture.history.readTextFile(fixture.projectId, included.id, "figure.pdf")).toBeNull();
    expect(fixture.history.manifest(fixture.projectId, initial.id)!.files["figure.pdf"]).toBeUndefined();
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", null);
    expect(fixture.history.record(fixture.projectId, "user-1", "file", ["figure.pdf"])).toBeNull();
    writeSource(fixture, "figure.pdf", "latest PDF");
    fixture.history.restore(fixture.projectId, initial.id);
    expect(fs.readFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), "utf8")).toBe("latest PDF");
    fixture.history.restore(fixture.projectId, included.id, "figure.pdf");
    expect(fs.readFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), "utf8")).toBe("first PDF");
    expect(fixture.history.trackingPolicy(fixture.projectId).overrides).toEqual({});
  });

  it.each([undefined, "figure.pdf"])("checkpoints excluded files affected by a restore without changing project choices (%s)", (filePath) => {
    const fixture = createFixture();
    writeSource(fixture, "figure.pdf", "old PDF");
    writeSource(fixture, "excluded.txt", "old text");
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", true);
    const version = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", false);
    fixture.history.setFileTracking(fixture.projectId, "excluded.txt", false);
    fixture.history.record(fixture.projectId, "user-1", "settings", []);
    writeSource(fixture, "figure.pdf", "new PDF");
    writeSource(fixture, "excluded.txt", "new text");
    writeSource(fixture, "unrelated.png", "not affected");
    const policy = fixture.history.trackingPolicy(fixture.projectId);
    const checkpoint = fixture.history.checkpointForRestore(fixture.projectId, "user-1", version.id, filePath)!;
    const manifest = fixture.history.manifest(fixture.projectId, checkpoint.id)!;
    expect(manifest.files["figure.pdf"]).toBeDefined();
    expect(Boolean(manifest.files["excluded.txt"])).toBe(filePath === undefined);
    expect(manifest.files["unrelated.png"]).toBeUndefined();
    expect(fixture.history.trackingPolicy(fixture.projectId)).toEqual(policy);
    fixture.history.restore(fixture.projectId, version.id, filePath);
    expect(fs.readFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), "utf8")).toBe("old PDF");
    fixture.history.restore(fixture.projectId, checkpoint.id, "figure.pdf");
    expect(fs.readFileSync(path.join(sourceRoot(fixture.config, fixture.projectId), "figure.pdf"), "utf8")).toBe("new PDF");
  });

  it("starts a new autosave window after changing scope without rewriting an older snapshot", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = fixture.history.record(fixture.projectId, "user-1", "autosave")!;
    fixture.history.setFileTracking(fixture.projectId, "chapters/intro.tex", false);
    expect(fixture.history.record(fixture.projectId, "user-1", "file", ["chapters/intro.tex"])).toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    writeSource(fixture, "main.tex", "new main");
    const next = fixture.history.record(fixture.projectId, "user-1", "autosave", ["main.tex"])!;
    expect(next.id).not.toBe(first.id);
    expect(fixture.history.manifest(fixture.projectId, first.id)!.files["chapters/intro.tex"]).toBeDefined();
    expect(fixture.history.manifest(fixture.projectId, next.id)!.files["chapters/intro.tex"]).toBeUndefined();
  });

  it("adopts text-only tracking without a false binary deletion and retains legacy full-tree restores", () => {
    const fixture = createFixture();
    writeSource(fixture, "figure.pdf", "old PDF");
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", true);
    const legacy = fixture.history.record(fixture.projectId, "user-1", "initial")!;
    const manifest = fixture.history.manifest(fixture.projectId, legacy.id)!;
    delete manifest.tracking;
    fixture.db.prepare("UPDATE project_history_versions SET manifest_json = ? WHERE id = ?").run(JSON.stringify(manifest), legacy.id);
    fixture.db.prepare("UPDATE project_history_state SET manifest_json = ? WHERE project_id = ?").run(JSON.stringify(manifest), fixture.projectId);
    fixture.history.setFileTracking(fixture.projectId, "figure.pdf", null);
    expect(fixture.history.record(fixture.projectId, "user-1", "file", ["figure.pdf"])).toBeNull();
    writeSource(fixture, "main.tex", "new main");
    const next = fixture.history.record(fixture.projectId, "user-1", "file", ["main.tex"])!;
    expect(next.changedPaths).toEqual(["main.tex"]);
    expect(fixture.history.manifest(fixture.projectId, next.id)!.files["figure.pdf"]).toBeUndefined();
    writeSource(fixture, "figure.pdf", "changed PDF");
    writeSource(fixture, "extra.pdf", "new PDF");
    const checkpoint = fixture.history.checkpointForRestore(fixture.projectId, "user-1", legacy.id)!;
    expect(fixture.history.manifest(fixture.projectId, checkpoint.id)!.files["extra.pdf"]).toBeDefined();
    fixture.history.restore(fixture.projectId, legacy.id);
    const source = sourceRoot(fixture.config, fixture.projectId);
    expect(fs.readFileSync(path.join(source, "figure.pdf"), "utf8")).toBe("old PDF");
    expect(fs.existsSync(path.join(source, "extra.pdf"))).toBe(false);
    fixture.history.restore(fixture.projectId, checkpoint.id);
    expect(fs.readFileSync(path.join(source, "figure.pdf"), "utf8")).toBe("changed PDF");
    expect(fs.readFileSync(path.join(source, "extra.pdf"), "utf8")).toBe("new PDF");
  });

  it("keeps exclusions across history clearing and exposes missing overrides for reset", () => {
    const fixture = createFixture();
    fixture.history.setFileTracking(fixture.projectId, "main.tex", false);
    fixture.history.record(fixture.projectId, "user-1", "initial");
    fixture.history.clear(fixture.projectId);
    expect(fixture.history.trackedFiles(fixture.projectId)).toContainEqual(expect.objectContaining({ path: "main.tex", included: false, override: false }));
    fs.rmSync(path.join(sourceRoot(fixture.config, fixture.projectId), "main.tex"));
    expect(fixture.history.trackedFiles(fixture.projectId)).toContainEqual(expect.objectContaining({ path: "main.tex", missing: true, override: false }));
    fixture.history.setFileTracking(fixture.projectId, "main.tex", null);
    expect(fixture.history.trackedFiles(fixture.projectId).some((file) => file.path === "main.tex")).toBe(false);
  });

  it("coalesces different authors within one project window without attributing the snapshot to one author", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      SELECT 'user-2', 'peer', 'Peer', password_hash, role, disabled, must_change_password, can_create_projects, created_at FROM users WHERE id = 'user-1'`).run();
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
      git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com", updatesEnabled: false
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
