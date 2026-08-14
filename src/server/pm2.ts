import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProcessDescription, StartOptions } from "pm2";
import type { Config } from "./config.js";
import { defaultConfigPath, packageRootDirectory, packageServerEntry } from "./runtimePaths.js";

export interface ManagedProcess {
  name: string;
  configPath: string;
  description: ProcessDescription | null;
}

export interface ProcessStatus {
  name: string;
  configPath: string;
  status: string;
  pid: number | null;
  uptime: number | null;
  restarts: number;
  version: string;
  address: string;
  dataDir: string;
  cwd: string;
  outputLog: string | null;
  errorLog: string | null;
}

type Pm2Api = typeof import("pm2");
let pm2Client: Pm2Api | null = null;

async function loadPm2(): Promise<Pm2Api> {
  if (pm2Client) return pm2Client;
  const module = await import("pm2");
  pm2Client = (module.default ?? module) as unknown as Pm2Api;
  return pm2Client;
}

function callback<T>(operation: (done: (error: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    operation((error, value) => error ? reject(error) : resolve(value as T));
  });
}

async function connect(): Promise<void> {
  const client = await loadPm2();
  await callback<void>((done) => client.connect((error) => done(error ?? null)));
}

function disconnect(): void {
  try { pm2Client?.disconnect(); } catch { /* PM2 may already have disconnected after a daemon error. */ }
}

function list(): Promise<ProcessDescription[]> {
  if (!pm2Client) return Promise.reject(new Error("PM2 is not connected"));
  return callback<ProcessDescription[]>((done) => pm2Client!.list((error, processes) => done(error ?? null, processes)));
}

function processId(process: ProcessDescription): string | number {
  return process.pm_id ?? process.name ?? "";
}

function environmentOf(process: ProcessDescription): Record<string, unknown> {
  const value = process.pm2_env as unknown as { env?: unknown } | undefined;
  return value?.env && typeof value.env === "object" ? value.env as Record<string, unknown> : {};
}

export function processName(configPath: string): string {
  const absoluteConfigPath = path.resolve(configPath);
  if (absoluteConfigPath === defaultConfigPath()) return "texlite";
  const digest = crypto.createHash("sha256").update(absoluteConfigPath).digest("hex").slice(0, 8);
  return `texlite-${digest}`;
}

export async function managedProcess(configPath: string): Promise<ManagedProcess> {
  const absoluteConfigPath = path.resolve(configPath);
  const name = processName(absoluteConfigPath);
  await connect();
  try {
    const processes = await list();
    assertNameAvailable(processes, name, absoluteConfigPath);
    const description = processes.find((process) => process.name === name
      && environmentOf(process).TEXLITE_CONFIG === absoluteConfigPath) ?? null;
    return { name, configPath: absoluteConfigPath, description };
  } finally {
    disconnect();
  }
}

function startOptions(config: Config): StartOptions {
  const packageRoot = packageRootDirectory();
  const script = packageServerEntry();
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    NODE_ENV: "production",
    TEXLITE_CONFIG: path.resolve(config.configPath),
    TEXLITE_CLIENT_DIR: path.resolve(config.clientDir)
  };
  return {
    name: processName(config.configPath),
    script,
    cwd: packageRoot,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    kill_timeout: 10_000,
    env: environment
  };
}

export async function startManaged(config: Config): Promise<ManagedProcess> {
  await connect();
  try {
    const name = processName(config.configPath);
    const absoluteConfigPath = path.resolve(config.configPath);
    const processes = await list();
    assertNameAvailable(processes, name, absoluteConfigPath);
    const existing = processes.find((process) => process.name === name
      && environmentOf(process).TEXLITE_CONFIG === absoluteConfigPath);
    if (existing) {
      const status = existing.pm2_env?.status;
      if (status === "online" || status === "launching") return { name, configPath: config.configPath, description: existing };
      await callback<void>((done) => pm2Client!.restart(processId(existing), (error) => done(error ?? null)));
      const refreshed = (await list()).find((process) => process.name === name) ?? existing;
      return { name, configPath: config.configPath, description: refreshed };
    }
    const started = await callback<ProcessDescription>((done) => pm2Client!.start(startOptions(config), (error, process) => done(error ?? null, process)));
    const description = Array.isArray(started) ? started[0] : started;
    return { name, configPath: config.configPath, description };
  } finally {
    disconnect();
  }
}

export async function stopManaged(configPath: string): Promise<ManagedProcess> {
  await connect();
  try {
    const name = processName(configPath);
    const absoluteConfigPath = path.resolve(configPath);
    const processes = await list();
    assertNameAvailable(processes, name, absoluteConfigPath);
    const existing = processes.find((process) => process.name === name
      && environmentOf(process).TEXLITE_CONFIG === absoluteConfigPath);
    if (existing && existing.pm2_env?.status !== "stopped") {
      await callback<void>((done) => pm2Client!.stop(processId(existing), (error) => done(error ?? null)));
    }
    const description = (await list()).find((process) => process.name === name
      && environmentOf(process).TEXLITE_CONFIG === absoluteConfigPath) ?? existing ?? null;
    return { name, configPath: absoluteConfigPath, description };
  } finally {
    disconnect();
  }
}

export async function restartManaged(config: Config): Promise<ManagedProcess> {
  await connect();
  try {
    const name = processName(config.configPath);
    const absoluteConfigPath = path.resolve(config.configPath);
    const processes = await list();
    assertNameAvailable(processes, name, absoluteConfigPath);
    const existing = processes.find((process) => process.name === name
      && environmentOf(process).TEXLITE_CONFIG === absoluteConfigPath);
    if (!existing) {
      const started = await callback<ProcessDescription>((done) => pm2Client!.start(startOptions(config), (error, process) => done(error ?? null, process)));
      return { name, configPath: config.configPath, description: Array.isArray(started) ? started[0] : started };
    }
    await callback<void>((done) => pm2Client!.restart(processId(existing), (error) => done(error ?? null)));
    const description = (await list()).find((process) => process.name === name) ?? existing;
    return { name, configPath: config.configPath, description };
  } finally {
    disconnect();
  }
}

export async function processStatus(config: Config): Promise<ProcessStatus> {
  const managed = await managedProcess(config.configPath);
  const description = managed.description;
  const env = description ? description.pm2_env : undefined;
  return {
    name: managed.name,
    configPath: managed.configPath,
    status: env?.status ?? "missing",
    pid: description?.pid ?? null,
    uptime: env?.pm_uptime ?? null,
    restarts: env?.restart_time ?? 0,
    version: packageVersion(),
    address: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    cwd: env?.pm_cwd ?? packageRootDirectory(),
    outputLog: env?.pm_out_log_path ?? null,
    errorLog: env?.pm_err_log_path ?? null
  };
}

/** Wait until PM2 has actually launched the service, rather than reporting
 * success while it is still in the `launching` state. */
export async function waitForOnline(config: Config, timeoutMs = 15_000): Promise<ManagedProcess> {
  const deadline = Date.now() + timeoutMs;
  let latest = await managedProcess(config.configPath);
  while (Date.now() < deadline) {
    const status = latest.description?.pm2_env?.status;
    if (status === "online") return latest;
    if (status === "errored" || status === "stopped") {
      throw new Error(`PM2 未能启动 TexLite（当前状态：${status}）。请运行 texlite logs 查看日志。`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    latest = await managedProcess(config.configPath);
  }
  const status = latest.description?.pm2_env?.status ?? "missing";
  throw new Error(`等待 TexLite 启动超时（当前状态：${status}）。请运行 texlite status 或 texlite logs 检查。`);
}

export async function streamLogs(config: Config): Promise<void> {
  await connect();
  const managed = (await list()).find((process) => process.name === processName(config.configPath)
    && environmentOf(process).TEXLITE_CONFIG === path.resolve(config.configPath));
  if (!managed) {
    disconnect();
    throw new Error("TexLite 当前没有由 PM2 管理的进程。请先运行 texlite start。");
  }
  const bus = await callback<{ on: (event: string, listener: (packet: unknown) => void) => void }>((done) => {
    pm2Client!.launchBus((error, value) => done(error ?? null, value as never));
  });
  const print = (packet: unknown, error: boolean) => {
    if (!packet || typeof packet !== "object") return;
    const value = packet as { process?: { name?: string }; data?: unknown };
    if (value.process?.name !== managed.name) return;
    const data = typeof value.data === "string" ? value.data : JSON.stringify(value.data);
    process.stdout.write(`${error ? "[error] " : ""}${data}\n`);
  };
  bus.on("log:out", (packet) => print(packet, false));
  bus.on("log:err", (packet) => print(packet, true));
  await new Promise<void>((resolve) => {
    const finish = () => { disconnect(); resolve(); };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function packageVersion(): string {
  try {
    const packageJson = requirePackageJson();
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch { return "unknown"; }
}

function requirePackageJson(): { version?: unknown } {
  const packagePath = path.join(packageRootDirectory(), "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
}

function assertNameAvailable(processes: ProcessDescription[], name: string, configPath: string): void {
  const collision = processes.find((process) => process.name === name
    && environmentOf(process).TEXLITE_CONFIG !== configPath);
  if (collision) {
    throw new Error(`PM2 名称 ${name} 已被另一个配置占用；请删除旧进程或使用不同的配置路径后重试。`);
  }
}
