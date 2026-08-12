import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CONFIG_DEFAULTS, loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { hashPassword } from "./security.js";
import { assertEnvironment } from "./environment.js";

async function initialize(): Promise<void> {
  const configPath = path.resolve(process.env.TEXLITE_CONFIG ?? "texlite.config.json");
  const interactive = Boolean(stdin.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    if (!fs.existsSync(configPath)) {
      const siteName = rl ? (await rl.question(`网站名称 [${CONFIG_DEFAULTS.siteName}]: `)).trim() || CONFIG_DEFAULTS.siteName : CONFIG_DEFAULTS.siteName;
      const adminEmail = rl ? (await rl.question("管理员联系邮箱（可留空）: ")).trim() : "";
      const configFile = {
        siteName,
        adminEmail,
        sessionDays: CONFIG_DEFAULTS.sessionDays,
        server: { host: CONFIG_DEFAULTS.host, port: CONFIG_DEFAULTS.port },
        storage: { dataDir: CONFIG_DEFAULTS.dataDir },
        uploads: { maxFileSizeMB: CONFIG_DEFAULTS.maxFileSizeMB },
        git: { binary: CONFIG_DEFAULTS.git, operationTimeoutSeconds: CONFIG_DEFAULTS.gitOperationTimeoutSeconds, githubApiBaseUrl: CONFIG_DEFAULTS.githubApiBaseUrl },
        latex: {
          latexmk: CONFIG_DEFAULTS.latexmk,
          defaultEngine: CONFIG_DEFAULTS.defaultEngine,
          allowedEngines: CONFIG_DEFAULTS.allowedEngines,
          extraArgs: CONFIG_DEFAULTS.extraArgs,
          allowProjectLatexmkrc: CONFIG_DEFAULTS.allowProjectLatexmkrc,
          compileTimeoutSeconds: CONFIG_DEFAULTS.compileTimeoutSeconds,
          maxCompileJobs: CONFIG_DEFAULTS.maxCompileJobs
        }
      };
      fs.writeFileSync(configPath, `${JSON.stringify(configFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      stdout.write(`已创建配置文件：${configPath}\n`);
    }

    const config = loadConfig();
    const environment = await assertEnvironment(config);
    stdout.write(`环境检查通过：${environment.map((item) => `${item.name} ${item.version}`).join("；")}\n`);
    const db = openDatabase(config);
    if (activeAdminCount(db) > 0) {
      throw new Error("系统中已经存在有效管理员；请在管理页面添加其他管理员");
    }
    const username = process.env.TEXLITE_INIT_USERNAME ?? (rl ? (await rl.question("管理员用户名 [admin]: ")).trim() || "admin" : "admin");
    const displayName = process.env.TEXLITE_INIT_DISPLAY_NAME ?? (rl ? (await rl.question("管理员显示名称 [Administrator]: ")).trim() || "Administrator" : "Administrator");
    const password = process.env.TEXLITE_INIT_PASSWORD ?? (rl ? await rl.question("管理员密码（至少 8 个字符，输入可见）: ") : "");
    if (!password) throw new Error("非交互初始化需要设置 TEXLITE_INIT_PASSWORD");
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, 'admin', 0, 0, 1, ?)`)
      .run(randomUUID(), username, displayName, await hashPassword(password), timestamp);
    db.close();
    stdout.write(`管理员 ${username} 已创建。数据目录：${config.dataDir}\n`);
  } finally {
    rl?.close();
  }
}

const command = process.argv[2];
if (command !== "init") {
  console.error("用法：texlite init");
  process.exitCode = 1;
} else {
  initialize().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
