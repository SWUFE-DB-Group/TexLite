import { spawn } from "node:child_process";
import type { Config } from "./config.js";

export interface EnvironmentCommand {
  name: string;
  command: string;
  version: string;
}

export async function assertEnvironment(config: Config): Promise<EnvironmentCommand[]> {
  const commands = [
    { name: "Git", command: config.git },
    { name: "latexmk", command: config.latexmk },
    ...config.allowedEngines.map((command) => ({ name: command, command }))
  ];
  const checked: EnvironmentCommand[] = [];
  const seen = new Set<string>();
  for (const item of commands) {
    if (seen.has(item.command)) continue;
    seen.add(item.command);
    const result = await commandVersion(item.command, Math.min(config.gitOperationTimeoutMs, 10_000));
    if (result.error || result.status !== 0) {
      const detail = result.error || result.stderr.trim() || `exit ${result.status ?? "unknown"}`;
      throw new Error(`环境检查失败：无法运行 ${item.name} 命令“${item.command}”（${detail}）。初始化/启动已停止。`);
    }
    const version = `${result.stdout || result.stderr}`.trim().split("\n")[0]?.slice(0, 160) || "available";
    checked.push({ ...item, version });
  }
  return checked;
}

function commandVersion(command: string, timeoutMs: number): Promise<{
  status: number | null; stdout: string; stderr: string; error: string | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: { ...process.env, LC_ALL: "C" }, shell: false, stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (result: { status: number | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (Buffer.concat(stdout).length < 64 * 1024) stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk); });
    child.once("error", (error) => finish({ status: null, error: error.message }));
    child.once("close", (status) => finish({ status, error: timedOut ? "命令超时" : null }));
  });
}
