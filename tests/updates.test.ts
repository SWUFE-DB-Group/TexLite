import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { UpdateChecker, UPDATE_CHECK_INTERVAL_MS, UPDATE_RETRY_INTERVAL_MS } from "../src/server/updates.js";
import { UPDATE_COMMANDS } from "../src/shared/updates.js";

describe("update notifications", () => {
  let root: string;
  let db: DatabaseConnection;
  let now: number;
  const checkers: UpdateChecker[] = [];
  let version: unknown;
  let failure: boolean;
  const registry = vi.fn<typeof fetch>(async () => {
    if (failure) throw new TypeError("Network unavailable");
    return Response.json({ version });
  });
  const config = () => ({ ...loadConfig(path.join(root, "config.json")),
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects") });
  const checker = (overrides: Partial<ConstructorParameters<typeof UpdateChecker>[1]> = {}) => {
    const value = new UpdateChecker(db, { enabled: true, fetch: registry, currentVersion: "0.16.0", method: "npm", now: () => now, ...overrides });
    checkers.push(value);
    return value;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-updates-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ storage: { dataDir: root } }));
    db = openDatabase(config());
    db.exec(`INSERT INTO users (id, username, display_name, password_hash, role, created_at)
      VALUES ('a', 'alice', 'Alice', 'hash', 'admin', '2026-10-19'), ('b', 'bob', 'Bob', 'hash', 'admin', '2026-10-19')`);
    now = Date.now();
    version = "0.17.0";
    failure = false;
    registry.mockClear();
  });

  afterEach(async () => {
    for (const value of checkers.splice(0)) await value.dispose();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("coalesces checks, caches for a day, and compares semantic versions", async () => {
    const updates = checker({ currentVersion: "0.9.9" });
    await Promise.all([updates.check(), updates.check(), updates.check()]);
    expect(registry).toHaveBeenCalledTimes(1);
    expect(updates.notice("a")).toMatchObject({ currentVersion: "0.9.9", latestVersion: "0.17.0", method: "npm" });
    expect(registry.mock.calls[0][0]).toBe("https://registry.npmjs.org/texlite/latest");
    now += UPDATE_CHECK_INTERVAL_MS - 1;
    await updates.check();
    expect(registry).toHaveBeenCalledTimes(1);
    now += 1;
    version = "0.18.0";
    await updates.check();
    expect(registry).toHaveBeenCalledTimes(2);
    expect(updates.notice("a")?.latestVersion).toBe("0.18.0");
  });

  it("persists per-user dismissals and cached checks across database and server restarts", async () => {
    const updates = checker();
    await updates.check();
    expect(updates.dismiss("a", "0.17.0")).toBe(true);
    expect(updates.notice("a")).toBeNull();
    expect(updates.notice("b")).not.toBeNull();
    await updates.dispose();
    db.close();
    db = openDatabase(config());
    const restarted = checker();
    await restarted.check();
    expect(registry).toHaveBeenCalledTimes(1);
    expect(restarted.notice("a")).toBeNull();
    now += UPDATE_CHECK_INTERVAL_MS;
    version = "0.18.0";
    await restarted.check();
    expect(restarted.notice("a")?.latestVersion).toBe("0.18.0");
    expect(restarted.dismiss("a", "0.17.0")).toBe(false);
    db.prepare("DELETE FROM users WHERE id = 'a'").run();
    expect(db.prepare("SELECT * FROM dismissed_updates WHERE user_id = 'a'").get()).toBeUndefined();
  });

  it.each(["0.16.0", "0.15.9", "0.17.0-beta.1", "invalid", null, "1; rm -rf /"])("does not advertise %s", async (candidate) => {
    version = candidate;
    const updates = checker();
    await updates.check();
    expect(updates.notice("a")).toBeNull();
  });

  it("does not repeat a dismissed release after a registry rollback", async () => {
    const updates = checker();
    await updates.check();
    updates.dismiss("a", "0.17.0");
    now += UPDATE_CHECK_INTERVAL_MS;
    version = "0.16.5";
    await updates.check();
    expect(updates.notice("a")).toBeNull();
  });

  it("keeps the last result on network failure and retries after an hour", async () => {
    const updates = checker();
    await updates.check();
    now += UPDATE_CHECK_INTERVAL_MS;
    failure = true;
    await updates.check();
    expect(updates.notice("a")?.latestVersion).toBe("0.17.0");
    await updates.check();
    expect(registry).toHaveBeenCalledTimes(2);
    now += UPDATE_RETRY_INTERVAL_MS;
    failure = false;
    version = "0.18.0";
    await updates.check();
    expect(updates.notice("a")?.latestVersion).toBe("0.18.0");
  });

  it("can be disabled without requests or notifications", async () => {
    await checker().check();
    registry.mockClear();
    const disabled = checker({ enabled: false });
    disabled.start();
    await disabled.check();
    expect(disabled.notice("a")).toBeNull();
    expect(registry).not.toHaveBeenCalled();
  });

  it("aborts timed-out checks and stops background work on shutdown", async () => {
    vi.useFakeTimers();
    const stalled = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const updates = checker({ fetch: stalled });
    const pending = updates.check();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(updates.notice("a")).toBeNull();
    now += UPDATE_RETRY_INTERVAL_MS;
    updates.start();
    expect(stalled).toHaveBeenCalledTimes(2);
    await updates.dispose();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(stalled).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT latest_version FROM update_check_cache").get()).toEqual({ latest_version: null });
  });

  it("provides Docker instructions that update the launcher before pulling and recreating", async () => {
    const updates = checker({ method: "docker" });
    await updates.check();
    expect(updates.notice("a")?.method).toBe("docker");
    expect(UPDATE_COMMANDS.docker.split("\n")).toEqual([
      "git pull --ff-only", "./scripts/compose.sh pull", "./scripts/compose.sh up -d"
    ]);
  });
});
