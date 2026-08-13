import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  function createFixture(options: { maxVersions?: number; maxStorageBytes?: number } = {}): HistoryFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-history-"));
    const config: Config = {
      configPath: path.join(root, "config.json"), siteName: "History Test", adminEmail: "",
      host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
      projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
      compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
      allowedEngines: ["xelatex"], extraArgs: [], allowProjectLatexmkrc: true, maxUploadBytes: 1024 * 1024,
      historyMaxVersions: options.maxVersions ?? 200,
      historyMaxStorageBytes: options.maxStorageBytes ?? 512 * 1024 * 1024,
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
