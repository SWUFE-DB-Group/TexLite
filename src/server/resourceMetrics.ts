import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ResourceSample, TexMemorySample } from "../shared/resourceMetrics.js";
import { collectSystemMemory } from "./systemMemory.js";
import { collectCpuSnapshot, CpuMetrics, type CpuProcessCounter } from "./cpuMetrics.js";

const exec = promisify(execFile);
const commandOptions = { timeout: 3_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C" } };
const texTools = new Set([
  "tex", "latex", "pdftex", "pdflatex", "xetex", "xelatex", "luatex", "lualatex", "luahbtex", "luahblatex",
  "pdfetex", "etex", "elatex", "euptex", "uptex", "uplatex", "ptex", "platex", "tectonic",
  "latexmk", "bibtex", "bibtex8", "bibtexu", "biber", "makeindex", "xindy", "texindy", "makeglossaries",
  "dvipdfm", "dvipdfmx", "xdvipdfmx", "dvips", "texcount", "chktex", "harper-cli"
]);
const texScripts = new Set(["latexmk", "biber", "makeglossaries", "texcount", "texindy", "xindy"]);
const unavailable = (): TexMemorySample => ({ rssBytes: null, processCount: null });

interface ProcessAccess {
  read: (file: string) => Promise<string>;
  directories: () => Promise<string[]>;
  command: (file: string, args: string[]) => Promise<string>;
}

const processAccess: ProcessAccess = {
  read: (file) => readFile(file, "utf8"),
  directories: () => readdir("/proc"),
  command: async (file, args) => (await exec(file, args, commandOptions)).stdout
};

export interface MemoryProcess {
  pid: number;
  name: string;
  rssBytes: number | null;
  argv?: string[];
  /** Linux uses USER_HZ ticks; macOS/Windows use microseconds. */
  cpuTime?: number;
  started?: string;
}

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase().replace(/\.(?:exe|pl)$/i, "").replace(/^miktex-/, "");
}

function isPerl(name: string): boolean {
  return /^perl(?:\d+(?:\.\d+)*)?$/.test(executableName(name));
}

/** Includes Harper CLI writing checks; match tool names, not arbitrary arguments or every Perl process. */
export function isTexProcess(process: MemoryProcess): boolean {
  if (texTools.has(executableName(process.name))) return true;
  if (!isPerl(process.name) || !process.argv) return false;
  const args = process.argv.slice(1);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return texScripts.has(executableName(args[index + 1] ?? ""));
    if (arg === "-e" || arg === "-E" || /^-[eE]/.test(arg)) return false;
    if (["-I", "-M", "-m"].includes(arg)) { index++; continue; }
    if (arg.startsWith("-")) continue;
    return texScripts.has(executableName(arg));
  }
  return false;
}

/** A failed RSS read must not look like a successfully measured zero. */
export function sumTexMemory(processes: MemoryProcess[]): TexMemorySample {
  const selected = new Map(processes.filter(isTexProcess).map((process) => [process.pid, process]));
  let rssBytes = 0;
  for (const process of selected.values()) {
    if (process.rssBytes === null || !Number.isFinite(process.rssBytes) || process.rssBytes < 0) return unavailable();
    rssBytes += process.rssBytes;
  }
  return { rssBytes, processCount: selected.size };
}

// Handle quoted script paths when available; Linux uses lossless NUL-separated argv.
function commandArguments(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => /^(["']).*\1$/.test(part) ? part.slice(1, -1) : part);
}

export function parsePosixProcesses(output: string): MemoryProcess[] {
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) throw new Error("Invalid ps memory sample");
    const timing = match[3].match(/^(\S+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, name: timing?.[3] ?? match[3],
      ...(timing ? { cpuTime: parseCpuTime(timing[1]), started: timing[2] } : {}) };
  });
}

/** BSD ps CPU time: [[days-]hours:]minutes:seconds[.fraction]. */
export function parseCpuTime(value: string): number {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error("Invalid process CPU time");
  return ((Number(match[1] ?? 0) * 86_400) + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4])) * 1_000_000;
}

export function parseLinuxProcessCpu(stat: string): Pick<MemoryProcess, "cpuTime" | "started"> {
  // comm can contain spaces and parentheses. The final ')' ends that field.
  const closing = stat.lastIndexOf(")");
  if (closing < 0) throw new Error("Invalid process stat");
  const fields = stat.slice(closing + 1).trim().split(/\s+/);
  if (![fields[11], fields[12], fields[19]].every((field) => /^\d+$/.test(field ?? ""))) throw new Error("Invalid process CPU counters");
  return { cpuTime: Number(fields[11]) + Number(fields[12]), started: fields[19] };
}

export function parseWindowsProcesses(output: string): MemoryProcess[] {
  const decoded: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (decoded === null) return [];
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  return entries.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid CIM memory sample");
    const entry = value as Record<string, unknown>;
    if (typeof entry.Name !== "string" || !Number.isInteger(entry.ProcessId)) throw new Error("Invalid CIM process");
    const rss = entry.WorkingSetSize === null || entry.WorkingSetSize === undefined ? null : Number(entry.WorkingSetSize);
    return {
      pid: entry.ProcessId as number, name: entry.Name,
      rssBytes: rss, argv: typeof entry.CommandLine === "string" ? commandArguments(entry.CommandLine) : undefined,
      ...(entry.UserModeTime !== null && entry.UserModeTime !== undefined && entry.KernelModeTime !== null && entry.KernelModeTime !== undefined && typeof entry.CreationDate === "string"
        ? { cpuTime: (Number(entry.UserModeTime) + Number(entry.KernelModeTime)) / 10, started: entry.CreationDate } : {})
    };
  });
}

async function linuxProcesses(io: ProcessAccess): Promise<MemoryProcess[]> {
  const ids = (await io.directories()).filter((name) => /^\d+$/.test(name));
  const result: MemoryProcess[] = [];
  let cursor = 0;
  // Bound open file descriptors even on hosts running many unrelated processes.
  await Promise.all(Array.from({ length: Math.min(16, ids.length) }, async () => {
    while (cursor < ids.length) {
      const pid = Number(ids[cursor++]);
      try {
        const status = await io.read(`/proc/${pid}/status`);
        if (/^State:\s+Z/m.test(status)) continue;
        const name = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim();
        if (!name || (!texTools.has(executableName(name)) && !isPerl(name))) continue;
        const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
        const argv = isPerl(name) ? (await io.read(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean) : undefined;
        // A missing CPU counter must not discard an otherwise valid memory reading.
        const cpu = await io.read(`/proc/${pid}/stat`).then(parseLinuxProcessCpu).catch(() => ({}));
        result.push({ pid, name, rssBytes: rss ? Number(rss[1]) * 1024 : null, argv, ...cpu });
      } catch (error) {
        // Exiting processes and processes hidden by OS permissions are outside this visible sample.
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }));
  return result;
}

async function macProcesses(io: ProcessAccess): Promise<MemoryProcess[]> {
  const stdout = await io.command("ps", ["-ww", "-axo", "pid=,rss=,time=,lstart=,comm="]);
  const result = parsePosixProcesses(stdout);
  const interpreters = result.filter((process) => isPerl(process.name));
  if (interpreters.length) {
    const commands = await io.command("ps", ["-ww", "-p", interpreters.map((process) => process.pid).join(","), "-o", "pid=,args="])
      .catch((error: unknown) => {
        // ps exits 1 if all requested processes disappeared between the two samples.
        if ((error as { code?: unknown }).code === 1) return "";
        throw error;
      });
    const argsByPid = new Map(commands.trim().split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match ? [[Number(match[1]), commandArguments(match[2])] as const] : [];
    }));
    for (const process of interpreters) process.argv = argsByPid.get(process.pid);
  }
  return result;
}

export async function collectTexResources(platform = process.platform, io: ProcessAccess = processAccess): Promise<{ memory: TexMemorySample; cpu: CpuProcessCounter[] | null }> {
  try {
    let processes: MemoryProcess[];
    if (platform === "linux") processes = await linuxProcesses(io);
    else if (platform === "darwin") processes = await macProcesses(io);
    else if (platform === "win32") {
      const stdout = await io.command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,WorkingSetSize,CommandLine,UserModeTime,KernelModeTime,CreationDate | ConvertTo-Json -Compress"]);
      processes = parseWindowsProcesses(stdout);
    } else return { memory: unavailable(), cpu: null };
    const selected = processes.filter(isTexProcess);
    const validCpu = selected.every((process) => process.cpuTime !== undefined && Number.isFinite(process.cpuTime) && process.cpuTime >= 0 && process.started !== undefined);
    return { memory: sumTexMemory(selected), cpu: validCpu ? selected.map((process) => ({ pid: process.pid, started: process.started!, time: process.cpuTime! })) : null };
  } catch { /* Optional monitoring must never interrupt application operations. */ }
  return { memory: unavailable(), cpu: null };
}

async function collectResources(cpu: CpuMetrics): Promise<ResourceSample> {
  const [systemMemory, tex] = await Promise.all([collectSystemMemory(), collectTexResources()]);
  const cpuSnapshot = await collectCpuSnapshot(systemMemory.scope, tex.cpu);
  return { systemMemory, texMemory: tex.memory, cpu: cpu.update(cpuSnapshot, systemMemory.scope) };
}

/** On-demand only: no timers or process scans while nobody is viewing System status. */
export class ResourceMetrics {
  private cached: { at: number; value: ResourceSample } | null = null;
  private pending: Promise<ResourceSample> | null = null;
  private readonly collect: () => Promise<ResourceSample>;

  constructor(collect?: () => Promise<ResourceSample>, private readonly now = Date.now) {
    const cpu = new CpuMetrics();
    this.collect = collect ?? (() => collectResources(cpu));
  }

  sample(): Promise<ResourceSample> {
    if (this.cached && this.now() - this.cached.at < 2_000) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    this.pending = this.collect().then((value) => {
      this.cached = { at: this.now(), value };
      return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
