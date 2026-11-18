import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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
  const stopped = windowsTerminations.get(child);
  if (stopped) void stopped.then(complete, fail);
  else complete();
}
