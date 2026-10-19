import fs from "node:fs";
import path from "node:path";
import { gt, prerelease, valid } from "semver";
import type { DatabaseConnection } from "./db.js";
import { packageRootDirectory } from "./runtimePaths.js";
import type { UpdateMethod, UpdateNotice } from "../shared/updates.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_RETRY_INTERVAL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const REGISTRY_URL = "https://registry.npmjs.org/texlite/latest";

interface UpdateCache {
  latest_version: string | null;
  next_check_at: number;
}

interface UpdateCheckerOptions {
  enabled: boolean;
  fetch?: typeof fetch;
  currentVersion?: string;
  method?: UpdateMethod;
  now?: () => number;
}

function packageVersion(): string {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRootDirectory(), "package.json"), "utf8")) as { version: string };
  return metadata.version;
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && valid(value) === value && prerelease(value) === null;
}

/** One background checker per server; cached results and dismissals survive restarts. */
export class UpdateChecker {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly currentVersion: string;
  private readonly method: UpdateMethod;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly db: DatabaseConnection, private readonly options: UpdateCheckerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.currentVersion = options.currentVersion ?? packageVersion();
    this.method = options.method ?? (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv") ? "docker" : "npm");
  }

  start(): void {
    if (!this.options.enabled || this.disposed || this.timer) return;
    void this.check().catch(() => undefined);
    this.timer = setInterval(() => { void this.check().catch(() => undefined); }, UPDATE_RETRY_INTERVAL_MS);
    this.timer.unref();
  }

  private cache(): UpdateCache | undefined {
    return this.db.prepare("SELECT latest_version, next_check_at FROM update_check_cache WHERE id = 1").get() as UpdateCache | undefined;
  }

  check(): Promise<void> {
    if (!this.options.enabled || this.disposed || !valid(this.currentVersion)) return Promise.resolve();
    if (this.pending) return this.pending;
    if ((this.cache()?.next_check_at ?? 0) > this.now()) return Promise.resolve();
    this.pending = this.checkRegistry().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async checkRegistry(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    let latest: string | null = null;
    try {
      const response = await this.fetch(REGISTRY_URL, {
        headers: { Accept: "application/json" }, signal: controller.signal,
        credentials: "omit", redirect: "error"
      });
      if (!response.ok) throw new Error("Update registry unavailable");
      const metadata: unknown = await response.json();
      const version = metadata && typeof metadata === "object" && "version" in metadata ? metadata.version : null;
      if (!stableVersion(version)) throw new Error("Invalid stable release version");
      latest = version;
    } catch {
      // Offline operation is normal. Keep the last known release and back off.
    } finally {
      clearTimeout(timeout);
      this.controller = null;
    }
    if (this.disposed) return;
    this.db.prepare(`INSERT INTO update_check_cache (id, latest_version, next_check_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET latest_version = COALESCE(excluded.latest_version, latest_version), next_check_at = excluded.next_check_at`)
      .run(latest, this.now() + (latest ? UPDATE_CHECK_INTERVAL_MS : UPDATE_RETRY_INTERVAL_MS));
  }

  notice(userId: string): UpdateNotice | null {
    if (!this.options.enabled || !valid(this.currentVersion)) return null;
    const latest = this.cache()?.latest_version;
    if (!stableVersion(latest) || !gt(latest, this.currentVersion)) return null;
    const dismissed = this.db.prepare("SELECT version FROM dismissed_updates WHERE user_id = ?").get(userId) as { version: string } | undefined;
    if (dismissed && valid(dismissed.version) && !gt(latest, dismissed.version)) return null;
    return { currentVersion: this.currentVersion, latestVersion: latest, method: this.method };
  }

  dismiss(userId: string, version: unknown): boolean {
    if (!stableVersion(version) || this.cache()?.latest_version !== version) return false;
    const previous = this.db.prepare("SELECT version FROM dismissed_updates WHERE user_id = ?").get(userId) as { version: string } | undefined;
    if (previous && valid(previous.version) && gt(previous.version, version)) return true;
    this.db.prepare(`INSERT INTO dismissed_updates (user_id, version) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET version = excluded.version`).run(userId, version);
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.pending;
  }
}
