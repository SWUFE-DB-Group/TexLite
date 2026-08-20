import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export const LOCK_FILE_NAME = ".texlite.lock";

export interface DataDirectoryLockInfo {
  pid: number;
  startedAt: string;
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
  try {
    if (!fs.existsSync(lockPath)) return null;
    const content = fs.readFileSync(lockPath, "utf8");
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
    configPath: config.configPath,
    host: config.host,
    port: config.port
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(lockInfo, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (fs.existsSync(lockPath)) {
            const current = readDataDirectoryLock(config.dataDir);
            if (current?.pid === process.pid) {
              fs.rmSync(lockPath, { force: true });
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
          `数据目录已被另一个 TexLite 实例独占锁定：\n` +
          `  - 运行 PID: ${existing.pid}\n` +
          `  - 配置路径: ${existing.configPath}\n` +
          `  - 监听地址: http://${existing.host}:${existing.port}\n` +
          `  - 启动时间: ${existing.startedAt}\n` +
          `  - 数据目录: ${config.dataDir}\n` +
          `请勿在同一数据目录下同时运行多个 TexLite 实例。`
        );
      }

      // Stale lock from crashed process
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Ignore removal error and retry
      }
    }
  }

  throw new Error(`无法获取数据目录排他锁: ${lockPath}`);
}
