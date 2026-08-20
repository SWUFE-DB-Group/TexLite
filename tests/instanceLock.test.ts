import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import {
  LOCK_FILE_NAME,
  acquireDataDirectoryLock,
  isProcessAlive,
  readDataDirectoryLock
} from "../src/server/instanceLock.js";

describe("instance lock", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function mockConfig(dataDir: string, configPath = "/test/texlite.config.json"): Config {
    return {
      dataDir,
      configPath,
      host: "127.0.0.1",
      port: 3000,
      databasePath: path.join(dataDir, "texlite.db"),
      projectsDir: path.join(dataDir, "projects"),
      clientDir: "/test/client",
      siteName: "TexLite Test",
      adminEmail: "admin@example.com",
      sessionDays: 7,
      maxUploadBytes: 50 * 1024 * 1024,
      historyMaxVersions: 50,
      historyMaxStorageBytes: 100 * 1024 * 1024,
      latexmk: "latexmk",
      defaultEngine: "xelatex",
      allowedEngines: ["pdflatex", "xelatex", "lualatex"],
      extraArgs: [],
      allowProjectLatexmkrc: false,
      compileTimeoutMs: 60000,
      maxCompileJobs: 2,
      git: "git",
      gitOperationTimeoutMs: 15000,
      githubApiBaseUrl: "https://api.github.com"
    };
  }

  it("checks process liveness accurately", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(999999999)).toBe(false);
  });

  it("acquires and releases a data directory lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-lock-test-"));
    temporaryRoots.push(root);
    const config = mockConfig(root);

    const lock = acquireDataDirectoryLock(config);
    expect(lock.info.pid).toBe(process.pid);
    expect(lock.info.configPath).toBe(config.configPath);

    const read = readDataDirectoryLock(root);
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(process.pid);
    expect(read?.token).toBe(lock.info.token);
    expect(fs.statSync(path.join(root, LOCK_FILE_NAME)).isDirectory()).toBe(true);

    lock.release();
    expect(fs.existsSync(path.join(root, LOCK_FILE_NAME))).toBe(false);
    expect(readDataDirectoryLock(root)).toBeNull();
  });

  it("rejects concurrent lock acquisition on the same data directory with active PID", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-lock-test-"));
    temporaryRoots.push(root);
    const config1 = mockConfig(root, "/path/one/texlite.config.json");
    const config2 = mockConfig(root, "/path/two/texlite.config.json");

    const lock1 = acquireDataDirectoryLock(config1);
    try {
      expect(() => acquireDataDirectoryLock(config2)).toThrow(/already locked by another TexLite instance/);
    } finally {
      lock1.release();
    }

    // Once released, second acquisition succeeds
    const lock2 = acquireDataDirectoryLock(config2);
    expect(lock2.info.configPath).toBe(config2.configPath);
    lock2.release();
  });

  it("recovers from a stale lock left by a dead process", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-lock-test-"));
    temporaryRoots.push(root);
    const config = mockConfig(root);

    // Simulate stale lockfile from dead PID 999999999
    const lockPath = path.join(root, LOCK_FILE_NAME);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      startedAt: "2020-01-01T00:00:00.000Z",
      token: "stale-token",
      configPath: "/old/config.json",
      host: "127.0.0.1",
      port: 3000
    }), "utf8");

    const lock = acquireDataDirectoryLock(config);
    expect(lock.info.pid).toBe(process.pid);
    const read = readDataDirectoryLock(root);
    expect(read?.pid).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("never removes a fresh lock directory whose owner metadata is still being installed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-lock-test-"));
    temporaryRoots.push(root);
    const lockPath = path.join(root, LOCK_FILE_NAME);
    fs.mkdirSync(lockPath, { mode: 0o700 });

    expect(() => acquireDataDirectoryLock(mockConfig(root))).toThrow(/being initialized by another TexLite instance/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
