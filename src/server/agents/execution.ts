import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectAgentProcess, agentProcessGroupAlive } from "./processIdentity.js";
import { stopAgentPty, windowsAgentCommand, type AgentPty, type AgentPtyFactory } from "./terminal.js";
import { httpError } from "../http.js";

interface ExecutionRecord {
  version: 1;
  executionId: string;
  platform: NodeJS.Platform;
  pid: number | null;
  identity: string | null;
}

function readRecord(filename: string): ExecutionRecord | null {
  let value: ExecutionRecord;
  try { value = JSON.parse(fs.readFileSync(filename, "utf8")) as ExecutionRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (value?.version !== 1 || !/^[a-f\d-]{36}$/.test(value.executionId) || value.platform !== process.platform
    || !(value.pid === null && value.identity === null || Number.isSafeInteger(value.pid) && value.pid! > 0 && typeof value.identity === "string" && value.identity)) {
    throw httpError(409, "AGENT_RECOVERY_FAILED");
  }
  return value;
}

export function clearAgentExecution(filename: string): void {
  const record = readRecord(filename);
  if (record) {
    fs.rmSync(`${filename}.${record.executionId}.exit`, { force: true });
    fs.rmSync(`${filename}.${record.executionId}.exit.tmp`, { force: true });
  }
  fs.rmSync(`${filename}.tmp`, { force: true });
  fs.rmSync(filename, { force: true });
}

/** Only verified launchers may be signalled. Ambiguity keeps the durable lease. */
export async function recoverAgentExecution(filename: string): Promise<void> {
  const record = readRecord(filename);
  if (!record) return;
  if (record.pid !== null) {
    const process = await inspectAgentProcess(record.pid, record.executionId);
    if (process && process.identity === record.identity && process.owned) {
      // Verify twice before signalling; a recycled PID must never be targeted.
      const current = await inspectAgentProcess(record.pid, record.executionId);
      if (!current || current.identity !== record.identity || !current.owned) throw httpError(409, "AGENT_RECOVERY_FAILED");
      await stopAgentPty({ pid: record.pid });
      const deadline = Date.now() + 3_000;
      while (true) {
        const remaining = await inspectAgentProcess(record.pid, record.executionId);
        if ((!remaining || remaining.identity !== record.identity) && !await agentProcessGroupAlive(record.pid)) break;
        if (Date.now() >= deadline) throw httpError(409, "AGENT_RECOVERY_FAILED");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    } else if (process && process.identity === record.identity) {
      throw httpError(409, "AGENT_RECOVERY_FAILED");
    } else if (!process && await agentProcessGroupAlive(record.pid)) {
      // The wrapper was independently killed. Do not guess ownership of a
      // leaderless group; the administrator can stop it on the host and retry.
      throw httpError(409, "AGENT_RECOVERY_FAILED");
    }
  }
  // An uncommitted launch cannot start the CLI. Removing its permit makes a
  // delayed launcher exit, closing the spawn-before-identity-persistence gap.
  clearAgentExecution(filename);
}

/** Start a gated, identifiable group leader without changing the CLI's TTY. */
export async function spawnRecoverableAgent(spawn: AgentPtyFactory, executable: string, args: string[],
  options: Parameters<AgentPtyFactory>[2], filename: string, beforeStart?: () => void): Promise<AgentPty> {
  const record: ExecutionRecord = { version: 1, executionId: randomUUID(), platform: process.platform, pid: null, identity: null };
  fs.writeFileSync(filename, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  const compiled = new URL("./launcher.js", import.meta.url);
  const launcher = fileURLToPath(fs.existsSync(compiled) ? compiled : new URL("./launcher.ts", import.meta.url));
  let launch = { executable, args, windowsVerbatimArguments: false };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    const command = windowsAgentCommand(executable, args);
    launch = { executable: command.executable, args: ["/d", "/v:off", "/s", "/c", command.args.slice("/d /v:off /s /c ".length)], windowsVerbatimArguments: true };
  }
  let pty: AgentPty | undefined;
  try {
    pty = await spawn(process.execPath, [launcher, filename, record.executionId], {
      ...options, env: { ...options.env, TEXLITE_AGENT_LAUNCH: JSON.stringify(launch) }
    });
    const wrapped = observeCliExit(pty, filename, record.executionId);
    let identity = await inspectAgentProcess(pty.pid, record.executionId);
    // Some PTY backends briefly expose their fork/exec helper's command line.
    const deadline = Date.now() + 3_000;
    while (!identity?.owned && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      identity = await inspectAgentProcess(pty.pid, record.executionId);
    }
    if (!identity?.owned) throw httpError(409, "AGENT_START_FAILED");
    record.pid = pty.pid; record.identity = identity.identity;
    // Conversation cleanup ownership must be durable before the CLI is allowed
    // to create any native state, not after the launch promise returns.
    beforeStart?.();
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, filename);
    return wrapped;
  } catch (error) {
    // No permit was issued, so the CLI cannot have started. Keep any failed
    // cleanup lease so service recovery can cancel the waiting launcher.
    if (pty) await stopAgentPty(pty);
    clearAgentExecution(filename);
    throw error;
  }
}

function observeCliExit(pty: AgentPty, filename: string, executionId: string): AgentPty {
  const resultFile = `${filename}.${executionId}.exit`;
  const listeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  let exited: { exitCode: number; signal?: number } | undefined;
  const notify = (event: { exitCode: number; signal?: number }) => {
    if (exited) return;
    exited = event;
    for (const listener of listeners) listener(event);
  };
  const readExit = () => {
    try {
      const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { executionId: string; exitCode: number };
      if (result.executionId === executionId && Number.isInteger(result.exitCode)) notify({ exitCode: result.exitCode });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") notify({ exitCode: 1 }); }
  };
  fs.watchFile(resultFile, { interval: 100, persistent: false }, readExit);
  pty.onExit((event) => { fs.unwatchFile(resultFile, readExit); notify(event); });
  return { pid: pty.pid, write: (data) => pty.write(data), resize: (cols, rows) => pty.resize(cols, rows), onData: (callback) => pty.onData(callback),
    onExit: (callback) => {
      listeners.add(callback);
      if (exited) { const event = exited; queueMicrotask(() => { if (listeners.has(callback)) callback(event); }); }
      return { dispose: () => { listeners.delete(callback); } };
    } };
}
