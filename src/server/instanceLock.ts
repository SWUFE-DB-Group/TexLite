import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

export const LOCK_FILE_NAME = ".texlite.lock";

export interface DataDirectoryLockInfo {
  pid: number;
  startedAt: string;
  token: string;
  configPath: string;
  host: string;
  port: number;
}

export interface DataDirectoryLock {
  release: () => void;
  lockPath: string;
  info: DataDirectoryLockInfo;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    return code === "EPERM";
  }
}

export function readDataDirectoryLock(dataDir: string): DataDirectoryLockInfo | null {
  const lockPath = path.join(dataDir, LOCK_FILE_NAME);
  const metadataPath = path.join(lockPath, "owner.json");
  try {
    if (!fs.existsSync(lockPath)) return null;
    // New locks are complete directories installed with atomic rename, so
    // readers never need to delete an empty/partially-written lock. Read the
    // old regular-file
    // format as a migration path for crashed instances from older releases.
    const lockStat = fs.lstatSync(lockPath);
    const content = fs.readFileSync(lockStat.isDirectory() ? metadataPath : lockPath, "utf8");
    const parsed = JSON.parse(content) as Partial<DataDirectoryLockInfo>;
    if (typeof parsed?.pid === "number" && typeof parsed?.startedAt === "string") {
      return parsed as DataDirectoryLockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function acquireDataDirectoryLock(config: Config): DataDirectoryLock {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.dataDir, LOCK_FILE_NAME);

  const lockInfo: DataDirectoryLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
    configPath: config.configPath,
    host: config.host,
    port: config.port
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // mkdir is the ownership operation. Another process can never acquire
      // the same directory; the owner metadata is then installed atomically
      // inside it. Readers never remove a fresh directory while this write is
      // in progress.
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const metadata = path.join(lockPath, "owner.json");
      const temporary = `${metadata}.${process.pid}-${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(lockInfo, null, 2)}\n`, {
          encoding: "utf8", mode: 0o600, flag: "wx"
        });
        fs.renameSync(temporary, metadata);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (fs.existsSync(lockPath)) {
            const current = readDataDirectoryLock(config.dataDir);
            if (current?.pid === lockInfo.pid && current.startedAt === lockInfo.startedAt
              && current.token === lockInfo.token) {
              fs.rmSync(lockPath, { recursive: true, force: true });
            }
          }
        } catch { /* Ignore file system cleanup errors on exit */ }
      };

      const exitHandler = () => release();
      process.once("exit", exitHandler);

      return {
        release: () => {
          process.removeListener("exit", exitHandler);
          release();
        },
        lockPath,
        info: lockInfo
      };
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code !== "EEXIST") throw error;

      const existing = readDataDirectoryLock(config.dataDir);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(
          `The data directory is already locked by another TexLite instance:\n` +
          `  - PID: ${existing.pid}\n` +
          `  - Config: ${existing.configPath}\n` +
          `  - Address: http://${existing.host}:${existing.port}\n` +
          `  - Started: ${existing.startedAt}\n` +
          `  - Data directory: ${config.dataDir}\n` +
          `Do not run multiple TexLite instances with the same data directory.`
        );
      }

      // An empty lock directory is normally another process between mkdir and
      // its atomic owner.json rename. Never remove a fresh one: doing so would
      // reintroduce the exact concurrent-start race this lock prevents.
      if (!existing) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs < 5_000) {
            throw new Error("The data directory lock is being initialized by another TexLite instance. Try again shortly.");
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.startsWith("The data directory lock is being initialized")) throw error;
        }
      }

      // Stale lock from a crashed process. The recursive removal also handles
      // the legacy regular-file lock used by pre-directory-lock releases.
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Ignore removal error and retry
      }
    }
  }

  throw new Error(`Unable to acquire the TexLite data directory lock: ${lockPath}`);
}
