import { loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { buildApp } from "./app.js";
import { assertEnvironment } from "./environment.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const environment = await assertEnvironment(config);
  const db = openDatabase(config);
  if (activeAdminCount(db) === 0) {
    db.close();
    throw new Error("没有有效管理员。请先运行 `npm run init`，服务未启动。");
  }
  const app = await buildApp(config, db);
  const shutdown = async (): Promise<void> => {
    await app.close();
    db.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Environment ready: ${environment.map((item) => `${item.name} ${item.version}`).join(", ")}`);
  app.log.info(`${config.siteName} running at http://${config.host}:${config.port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
