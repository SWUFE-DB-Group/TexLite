import fs from "node:fs/promises";
import path from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_CHECK_INTERVAL_MS = 60_000;
const LOG_BACKUPS = 3;

export function managedLogPaths(dataDir: string): { stdout: string; stderr: string } {
  const directory = path.resolve(dataDir, "logs");
  return { stdout: path.join(directory, "stdout.log"), stderr: path.join(directory, "stderr.log") };
}

/** PM2 owns the open descriptors: copy/truncate keeps them valid across rotation. */
export class LogRotation {
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly dataDir: string,
    private readonly onError: (error: unknown) => void,
    private readonly maxBytes = LOG_MAX_BYTES
  ) {}

  async start(): Promise<void> {
    await this.check();
    if (!this.stopped && !this.timer) {
      this.timer = setInterval(() => { void this.check(); }, LOG_CHECK_INTERVAL_MS);
      this.timer.unref();
    }
  }

  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.rotateLogs().finally(() => { this.pending = null; });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  private async rotateLogs(): Promise<void> {
    for (const file of Object.values(managedLogPaths(this.dataDir))) {
      try { await this.rotate(file); }
      catch (error) { this.onError(error); }
    }
  }

  private async rotate(file: string): Promise<void> {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat?.isFile() || stat.size < this.maxBytes) return;
    const temporary = `${file}.rotate.tmp`;
    try {
      // Do not truncate until a complete backup has been successfully published.
      await fs.copyFile(file, temporary);
      await fs.rm(`${file}.${LOG_BACKUPS}`, { force: true });
      for (let index = LOG_BACKUPS - 1; index >= 1; index--) {
        await fs.rename(`${file}.${index}`, `${file}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      await fs.rename(temporary, `${file}.1`);
      // Writes between the copy and truncate can be lost; these are diagnostic logs.
      await fs.truncate(file, 0);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
