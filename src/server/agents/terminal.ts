import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface AgentPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export type AgentPtyFactory = (executable: string, args: string[], options: {
  name: string; cwd: string; env: Record<string, string>; cols: number; rows: number;
}) => AgentPty;

/** The native module is optional and must never break normal application startup. */
export async function loadAgentPty(): Promise<AgentPtyFactory | null> {
  try {
    const pty = await import("node-pty");
    return (executable, args, options) => {
      if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
        // npm's Windows entrypoints are command scripts. CreateProcess cannot
        // launch them directly; use the OS command processor for this fixed CLI.
        const command = windowsAgentCommand(executable, args);
        return pty.spawn(command.executable, command.args, options);
      }
      return pty.spawn(executable, args, options);
    };
  } catch { return null; }
}

export function windowsAgentCommand(executable: string, args: string[]): { executable: string; args: string } {
  const quote = (value: string) => {
    // Registered CLI flags/IDs never require shell expansion. Refuse values
    // that cmd.exe would reinterpret even within double quotes.
    if (/["%\r\n]/.test(value)) throw new Error("Unsupported Windows command argument");
    return `"${value}"`;
  };
  const command = [executable, ...args].map(quote).join(" ");
  return { executable: process.env.COMSPEC ?? process.env.ComSpec ?? "cmd.exe", args: `/d /v:off /s /c "${command}"` };
}

/** Only accepts the live PTY handle owned by this server, never a stored PID. */
export async function stopAgentPty(pty: AgentPty): Promise<void> {
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/pid", String(pty.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try { process.kill(-pty.pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  // A termination grace period, not a limit on the duration of a user's task.
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  try { process.kill(-pty.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
