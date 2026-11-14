import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { downloadProjectTemplate, templateUrl } from "./projectTemplateDownload.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;
interface CacheEntry { expiresAt: number; size: number; sha256: string }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Unauthenticated ZIPs. Cache lifetime is not a remote freshness check. */
export class ProjectTemplateCache {
  private fileWork: Promise<unknown> = Promise.resolve();
  private nextCleanup = 0;
  constructor(private readonly directory: string, private readonly maxBytes: number) {}

  // Keep local reads, publication and expiry cleanup consistent; network requests
  // remain independent so a slow template does not block other downloads.
  private files<T>(work: () => Promise<T>): Promise<T> {
    const result = this.fileWork.then(work);
    this.fileWork = result.catch(() => undefined);
    return result;
  }

  async download(value: unknown, signal?: AbortSignal): Promise<{ archive: Buffer; cached: boolean }> {
    const url = templateUrl(value).href;
    const key = digest(url); // Do not put URLs or signed query strings in filenames.
    signal?.throwIfAborted();
    const cached = await this.files(async () => {
      const now = Date.now();
      if (now >= this.nextCleanup) {
        this.nextCleanup = now + 60 * 60_000;
        await this.cleanup(now);
      }
      try {
        const entry = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), "utf8")) as CacheEntry;
        if (!(entry.expiresAt > now) || !(entry.size > 0 && entry.size <= this.maxBytes)) return null;
        const file = path.join(this.directory, `${key}.zip`);
        if ((await fs.stat(file)).size !== entry.size) return null;
        const archive = await fs.readFile(file);
        return digest(archive) === entry.sha256 ? archive : null;
      } catch { return null; }
    });
    signal?.throwIfAborted();
    if (cached) return { archive: cached, cached: true };
    return { archive: await downloadProjectTemplate(url, this.maxBytes, signal), cached: false };
  }

  /** Publish only after the archive has successfully passed project import. */
  async store(value: unknown, archive: Buffer): Promise<void> {
    const key = digest(templateUrl(value).href);
    // Caching is optional: a cache write failure must not discard a valid import.
    await this.files(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = path.join(this.directory, `${key}-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, archive, { mode: 0o600 });
        await fs.rename(temp, path.join(this.directory, `${key}.zip`));
        const entry: CacheEntry = { expiresAt: Date.now() + WEEK_MS, size: archive.length, sha256: digest(archive) };
        await fs.writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
        await fs.rename(temp, path.join(this.directory, `${key}.json`));
      } finally { await fs.rm(temp, { force: true }); }
    }).catch(() => undefined);
  }

  private async cleanup(now: number): Promise<void> {
    const entries = await fs.readdir(this.directory).catch(() => [] as string[]);
    for (const file of entries) {
      // A crash between publication steps can leave a temp file or a ZIP with
      // no index. No writer runs concurrently with this serialized cleanup.
      if (/^[a-f0-9]{64}-[a-f0-9-]{36}\.tmp$/.test(file)
        || (/^[a-f0-9]{64}\.zip$/.test(file) && !entries.includes(file.slice(0, -4) + ".json"))) {
        await fs.rm(path.join(this.directory, file), { force: true }).catch(() => undefined);
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const entry = JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")) as CacheEntry;
        if (entry.expiresAt > now) continue;
        await fs.rm(path.join(this.directory, file.slice(0, -5) + ".zip"), { force: true });
        await fs.rm(path.join(this.directory, file), { force: true });
      } catch { /* A missing or unreadable cache is a normal cache miss. */ }
    }
  }
}
