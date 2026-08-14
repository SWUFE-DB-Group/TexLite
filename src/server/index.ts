import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { buildApp } from "./app.js";
import { assertEnvironment } from "./environment.js";

export interface RunningServer {
  close: () => Promise<void>;
  address: string;
}

export async function startServer(configPath?: string): Promise<RunningServer> {
  const config = loadConfig(configPath);
  const environment = await assertEnvironment(config);
  const db = openDatabase(config);
  if (activeAdminCount(db) === 0) {
    db.close();
    throw new Error("没有有效管理员。请先运行 `texlite init`（源码部署可运行 `npm run init`），服务未启动。");
  }
  let app: FastifyInstance;
  try {
    app = await buildApp(config, db);
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    db.close();
    throw error;
  }
  app.log.info(`Environment ready: ${environment.map((item) => `${item.name} ${item.version}`).join(", ")}`);
  app.log.info(`${config.siteName} running at http://${config.host}:${config.port}`);
  return {
    address: `http://${config.host}:${config.port}`,
    close: async () => {
      try {
        await app.close();
      } finally {
        db.close();
      }
    }
  };
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
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
