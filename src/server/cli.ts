#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS, loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { hashPassword } from "./security.js";
import { assertEnvironment, assertGitAvailable } from "./environment.js";
import { serve } from "./index.js";
import { processStatus, restartManaged, startManaged, stopManaged, streamLogs, waitForOnline } from "./pm2.js";
import { defaultDataDirectory, resolveConfigPath } from "./runtimePaths.js";

export interface CliOptions {
  command: string;
  configPath?: string;
  checkGit: boolean;
}

const HELP = `TexLite ${packageVersion()}

Usage:
  texlite <command> [options]

Commands:
  init       Create the configuration, initialize storage, and create the first administrator.
  serve      Run the server in the foreground for debugging, Docker, or systemd.
  start      Start the server in the background under PM2.
  status     Show the status of the PM2-managed server.
  stop       Stop the PM2-managed server.
  restart    Restart (or start) the PM2-managed server.
  logs       Stream logs from the PM2-managed server.
  doctor     Validate configuration, paths, LaTeX, and the administrator.
  config     Print the effective configuration as JSON without changing it.
  help       Show this help message.
  version    Print the installed TexLite version.

Options:
  --config PATH  Use this configuration file instead of TEXLITE_CONFIG or the XDG default.
  --git          Make doctor check the optional Git integration as well.
  -h, --help     Show this help message.
  -v, --version  Print the installed TexLite version.
`;

export function parseArgs(args: string[]): CliOptions {
  let command = "help";
  let configPath: string | undefined;
  let checkGit = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "-h" || argument === "--help") return { command: "help", configPath, checkGit };
    if (argument === "-v" || argument === "--version") return { command: "version", configPath, checkGit };
    if (argument === "--git") { checkGit = true; continue; }
    if (argument === "--config") {
      const value = args[++index];
      if (!value) throw new Error("--config requires a configuration file path");
      configPath = value;
      continue;
    }
    if (argument.startsWith("--config=")) {
      const value = argument.slice("--config=".length);
      if (!value) throw new Error("--config requires a configuration file path");
      configPath = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (command !== "help") throw new Error(`Only one command may be specified (already received ${command})`);
    command = argument;
  }
  return { command, configPath, checkGit };
}

function output(message: string): void {
  stdout.write(`${message}\n`);
}

function configPathFor(options: CliOptions): string {
  return resolveConfigPath(options.configPath);
}

function writeInitialConfig(configPath: string, siteName: string, adminEmail: string): void {
  const dataDirectory = defaultDataDirectory();
  const configuredDataDirectory = process.env.TEXLITE_DATA_DIR?.trim();
  const effectiveDataDirectory = configuredDataDirectory
    ? path.resolve(path.dirname(configPath), configuredDataDirectory)
    : dataDirectory;
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // Data parents are not guaranteed to exist on a fresh account. Create only
  // the parent here; the configured data directory itself is created by
  // openDatabase after configuration validation.
  for (const parent of new Set([path.dirname(dataDirectory), path.dirname(effectiveDataDirectory)])) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(path.dirname(configPath), 0o700); } catch { /* Windows and restricted filesystems may not support chmod. */ }
  const configFile = {
    siteName,
    adminEmail,
    sessionDays: CONFIG_DEFAULTS.sessionDays,
    server: { host: CONFIG_DEFAULTS.host, port: CONFIG_DEFAULTS.port },
    storage: { dataDir: dataDirectory },
    uploads: { maxFileSizeMB: CONFIG_DEFAULTS.maxFileSizeMB },
    history: {
      maxVersions: CONFIG_DEFAULTS.historyMaxVersions,
      maxStorageMB: CONFIG_DEFAULTS.historyMaxStorageMB
    },
    git: {
      binary: CONFIG_DEFAULTS.git,
      operationTimeoutSeconds: CONFIG_DEFAULTS.gitOperationTimeoutSeconds,
      githubApiBaseUrl: CONFIG_DEFAULTS.githubApiBaseUrl
    },
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
  fs.writeFileSync(configPath, `${JSON.stringify(configFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(configPath, 0o600); } catch { /* Windows and restricted filesystems may not support chmod. */ }
}

async function initialize(options: CliOptions): Promise<void> {
  const configPath = configPathFor(options);
  const interactive = Boolean(stdin.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    if (!fs.existsSync(configPath)) {
      const siteName = rl
        ? (await rl.question(`Site name [${CONFIG_DEFAULTS.siteName}]: `)).trim() || CONFIG_DEFAULTS.siteName
        : CONFIG_DEFAULTS.siteName;
      const adminEmail = rl ? (await rl.question("Administrator contact email (optional): ")).trim() : "";
      writeInitialConfig(configPath, siteName, adminEmail);
      output(`Created configuration file: ${configPath}`);
    } else {
      output(`Using existing configuration file: ${configPath}`);
    }

    const config = loadConfig(configPath);
    const environment = await assertEnvironment(config);
    output(`Environment checks passed: ${environment.map((item) => `${item.name} ${item.version}`).join("; ")}`);
    db = openDatabase(config);
    if (activeAdminCount(db) > 0) {
      throw new Error("An active administrator already exists. Add additional administrators from the administration page.");
    }
    const username = process.env.TEXLITE_INIT_USERNAME
      ?? (rl ? (await rl.question("Administrator username [admin]: ")).trim() || "admin" : "admin");
    const displayName = process.env.TEXLITE_INIT_DISPLAY_NAME
      ?? (rl ? (await rl.question("Administrator display name [Administrator]: ")).trim() || "Administrator" : "Administrator");
    const password = process.env.TEXLITE_INIT_PASSWORD
      ?? (rl ? await rl.question("Administrator password (at least 8 characters; input is visible): ") : "");
    if (!password) throw new Error("Non-interactive initialization requires TEXLITE_INIT_PASSWORD to be set.");
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, 'admin', 0, 0, 1, ?)`)
      .run(randomUUID(), username, displayName, await hashPassword(password), timestamp);
    output(`Administrator ${username} created. Configuration file: ${config.configPath}`);
    output(`Data directory: ${config.dataDir}`);
  } finally {
    db?.close();
    rl?.close();
  }
}

async function loadValidatedConfig(options: CliOptions) {
  const configPath = configPathFor(options);
  const config = loadConfig(configPath);
  return { config, configPath };
}

async function assertAdmin(config: Awaited<ReturnType<typeof loadValidatedConfig>>["config"]): Promise<void> {
  const db = openDatabase(config);
  try {
    if (activeAdminCount(db) === 0) throw new Error("No active administrator found. Run `texlite init` first; the server will not start.");
  } finally {
    db.close();
  }
}

async function doctor(options: CliOptions): Promise<void> {
  const { config, configPath } = await loadValidatedConfig(options);
  const environment = await assertEnvironment(config);
  await assertAdmin(config);
  output(`Configuration is valid: ${configPath}`);
  output(`Data directory: ${config.dataDir}`);
  output(`Client assets: ${config.clientDir}`);
  output(`Environment: ${environment.map((item) => `${item.name} ${item.version}`).join("; ")}`);
  if (options.checkGit) output(`Git: ${(await assertGitAvailable(config)).version}`);
  else output("Git: not checked (Git integration is optional; use --git to check it)");
}

async function printConfig(options: CliOptions): Promise<void> {
  const { config, configPath } = await loadValidatedConfig(options);
  output(JSON.stringify({
    configPath,
    siteName: config.siteName,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    projectsDir: config.projectsDir,
    clientDir: config.clientDir,
    sessionDays: config.sessionDays,
    compileTimeoutSeconds: config.compileTimeoutMs / 1000,
    maxCompileJobs: config.maxCompileJobs,
    latexmk: config.latexmk,
    defaultEngine: config.defaultEngine,
    allowedEngines: config.allowedEngines,
    maxUploadBytes: config.maxUploadBytes,
    historyMaxVersions: config.historyMaxVersions,
    historyMaxStorageBytes: config.historyMaxStorageBytes,
    git: config.git
  }, null, 2));
}

async function start(options: CliOptions, restart = false): Promise<void> {
  const { config, configPath } = await loadValidatedConfig(options);
  await assertEnvironment(config);
  await assertAdmin(config);
  restart ? await restartManaged(config) : await startManaged(config);
  const managed = await waitForOnline(config);
  const status = managed.description?.pm2_env?.status ?? "unknown";
  output(`TexLite ${status}: ${config.siteName}`);
  output(`Address: http://${config.host}:${config.port}`);
  output(`Configuration file: ${configPath}`);
  output(`PM2 process: ${managed.name}`);
}

async function status(options: CliOptions): Promise<void> {
  const { config } = await loadValidatedConfig(options);
  const result = await processStatus(config);
  output(JSON.stringify(result, null, 2));
  if (result.status !== "online") process.exitCode = 2;
}

async function stop(options: CliOptions): Promise<void> {
  const { config } = await loadValidatedConfig(options);
  const managed = await stopManaged(config.configPath);
  output(managed.description ? `TexLite stopped: ${managed.name}` : `TexLite is not running: ${managed.name}`);
}

async function run(options: CliOptions): Promise<void> {
  switch (options.command) {
    case "help": output(HELP); return;
    case "version": output(packageVersion()); return;
    case "init": await initialize(options); return;
    case "serve": await serve(configPathFor(options)); return;
    case "start": await start(options); return;
    case "restart": await start(options, true); return;
    case "status": await status(options); return;
    case "stop": await stop(options); return;
    case "doctor": await doctor(options); return;
    case "config": await printConfig(options); return;
    case "logs": {
      const { config } = await loadValidatedConfig(options);
      await streamLogs(config);
      return;
    }
    default: throw new Error(`Unknown command: ${options.command}\n\n${HELP}`);
  }
}

function packageVersion(): string {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch { return "unknown"; }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await run(parseArgs(argv));
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
