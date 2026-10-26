import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type AgentProcessIdentity = { identity: string; owned: boolean } | null;
export interface AgentProcessIO {
  platform: NodeJS.Platform;
  read: (filename: string) => Promise<string>;
  command: (command: string, args: string[]) => Promise<string>;
}
const systemIO: AgentProcessIO = {
  platform: process.platform,
  read: (filename) => fs.readFile(filename, "utf8"),
  command: async (command, args) => (await promisify(execFile)(command, args,
    { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout
};
const missing = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
const marker = (command: string, executionId: string) => command.includes(executionId) && /(?:^|[\\/])launcher\.(?:js|ts)(?:[\s"\0]|$)/.test(command);

/** Birth identity plus a per-execution launcher marker; never trust a stored PID alone. */
export async function inspectAgentProcess(pid: number, executionId: string, io = systemIO): Promise<AgentProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid agent process ID");
  if (io.platform === "linux") {
    try {
      const [stat, command, boot] = await Promise.all([io.read(`/proc/${pid}/stat`), io.read(`/proc/${pid}/cmdline`), io.read("/proc/sys/kernel/random/boot_id")]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error("Cannot verify agent process birth");
      if (fields[0] === "Z" || fields[0] === "X") return null;
      return { identity: `${boot.trim()}:${fields[19]}`, owned: marker(command.replaceAll("\0", " "), executionId) };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  if (io.platform === "win32") {
    const output = await io.command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress`]);
    if (!output.trim()) return null;
    const value = JSON.parse(output) as { CreationDate?: unknown; CommandLine?: unknown } | null;
    if (value === null) return null;
    if (typeof value.CreationDate !== "string" || typeof value.CommandLine !== "string") throw new Error("Cannot verify agent process birth");
    return { identity: value.CreationDate, owned: marker(value.CommandLine, executionId) };
  }
  // macOS and other POSIX hosts expose a start time and full command via ps.
  // Querying the full table distinguishes a missing PID from ps invocation errors.
  const output = await io.command("ps", ["-ww", "-axo", "pid=,lstart=,args="]);
  const line = output.split("\n").find((line) => Number(line.trim().match(/^\d+/)?.[0]) === pid);
  if (!line) return null;
  const match = line.trim().match(/^\d+\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  if (!match) throw new Error("Cannot verify agent process birth");
  return { identity: match[1].replace(/\s+/g, " "), owned: marker(match[2], executionId) };
}

/** A vanished leader is not proof that all members of its POSIX group exited. */
export async function agentProcessGroupAlive(pid: number, io = systemIO): Promise<boolean> {
  if (io.platform === "win32") return false;
  const output = await io.command("ps", ["-axo", "pgid=,stat="]);
  return output.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && state && !/^[ZX]/.test(state);
  });
}
