import fs from "node:fs";
import path from "node:path";

export interface Config {
  configPath: string;
  siteName: string;
  adminEmail: string;
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  projectsDir: string;
  clientDir: string;
  sessionDays: number;
  compileTimeoutMs: number;
  maxCompileJobs: number;
  latexmk: string;
  defaultEngine: "pdflatex" | "xelatex" | "lualatex";
  allowedEngines: Array<"pdflatex" | "xelatex" | "lualatex">;
  extraArgs: string[];
  allowProjectLatexmkrc: boolean;
  maxUploadBytes: number;
  git: string;
  gitOperationTimeoutMs: number;
  githubApiBaseUrl: string;
}

export function loadConfig(): Config {
  const configPath = path.resolve(process.env.TEXLITE_CONFIG ?? "texlite.config.json");
  const fileConfig = readConfigFile(configPath);
  const configuredDataDir = process.env.TEXLITE_DATA_DIR ?? fileConfig.storage?.dataDir ?? ".texlite";
  const dataDir = path.resolve(path.dirname(configPath), configuredDataDir);
  const configuredEngine = process.env.TEXLITE_DEFAULT_ENGINE ?? fileConfig.latex?.defaultEngine;
  const defaultEngine = configuredEngine === "pdflatex" || configuredEngine === "lualatex"
    ? configuredEngine : "xelatex";
  const configuredAllowed = fileConfig.latex?.allowedEngines?.filter(isEngine) ?? [];
  const allowedEngines: Array<"pdflatex" | "xelatex" | "lualatex"> = configuredAllowed.length > 0
    ? configuredAllowed : ["pdflatex", "xelatex", "lualatex"];
  if (!allowedEngines.includes(defaultEngine)) allowedEngines.push(defaultEngine);
  return {
    configPath,
    siteName: process.env.TEXLITE_SITE_NAME ?? fileConfig.siteName ?? "TexLite",
    adminEmail: process.env.TEXLITE_ADMIN_EMAIL ?? fileConfig.adminEmail ?? "",
    host: process.env.TEXLITE_HOST ?? fileConfig.server?.host ?? "127.0.0.1",
    port: intFromValue(process.env.TEXLITE_PORT, fileConfig.server?.port, 3000),
    dataDir,
    databasePath: path.join(dataDir, "texlite.db"),
    projectsDir: path.join(dataDir, "projects"),
    clientDir: path.resolve(process.env.TEXLITE_CLIENT_DIR ?? "dist/client"),
    sessionDays: intFromValue(process.env.TEXLITE_SESSION_DAYS, fileConfig.sessionDays, 14),
    compileTimeoutMs: intFromValue(process.env.TEXLITE_COMPILE_TIMEOUT, fileConfig.latex?.compileTimeoutSeconds, 60) * 1000,
    maxCompileJobs: intFromValue(process.env.TEXLITE_MAX_COMPILE_JOBS, fileConfig.latex?.maxCompileJobs, 2),
    latexmk: process.env.TEXLITE_LATEXMK ?? fileConfig.latex?.latexmk ?? "latexmk",
    defaultEngine,
    allowedEngines,
    extraArgs: fileConfig.latex?.extraArgs?.filter((item): item is string => typeof item === "string") ?? [],
    allowProjectLatexmkrc: fileConfig.latex?.allowProjectLatexmkrc !== false,
    maxUploadBytes: intFromValue(process.env.TEXLITE_MAX_UPLOAD_SIZE_MB, fileConfig.uploads?.maxFileSizeMB, 50) * 1024 * 1024,
    git: process.env.TEXLITE_GIT ?? fileConfig.git?.binary ?? "git",
    gitOperationTimeoutMs: intFromValue(process.env.TEXLITE_GIT_TIMEOUT, fileConfig.git?.operationTimeoutSeconds, 30) * 1000,
    githubApiBaseUrl: (process.env.TEXLITE_GITHUB_API_URL ?? fileConfig.git?.githubApiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "")
  };
}

interface FileConfig {
  siteName?: string;
  adminEmail?: string;
  sessionDays?: number;
  server?: { host?: string; port?: number };
  storage?: { dataDir?: string };
  latex?: {
    latexmk?: string;
    defaultEngine?: string;
    compileTimeoutSeconds?: number;
    maxCompileJobs?: number;
    allowedEngines?: string[];
    extraArgs?: string[];
    allowProjectLatexmkrc?: boolean;
  };
  uploads?: { maxFileSizeMB?: number };
  git?: { binary?: string; operationTimeoutSeconds?: number; githubApiBaseUrl?: string };
}

function isEngine(value: string): value is "pdflatex" | "xelatex" | "lualatex" {
  return value === "pdflatex" || value === "xelatex" || value === "lualatex";
}

function readConfigFile(configPath: string): FileConfig {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as FileConfig;
  } catch (error) {
    throw new Error(`无法读取配置文件 ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function intFromValue(envValue: string | undefined, fileValue: number | undefined, fallback: number): number {
  const value = envValue === undefined ? fileValue : Number.parseInt(envValue, 10);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}
