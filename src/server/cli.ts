#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS, loadConfig } from "./config.js";
import { activeAdminCount, openDatabase } from "./db.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./security.js";
import { assertEnvironment, hostRequirementsSatisfied, inspectHostEnvironment, inspectHostRequirements, type EnvironmentTool } from "./environment.js";
import { serve } from "./index.js";
import { processStatus, restartManaged, startManaged, stopManaged, streamLogs, waitForOnline, type ProcessStatus } from "./pm2.js";
import { defaultDataDirectory, resolveConfigPath } from "./runtimePaths.js";

export interface CliOptions {
  command: string;
  configPath?: string;
  json: boolean;
}

export interface DoctorApplicationCheck {
  name: string;
  status: "passed" | "failed";
  detail: string;
}

export interface DoctorReport {
  configPath: string;
  dataDir: string;
  clientDir: string;
  application: DoctorApplicationCheck[];
  hostTools: EnvironmentTool[];
  ok: boolean;
}

export interface RequirementsReport {
  hostTools: EnvironmentTool[];
  ok: boolean;
}

const HELP = `TexLite ${packageVersion()}

Usage:
  texlite <command> [options]

Commands:
  init          Create the configuration, initialize storage, and create the first administrator.
  serve         Run the server in the foreground for debugging, Docker, or systemd.
  start         Start the server in the background under PM2.
  status        Show the status of the PM2-managed server.
  stop          Stop the PM2-managed server.
  restart       Restart (or start) the PM2-managed server.
  logs          Stream logs from the PM2-managed server.
  doctor        Check configuration, application state, and host dependencies.
  requirements  Check host software on PATH without loading TexLite configuration.
  config        Print the effective configuration as JSON without changing it.
  help          Show this help message.
  version       Print the installed TexLite version.

Options:
  --config PATH  Use this configuration file instead of TEXLITE_CONFIG or the XDG default.
                 Requirements does not accept this option.
  --json         Print status, doctor, or requirements results as JSON for scripts.
  -h, --help     Show this help message.
  -v, --version  Print the installed TexLite version.
`;

export function parseArgs(args: string[]): CliOptions {
  let command = "help";
  let configPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "-h" || argument === "--help") return { command: "help", configPath, json };
    if (argument === "-v" || argument === "--version") return { command: "version", configPath, json };
    if (argument === "--json") { json = true; continue; }
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
  if (command === "requirements" && configPath) {
    throw new Error("`texlite requirements` does not use --config.");
  }
  return { command, configPath, json };
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
    pdf: {
      loadingStrategy: CONFIG_DEFAULTS.pdfLoadingStrategy,
      rangeThresholdMB: CONFIG_DEFAULTS.pdfRangeThresholdMB
    },
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
      const configuredSiteName = process.env.TEXLITE_SITE_NAME;
      const siteName = configuredSiteName !== undefined
        ? configuredSiteName.trim() || CONFIG_DEFAULTS.siteName
        : rl
          ? (await rl.question(`Site name [${CONFIG_DEFAULTS.siteName}]: `)).trim() || CONFIG_DEFAULTS.siteName
          : CONFIG_DEFAULTS.siteName;
      const configuredAdminEmail = process.env.TEXLITE_ADMIN_EMAIL;
      const adminEmail = configuredAdminEmail !== undefined
        ? configuredAdminEmail.trim()
        : rl
          ? (await rl.question("Administrator contact email (optional): ")).trim()
          : "";
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
      ?? (rl ? await rl.question(`Administrator password (at least ${MIN_PASSWORD_LENGTH} characters; input is visible): `) : "");
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
  const application = inspectDoctorApplication(config, configPath);
  const hostTools = await inspectHostEnvironment(config);
  const report: DoctorReport = {
    configPath,
    dataDir: config.dataDir,
    clientDir: config.clientDir,
    application,
    hostTools,
    ok: application.every((check) => check.status === "passed")
      && hostRequirementsSatisfied(hostTools)
  };
  output(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report, terminalColorsEnabled()));
  if (!report.ok) process.exitCode = 2;
}

async function requirements(options: CliOptions): Promise<void> {
  const hostTools = await inspectHostRequirements();
  const report: RequirementsReport = { hostTools, ok: hostRequirementsSatisfied(hostTools) };
  output(options.json ? JSON.stringify(report, null, 2) : formatRequirementsReport(report, terminalColorsEnabled()));
  if (!report.ok) process.exitCode = 2;
}

function inspectDoctorApplication(config: Awaited<ReturnType<typeof loadValidatedConfig>>["config"], configPath: string): DoctorApplicationCheck[] {
  const checks: DoctorApplicationCheck[] = [
    { name: "Configuration", status: "passed", detail: `Valid: ${configPath}` },
    inspectClientAssets(config)
  ];
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(config);
    checks.push({ name: "Data and database", status: "passed", detail: `Opened: ${config.databasePath}` });
    const administrators = activeAdminCount(db);
    checks.push(administrators > 0
      ? { name: "Administrator", status: "passed", detail: `${administrators} active administrator${administrators === 1 ? "" : "s"}` }
      : { name: "Administrator", status: "failed", detail: "No active administrator. Run `texlite init`." });
  } catch (error) {
    const detail = errorMessage(error);
    checks.push({ name: "Data and database", status: "failed", detail });
    checks.push({ name: "Administrator", status: "failed", detail: "Could not inspect because the database is unavailable." });
  } finally {
    db?.close();
  }
  return checks;
}

function inspectClientAssets(config: Awaited<ReturnType<typeof loadValidatedConfig>>["config"]): DoctorApplicationCheck {
  const entry = path.join(config.clientDir, "index.html");
  try {
    const stat = fs.statSync(entry);
    if (stat.isFile()) return { name: "Client assets", status: "passed", detail: `Found: ${entry}` };
  } catch { /* Report a concise diagnostic below. */ }
  return { name: "Client assets", status: "failed", detail: `Missing ${entry}; run \`npm run build\` or reinstall TexLite.` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : String(error).slice(0, 240);
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
    pdfLoadingStrategy: config.pdfLoadingStrategy,
    pdfRangeThresholdMB: config.pdfRangeThresholdBytes / (1024 * 1024),
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
  output(options.json ? JSON.stringify(result, null, 2) : formatProcessStatus(result, terminalColorsEnabled()));
  if (result.status !== "online") process.exitCode = 2;
}

const ANSI = {
  bold: "\u001b[1m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
  reset: "\u001b[0m"
} as const;

function terminalColorsEnabled(): boolean {
  if (Object.hasOwn(process.env, "NO_COLOR")) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stdout.isTTY);
}

function colorize(value: string, color: keyof Pick<typeof ANSI, "green" | "yellow" | "red" | "gray">, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

interface DoctorTableCell {
  text: string;
  color?: keyof Pick<typeof ANSI, "green" | "yellow" | "red" | "gray">;
}

export function formatDoctorReport(report: DoctorReport, colors = false): string {
  const titleColor = report.ok ? "green" : "red";
  const title = report.ok ? "all required checks passed" : "required checks need attention";
  const applicationRows: DoctorTableCell[][] = report.application.map((check) => [
    { text: check.name },
    { text: "Required" },
    { text: check.status === "passed" ? "Passed" : "Failed", color: check.status === "passed" ? "green" : "red" },
    { text: shortenDoctorCell(check.detail, 68) }
  ]);
  return [
    `${colorize("●", titleColor, colors)} ${colors ? `${ANSI.bold}TexLite doctor${ANSI.reset}` : "TexLite doctor"} — ${colorize(title, titleColor, colors)}`,
    `     Config: ${report.configPath}`,
    `       Data: ${report.dataDir}`,
    `     Client: ${report.clientDir}`,
    "",
    "Application checks",
    formatDoctorTable(["Check", "Need", "Status", "Details"], applicationRows, colors),
    "",
    "Host software",
    formatHostSoftwareTable(report.hostTools, colors),
    "",
    hostRequirementNote(report.hostTools, "start TexLite"),
    "Harper CLI is used by TexLite; harper-ls is reported for host diagnostics and external editor integrations."
  ].join("\n");
}

export function formatRequirementsReport(report: RequirementsReport, colors = false): string {
  const titleColor = report.ok ? "green" : "red";
  const title = report.ok ? "all host requirements passed" : "host requirements need attention";
  return [
    `${colorize("●", titleColor, colors)} ${colors ? `${ANSI.bold}TexLite requirements${ANSI.reset}` : "TexLite requirements"} — ${colorize(title, titleColor, colors)}`,
    "",
    "Host software (default commands on PATH)",
    formatHostSoftwareTable(report.hostTools, colors),
    "",
    hostRequirementNote(report.hostTools, "compile with TexLite"),
    "This command does not read a TexLite configuration, data directory, database, or administrator state.",
    "Harper CLI is used by TexLite; harper-ls is reported for host diagnostics and external editor integrations."
  ].join("\n");
}

function formatHostSoftwareTable(hostTools: EnvironmentTool[], colors: boolean): string {
  const hostRows: DoctorTableCell[][] = hostTools.map((tool) => [
    { text: shortenDoctorCell(tool.command === tool.name ? tool.name : `${tool.name} (${tool.command})`, 32) },
    { text: requirementLabel(tool.requirement) },
    hostToolStatusCell(tool),
    { text: shortenDoctorCell(tool.version ?? tool.detail ?? "—", 56) }
  ]);
  return formatDoctorTable(["Tool / command", "Need", "Status", "Version / diagnostic"], hostRows, colors);
}

function requirementLabel(requirement: EnvironmentTool["requirement"]): string {
  if (requirement === "required") return "Required";
  if (requirement === "one-of") return "One of";
  return "Optional";
}

function hostRequirementNote(hostTools: EnvironmentTool[], action: string): string {
  const oneOf = hostTools.some((tool) => tool.requirement === "one-of");
  return oneOf
    ? `Required tools and at least one tool in every “One of” group must be installed to ${action}. Optional tools enable their named feature without blocking the editor.`
    : `Required tools must be installed to ${action}. Optional tools enable their named feature without blocking the editor.`;
}

function hostToolStatusCell(tool: EnvironmentTool): DoctorTableCell {
  if (tool.status === "installed") return { text: "Installed", color: "green" };
  if (tool.status === "missing") {
    return { text: tool.requirement === "required" ? "Missing" : "Not installed", color: tool.requirement === "required" ? "red" : "yellow" };
  }
  return { text: "Failed", color: "red" };
}

function shortenDoctorCell(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…` : normalized;
}

function formatDoctorTable(headers: string[], rows: DoctorTableCell[][], colors: boolean): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.text.length ?? 0)));
  const line = (left: string, middle: string, right: string, fill: string) => `${left}${widths.map((width) => fill.repeat(width + 2)).join(middle)}${right}`;
  const renderRow = (cells: DoctorTableCell[]) => `│${cells.map((cell, index) => {
    const padded = (cell?.text ?? "").padEnd(widths[index] ?? 0);
    return ` ${cell?.color ? colorize(padded, cell.color, colors) : padded} `;
  }).join("│")}│`;
  return [
    line("┌", "┬", "┐", "─"),
    renderRow(headers.map((text) => ({ text }))),
    line("├", "┼", "┤", "─"),
    ...rows.map(renderRow),
    line("└", "┴", "┘", "─")
  ].join("\n");
}

function duration(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return `${minutes}min ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}min`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function statusAppearance(status: string): {
  color: "green" | "yellow" | "red" | "gray";
  active: string;
  health: string;
} {
  switch (status) {
    case "online": return { color: "green", active: "active (running)", health: "healthy" };
    case "unhealthy": return { color: "red", active: "failed (unhealthy)", health: "unhealthy" };
    case "errored": return { color: "red", active: "failed (errored)", health: "unhealthy" };
    case "launching": return { color: "yellow", active: "activating (starting)", health: "starting" };
    case "stopped": return { color: "yellow", active: "inactive (stopped)", health: "not running" };
    case "missing": return { color: "gray", active: "inactive (not managed)", health: "not running" };
    default: return { color: "yellow", active: status, health: "unknown" };
  }
}

export function formatProcessStatus(status: ProcessStatus, colors = false): string {
  const appearance = statusAppearance(status.status);
  const bullet = colorize("●", appearance.color, colors);
  const title = colors ? `${ANSI.bold}TexLite${ANSI.reset}` : "TexLite";
  const active = colorize(appearance.active, appearance.color, colors);
  const health = colorize(appearance.health, appearance.color, colors);
  const loaded = status.pm2Status === "missing"
    ? colorize(`not-found (PM2 process: ${status.name})`, "gray", colors)
    : `loaded (PM2 process: ${status.name})`;
  const since = status.startedAt && status.uptimeSeconds !== null
    ? ` since ${status.startedAt}; ${duration(status.uptimeSeconds)} ago`
    : "";
  return [
    `${bullet} ${title} - Lightweight collaborative LaTeX editor`,
    `     Loaded: ${loaded}`,
    `     Active: ${active}${since}`,
    `     Health: ${health} (PM2: ${status.pm2Status})`,
    `   Main PID: ${status.pid ?? "n/a"}`,
    `    Version: ${status.version}`,
    `   Restarts: ${status.restarts}`,
    `     Listen: ${status.address}`,
    `     Config: ${status.configPath}`,
    `       Data: ${status.dataDir}`,
    `        CWD: ${status.cwd}`,
    `     Stdout: ${status.outputLog ?? "n/a"}`,
    `     Stderr: ${status.errorLog ?? "n/a"}`
  ].join("\n");
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
    case "requirements": await requirements(options); return;
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
