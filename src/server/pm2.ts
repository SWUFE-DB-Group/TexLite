import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
  pm2Status: string;
  healthy: boolean;
  pid: number | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
  restarts: number;
  version: string;
  address: string;
  dataDir: string;
  cwd: string;
  outputLog: string | null;
  errorLog: string | null;
}

interface HealthProbe {
  ok: boolean;
  pid: number | null;
  error: string | null;
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
  // Reserve the short conventional name for the standard fallback path only.
  // If XDG_CONFIG_HOME points elsewhere, the absolute path must participate in
  // the name or every isolated/test installation would collide on `texlite`.
  if (absoluteConfigPath === defaultConfigPath({})) return "texlite";
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
    wait_ready: true,
    listen_timeout: 45_000,
    min_uptime: 10_000,
    max_restarts: 5,
    restart_delay: 500,
    max_memory_restart: "512M",
    kill_timeout: 10_000,
    env: environment
  };
}

function launch(config: Config): Promise<ProcessDescription> {
  return callback<ProcessDescription>((done) => {
    pm2Client!.start(startOptions(config), (error, process) => done(error ?? null, process));
  });
}

async function replaceProcess(existing: ProcessDescription, config: Config): Promise<ProcessDescription> {
  await callback<void>((done) => pm2Client!.delete(processId(existing), (error) => done(error ?? null)));
  const started = await launch(config);
  return Array.isArray(started) ? started[0]! : started;
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
      if (status === "launching") return { name, configPath: config.configPath, description: existing };
      if (status === "online") {
        const probe = await probeService(config);
        if (probe.ok && probe.pid === existing.pid) {
          return { name, configPath: config.configPath, description: existing };
        }
      }
      const refreshed = await replaceProcess(existing, config);
      return { name, configPath: config.configPath, description: refreshed };
    }
    const started = await launch(config);
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
      const started = await launch(config);
      return { name, configPath: config.configPath, description: Array.isArray(started) ? started[0] : started };
    }
    const description = await replaceProcess(existing, config);
    return { name, configPath: config.configPath, description };
  } finally {
    disconnect();
  }
}

export async function processStatus(config: Config): Promise<ProcessStatus> {
  const managed = await managedProcess(config.configPath);
  const description = managed.description;
  const env = description ? description.pm2_env : undefined;
  const pm2Status = env?.status ?? "missing";
  const probe = pm2Status === "online" ? await probeService(config) : { ok: false, pid: null, error: null };
  const healthy = Boolean(description?.pid && probe.ok && probe.pid === description.pid);
  const active = pm2Status === "online" || pm2Status === "launching";
  const startedAt = active && typeof env?.pm_uptime === "number" ? env.pm_uptime : null;
  return {
    name: managed.name,
    configPath: managed.configPath,
    status: pm2Status === "online" && !healthy ? "unhealthy" : pm2Status,
    pm2Status,
    healthy,
    pid: description?.pid ?? null,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    uptimeSeconds: startedAt === null ? null : Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    restarts: env?.restart_time ?? 0,
    version: packageVersion(),
    address: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    cwd: env?.pm_cwd ?? packageRootDirectory(),
    outputLog: env?.pm_out_log_path ?? null,
    errorLog: env?.pm_err_log_path ?? null
  };
}

/** Wait for both PM2 and the HTTP service. The health response PID prevents a
 * foreground `texlite serve` process on the same port from being mistaken for
 * the newly launched managed process. */
export async function waitForOnline(config: Config, timeoutMs = 50_000): Promise<ManagedProcess> {
  const deadline = Date.now() + timeoutMs;
  let latest = await managedProcess(config.configPath);
  let consecutiveHealthyChecks = 0;
  let healthyPid: number | null = null;
  let latestProbe: HealthProbe = { ok: false, pid: null, error: null };
  while (Date.now() < deadline) {
    const status = latest.description?.pm2_env?.status;
    if (status === "online") {
      latestProbe = await probeService(config);
      if (latestProbe.ok && latestProbe.pid === latest.description?.pid) {
        consecutiveHealthyChecks = healthyPid === latestProbe.pid ? consecutiveHealthyChecks + 1 : 1;
        healthyPid = latestProbe.pid;
        if (consecutiveHealthyChecks >= 2) return latest;
      } else {
        consecutiveHealthyChecks = 0;
        healthyPid = null;
      }
    } else {
      consecutiveHealthyChecks = 0;
      healthyPid = null;
    }
    if (status === "errored" || status === "stopped") {
      throw new Error(`PM2 could not start TexLite (current status: ${status}). Run texlite logs to inspect the logs.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await managedProcess(config.configPath);
  }
  const status = latest.description?.pm2_env?.status ?? "missing";
  const expectedPid = latest.description?.pid ?? "none";
  const probeDetail = latestProbe.pid !== null
    ? `health endpoint belongs to PID ${latestProbe.pid}, expected PM2 PID ${expectedPid}`
    : latestProbe.error ?? "health endpoint did not respond";
  throw new Error(`Timed out waiting for TexLite to become healthy at ${healthUrl(config)} (PM2 status: ${status}; ${probeDetail}). Run texlite logs to investigate.`);
}

function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

function healthUrl(config: Config): string {
  const host = probeHost(config.host);
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${config.port}/api/health`;
}

function probeService(config: Config, timeoutMs = 1_500): Promise<HealthProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthProbe) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.get(healthUrl(config), { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (Buffer.concat(chunks).length < 16 * 1024) chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          finish({ ok: false, pid: null, error: `health endpoint returned HTTP ${response.statusCode ?? "unknown"}` });
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: unknown; pid?: unknown };
          finish({
            ok: body.ok === true && Number.isInteger(body.pid),
            pid: Number.isInteger(body.pid) ? body.pid as number : null,
            error: body.ok === true && Number.isInteger(body.pid) ? null : "health endpoint returned an invalid response"
          });
        } catch {
          finish({ ok: false, pid: null, error: "health endpoint returned invalid JSON" });
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("health check timed out")));
    request.once("error", (error) => finish({ ok: false, pid: null, error: error.message }));
  });
}

export async function streamLogs(config: Config): Promise<void> {
  await connect();
  const managed = (await list()).find((process) => process.name === processName(config.configPath)
    && environmentOf(process).TEXLITE_CONFIG === path.resolve(config.configPath));
  if (!managed) {
    disconnect();
    throw new Error("TexLite is not currently managed by PM2. Run texlite start first.");
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
    throw new Error(`The PM2 name ${name} is already used by another configuration. Remove the old process or use a different configuration path and try again.`);
  }
}
