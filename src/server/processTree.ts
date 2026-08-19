import type { ChildProcess } from "node:child_process";

/**
 * Start long-running external commands in their own process group on POSIX.
 * A negative PID can then be used to signal the command and all descendants
 * (for example latexmk's pdflatex/bibtex children) together.
 */
export function detachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

/**
 * Terminate an external command and its descendants when the platform
 * supports process groups.  The child-only fallback keeps this safe on
 * Windows and for processes that have already exited.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.platform !== "win32" && child.pid) {
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
