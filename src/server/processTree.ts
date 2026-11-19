import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { attachWindowsJob, stopWindowsJob } from "./agents/windowsJob.js";

const run = promisify(execFile);

type WindowsCommand = { stop(): Promise<void>; complete: Promise<void> };
const windowsCommands = new WeakMap<ChildProcess, WindowsCommand>();

// No command runs before the parent assigns this launcher to the job. The
// launcher owns the last job handle and exits even if its IPC parent crashes.
const gatedCommand = `
  const { spawn } = require('node:child_process');
  process.once('disconnect', () => process.exit(1));
  process.once('message', ({ command, args, devtoolsPipe }) => {
    // Keep the Chrome protocol descriptors at 3 and 4 through both spawns.
    const stdio = devtoolsPipe ? ['inherit', 'inherit', 'inherit', 3, 4] : 'inherit';
    const worker = spawn(command, args, { windowsHide: true, stdio });
    worker.once('error', ({ message, code }) => {
      process.send({ message, code }, () => process.exit(1));
    });
    worker.once('exit', (code) => process.exit(code ?? 1));
  });
`;

/** For commands that can leave work behind even after the main process exits. */
export function spawnOwnedCommand(
  command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; devtoolsPipe?: boolean } = {}
): ChildProcessByStdio<null, Readable, Readable> {
  const { devtoolsPipe, ...spawnOptions } = options;
  const stdio: ("ignore" | "pipe" | "ipc")[] = ["ignore", "pipe", "pipe"];
  if (devtoolsPipe) stdio.push("pipe", "pipe");
  if (process.platform !== "win32") {
    return spawn(command, args, { ...spawnOptions, detached: true, stdio }) as ChildProcessByStdio<null, Readable, Readable>;
  }

  const id = randomUUID();
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", gatedCommand, "--", id], {
    ...spawnOptions, windowsHide: true, stdio: [...stdio, "ipc"]
  }) as ChildProcessByStdio<null, Readable, Readable>; // Node's overloads only type the three standard streams.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let attached = false;
  let stopping: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let launchError: unknown;
  const drain = () => draining ??= stopWindowsJob(id, "Command");
  child.on("message", (message: { message: string; code?: string }) => {
    launchError = Object.assign(new Error(message.message), { code: message.code });
  });
  const ready = (async () => {
    if (!child.pid) return; // Direct spawn errors still reach the usual listener.
    await attachWindowsJob(child.pid, id, "Command");
    attached = true;
    if (!stopping && child.connected) {
      // Pass arguments over IPC, not through a shell or the launcher's command line.
      await new Promise<void>((resolve, reject) => child.send({ command, args, devtoolsPipe }, (error) => error ? reject(error) : resolve()));
    }
  })().catch((error: unknown) => {
    launchError = error;
    child.kill();
  });
  const complete = closed.then(async () => {
    await ready;
    if (attached) await drain();
    if (launchError) throw launchError;
  });
  void complete.catch(() => undefined);
  const stop = async () => {
    await ready;
    if (attached) {
      try { await drain(); }
      catch (error) {
        child.kill();
        await closed;
        throw error;
      }
    }
    await closed;
  };
  windowsCommands.set(child, { stop: () => stopping ??= stop(), complete });
  return child;
}

/** For a still-owned Windows root. A failed tree kill is not a successful exit. */
async function killWindowsProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Windows process ID");
  try {
    const executable = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await run(executable, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024 });
  } catch (error) {
    throw new Error("Could not terminate the Windows process tree", { cause: error });
  }
}

/**
 * Start long-running external commands in their own process group on POSIX.
 * A negative PID can then be used to signal the command and all descendants
 * (for example latexmk's pdflatex/bibtex children) together.
 */
export function detachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        // Fall through to child.kill().  It is possible for a process group
        // to be unavailable even though the child itself is still alive.
      }
    }
  }
  try { child.kill(signal); } catch { /* the process may have exited already */ }
}

/** Only Windows requires an asynchronous, forced tree kill. */
const windowsTerminations = new WeakMap<ChildProcess, Promise<void>>();

export function stopProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (process.platform !== "win32") {
    // Don't memoize POSIX signals: a later timeout can escalate a SIGTERM.
    signalPosixGroup(child, signal);
    return Promise.resolve();
  }
  const owned = windowsCommands.get(child);
  if (owned) return owned.stop();
  const pending = windowsTerminations.get(child);
  if (pending) return pending;
  if (!child.pid) return Promise.resolve();
  // A PID may have been recycled once Node observed the original exit.
  const stopped = child.exitCode !== null || child.signalCode !== null
    ? Promise.reject(new Error("Windows process exited before its tree could be terminated"))
    : killWindowsProcessTree(child.pid);
  windowsTerminations.set(child, stopped);
  // The owning operation observes failures; event listeners may fire and forget.
  void stopped.catch(() => undefined);
  return stopped;
}

export function afterProcessStop(child: ChildProcess, complete: () => void, fail: (error: Error) => void): void {
  const stopped = windowsCommands.get(child)?.complete ?? windowsTerminations.get(child);
  if (stopped) void stopped.then(complete, fail);
  else complete();
}
