import { spawn } from "node:child_process";
import { LATEX_ENGINES, type Config } from "./config.js";
import { httpError } from "./http.js";
import { detachedProcessGroup, killProcessGroup } from "./processTree.js";

export const MIN_NODE_MAJOR = 24;

export interface EnvironmentCommand {
  name: string;
  command: string;
  version: string;
}

export type EnvironmentRequirement = "required" | "one-of" | "optional";
export type EnvironmentToolStatus = "installed" | "missing" | "failed";

/** A host-tool probe used by `texlite doctor`. */
export interface EnvironmentTool {
  id: string;
  name: string;
  command: string;
  requirement: EnvironmentRequirement;
  requirementGroup?: string;
  purpose: string;
  status: EnvironmentToolStatus;
  version: string | null;
  detail: string | null;
}

interface EnvironmentToolDefinition {
  id: string;
  name: string;
  command: string;
  requirement: EnvironmentRequirement;
  requirementGroup?: string;
  purpose: string;
  versionArgs?: string[];
  timeoutMs?: number;
}

interface CommandProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  errorCode: string | null;
}

const commandProbeTimeoutMs = 10_000;
const maxCommandOutputBytes = 64 * 1024;

/**
 * Probe all tools that are relevant to a TexLite host. Optional tools are
 * included deliberately: their absence must be visible in `doctor`, but does
 * not prevent TexLite from starting.
 */
export async function inspectHostEnvironment(config: Config): Promise<EnvironmentTool[]> {
  return Promise.all(hostToolDefinitions(config).map((tool) => inspectTool(tool)));
}

/**
 * Probe the default commands on PATH without loading a TexLite configuration.
 * This supports pre-installation checks through `texlite requirements`.
 */
export async function inspectHostRequirements(): Promise<EnvironmentTool[]> {
  return Promise.all(hostRequirementToolDefinitions().map((tool) => inspectTool(tool)));
}

export function hostRequirementsSatisfied(tools: EnvironmentTool[]): boolean {
  if (tools.some((tool) => tool.requirement === "required" && tool.status !== "installed")) return false;
  const oneOfGroups = new Map<string, EnvironmentTool[]>();
  for (const tool of tools) {
    if (tool.requirement !== "one-of") continue;
    const group = tool.requirementGroup ?? tool.id;
    const members = oneOfGroups.get(group) ?? [];
    members.push(tool);
    oneOfGroups.set(group, members);
  }
  return [...oneOfGroups.values()].every((members) => members.some((tool) => tool.status === "installed"));
}

export async function assertEnvironment(config: Config): Promise<EnvironmentCommand[]> {
  const tools = await Promise.all(requiredToolDefinitions(config).map((tool) => inspectTool(tool)));
  const unavailable = tools.find((tool) => tool.status !== "installed");
  if (unavailable) {
    const detail = unavailable.detail ?? "unknown error";
    throw new Error(`Environment check failed: could not run the ${unavailable.name} command "${unavailable.command}" (${detail}). Initialization/startup has been stopped.`);
  }
  return tools.map(({ name, command, version }) => ({ name, command, version: version ?? "available" }));
}

export async function assertGitAvailable(config: Config): Promise<EnvironmentCommand> {
  const tool = await inspectTool(gitToolDefinition(config.git, Math.min(config.gitOperationTimeoutMs, commandProbeTimeoutMs)));
  if (tool.status !== "installed") throw httpError(503, "GIT_UNAVAILABLE");
  return { name: tool.name, command: tool.command, version: tool.version ?? "available" };
}

function requiredToolDefinitions(config: Config): EnvironmentToolDefinition[] {
  return [
    { id: "node", name: `Node.js ${MIN_NODE_MAJOR}+`, command: "node", requirement: "required", purpose: "TexLite runtime" },
    { id: "latexmk", name: "latexmk", command: config.latexmk, requirement: "required", purpose: "LaTeX compilation" },
    ...config.allowedEngines.map((command) => ({
      id: `engine:${command}`, name: command, command, requirement: "required" as const,
      purpose: "Configured LaTeX engine"
    }))
  ];
}

function hostToolDefinitions(config: Config): EnvironmentToolDefinition[] {
  return [
    ...requiredToolDefinitions(config),
    ...optionalToolDefinitions(config.git, Math.min(config.gitOperationTimeoutMs, commandProbeTimeoutMs))
  ];
}

function hostRequirementToolDefinitions(): EnvironmentToolDefinition[] {
  return [
    { id: "node", name: `Node.js ${MIN_NODE_MAJOR}+`, command: "node", requirement: "required", purpose: "TexLite runtime" },
    { id: "latexmk", name: "latexmk", command: "latexmk", requirement: "required", purpose: "LaTeX compilation" },
    ...LATEX_ENGINES.map((command) => ({
      id: `engine:${command}`, name: command, command, requirement: "one-of" as const,
      requirementGroup: "latex-engine", purpose: "Supported LaTeX engine"
    })),
    ...optionalToolDefinitions("git", commandProbeTimeoutMs)
  ];
}

function optionalToolDefinitions(gitCommand: string, gitTimeoutMs: number): EnvironmentToolDefinition[] {
  return [
    gitToolDefinition(gitCommand, gitTimeoutMs),
    { id: "texcount", name: "TeXcount", command: "texcount", requirement: "optional", purpose: "Word and character statistics", versionArgs: ["-version"] },
    { id: "bibtex", name: "BibTeX", command: "bibtex", requirement: "optional", purpose: "BibTeX bibliography builds" },
    { id: "biber", name: "Biber", command: "biber", requirement: "optional", purpose: "Biber bibliography builds" },
    { id: "makeindex", name: "MakeIndex", command: "makeindex", requirement: "optional", purpose: "Index generation", versionArgs: [] },
    { id: "harper-cli", name: "Harper CLI", command: "harper-cli", requirement: "optional", purpose: "TexLite spelling and grammar checks" },
    { id: "harper-ls", name: "Harper language server", command: "harper-ls", requirement: "optional", purpose: "External editor integration (not used by TexLite)" }
  ];
}

function gitToolDefinition(command: string, timeoutMs: number): EnvironmentToolDefinition {
  return { id: "git", name: "Git", command, requirement: "optional", purpose: "Git and GitHub backup", timeoutMs };
}

async function inspectTool(tool: EnvironmentToolDefinition): Promise<EnvironmentTool> {
  if (tool.id === "node") return inspectNode(tool);
  const identity = toolIdentity(tool);
  const result = await commandVersion(tool.command, tool.timeoutMs ?? commandProbeTimeoutMs, tool.versionArgs ?? ["--version"]);
  if (!result.error && result.status === 0) {
    return { ...identity, status: "installed", version: versionFromResult(result), detail: null };
  }
  const missing = result.errorCode === "ENOENT";
  return {
    ...identity,
    status: missing ? "missing" : "failed",
    version: null,
    detail: commandFailureDetail(result)
  };
}

function inspectNode(tool: EnvironmentToolDefinition): EnvironmentTool {
  const identity = toolIdentity(tool);
  const match = /^v(\d+)/.exec(process.version);
  const major = match ? Number(match[1]) : Number.NaN;
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    return { ...identity, status: "installed", version: process.version, detail: null };
  }
  return {
    ...identity,
    status: "failed",
    version: process.version || null,
    detail: `TexLite requires Node.js ${MIN_NODE_MAJOR} or newer.`
  };
}

function toolIdentity(tool: EnvironmentToolDefinition): Pick<EnvironmentTool, "id" | "name" | "command" | "requirement" | "requirementGroup" | "purpose"> {
  return {
    id: tool.id,
    name: tool.name,
    command: tool.command,
    requirement: tool.requirement,
    requirementGroup: tool.requirementGroup,
    purpose: tool.purpose
  };
}

function versionFromResult(result: CommandProbeResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^warning\b/i.test(line) && !/^possible precedence problem\b/i.test(line));
  const versionLine = lines.find((line) => /\bversion\b|\bv?\d+\.\d+/i.test(line)) ?? lines[0];
  return (versionLine ?? "available").slice(0, 160);
}

function commandFailureDetail(result: CommandProbeResult): string {
  const detail = result.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`;
  return detail.replace(/\s+/g, " ").slice(0, 240);
}

function commandVersion(command: string, timeoutMs: number, args: string[]): Promise<CommandProbeResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, LC_ALL: "C" }, shell: false, detached: detachedProcessGroup(),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
      resolve({ status: null, stdout: "", stderr: "", error: message, errorCode });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const finish = (result: Pick<CommandProbeResult, "status" | "error" | "errorCode">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child); }, timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxCommandOutputBytes) {
        outputExceeded = true;
        killProcessGroup(child);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error: NodeJS.ErrnoException) => finish({ status: null, error: error.message, errorCode: error.code ?? null }));
    child.once("close", (status) => finish({
      status,
      error: timedOut ? "command timed out" : outputExceeded ? "command produced too much output" : null,
      errorCode: null
    }));
  });
}
