import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { buildApp } from "./app.js";
import { assertEnvironment } from "./environment.js";
import { acquireDataDirectoryLock } from "./instanceLock.js";

export interface RunningServer {
  close: () => Promise<void>;
  address: string;
}

export async function startServer(configPath?: string): Promise<RunningServer> {
  const config = loadConfig(configPath);
  const lock = acquireDataDirectoryLock(config);
  let db: ReturnType<typeof openDatabase> | null = null;
  let app: FastifyInstance | null = null;
  try {
    const environment = await assertEnvironment(config);
    db = openDatabase(config);
    if (activeAdminCount(db) === 0) {
      throw new Error("No active administrator found. Run `texlite init` first (or `npm run init` from a source checkout); the server will not start.");
    }
    app = await buildApp(config, db);
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Environment ready: ${environment.map((item) => `${item.name} ${item.version}`).join(", ")}`);
    app.log.info(`${config.siteName} running at http://${config.host}:${config.port}`);
    if (typeof process.send === "function") process.send("ready");
    return {
      address: `http://${config.host}:${config.port}`,
      close: async () => {
        try {
          if (app) await app.close();
        } finally {
          try {
            db?.close();
          } finally {
            lock.release();
          }
        }
      }
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
}

export async function serve(configPath?: string): Promise<void> {
  const running = await startServer(configPath);
  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await running.close();
  };
  await new Promise<void>((resolve) => {
    const complete = () => { void shutdown().finally(resolve); };
    process.once("SIGINT", complete);
    process.once("SIGTERM", complete);
  });
}

export async function main(): Promise<void> {
  await serve();
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
