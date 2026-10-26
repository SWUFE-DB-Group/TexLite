import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentPty, stopAgentPty, type AgentPty } from "../src/server/agents/terminal.js";
import { recoverAgentExecution, clearAgentExecution } from "../src/server/agents/execution.js";
import { inspectAgentProcess } from "../src/server/agents/processIdentity.js";

const roots: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-crash-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function processAlive(pid: number): boolean {
  try {
    if (process.platform === "linux" && /^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1])) return false;
    process.kill(pid, 0); return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

describe("recoverable agent PTY integration", () => {
  it("recovers a real process group after its TexLite-like host is forcibly killed", async (test) => {
    if (process.platform !== "linux" || !await loadAgentPty()) { test.skip(); return; }
    const root = directory();
    const host = fork(fileURLToPath(new URL("./fixtures/agent-crash-host.ts", import.meta.url)), [root], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let failureOutput = "";
    host.stderr?.on("data", (data) => { failureOutput += data; });
    let launcherPid: number | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      host.on("message", (message) => { if ((message as { ready?: boolean }).ready) { launcherPid = (message as { pid: number }).pid; resolve(); } });
      host.on("error", reject);
      host.on("exit", (code) => { if (!launcherPid) reject(new Error(`Crash fixture exited ${code}: ${failureOutput}`)); });
    });
    const filename = path.join(root, "execution.json");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Crash fixture did not start")), 7_000); })]);
      clearTimeout(timer);
      const record = JSON.parse(fs.readFileSync(filename, "utf8")) as { executionId: string };
      const pids = JSON.parse(fs.readFileSync(path.join(root, "pids.json"), "utf8")) as { cli: number; child: number };
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      host.kill("SIGKILL"); await exited;
      expect(await inspectAgentProcess(launcherPid!, record.executionId)).toMatchObject({ owned: true });
      expect(processAlive(pids.cli)).toBe(true);
      expect(processAlive(pids.child)).toBe(true);
      await recoverAgentExecution(filename);
      await vi.waitFor(() => {
        expect(processAlive(launcherPid!)).toBe(false);
        expect(processAlive(pids.cli)).toBe(false);
        expect(processAlive(pids.child)).toBe(false);
      });
      expect(fs.existsSync(filename)).toBe(false);
    } finally {
      clearTimeout(timer);
      host.kill("SIGKILL");
      // Only PIDs returned by this test's own PTY are ever used for emergency cleanup.
      if (launcherPid && processAlive(launcherPid)) await stopAgentPty({ pid: launcherPid });
    }
  }, 15_000);

  it("keeps the CLI on a TTY and reports its exit before reaping the identifiable launcher", async (test) => {
    const spawn = await loadAgentPty();
    if (!spawn) { test.skip(); return; }
    const root = directory();
    const filename = path.join(root, "execution.json");
    let pty: AgentPty | undefined;
    try {
      pty = await spawn(process.execPath, ["-e", 'process.stdout.write("TTY:"+process.stdin.isTTY+":"+process.stdout.isTTY+"\\n"); setTimeout(()=>process.exit(7),100);'], {
        name: "xterm-256color", cwd: root, env: { ...process.env as Record<string, string> }, cols: 80, rows: 24, executionFile: filename
      });
      let output = "";
      pty.onData((data) => { output += data; });
      const result = await new Promise<{ exitCode: number }>((resolve) => pty!.onExit(resolve));
      expect(result.exitCode).toBe(7);
      expect(output).toContain("TTY:true:true");
      const record = JSON.parse(fs.readFileSync(filename, "utf8")) as { executionId: string };
      expect(await inspectAgentProcess(pty.pid, record.executionId)).toMatchObject({ owned: true });
      await recoverAgentExecution(filename);
    } finally {
      if (pty && processAlive(pty.pid)) await stopAgentPty(pty);
      if (fs.existsSync(filename)) clearAgentExecution(filename);
    }
  }, 10_000);

  it("cannot launch the CLI when recovery cancels its permit before identity is committed", async (test) => {
    const spawn = await loadAgentPty();
    if (!spawn) { test.skip(); return; }
    const root = directory();
    const filename = path.join(root, "execution.json");
    const executionId = randomUUID();
    fs.writeFileSync(filename, JSON.stringify({ version: 1, executionId, platform: process.platform, pid: null, identity: null }));
    const pty = await spawn(process.execPath, [fileURLToPath(new URL("../src/server/agents/launcher.ts", import.meta.url)), filename, executionId], {
      name: "xterm-256color", cwd: root, env: { ...process.env as Record<string, string>, TEXLITE_AGENT_LAUNCH: JSON.stringify({
        executable: process.execPath, args: ["-e", 'require("fs").writeFileSync("must-not-exist", "launched")']
      }) }, cols: 80, rows: 24
    });
    try {
      const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
      await recoverAgentExecution(filename);
      await exited;
      expect(fs.existsSync(path.join(root, "must-not-exist"))).toBe(false);
    } finally { if (processAlive(pty.pid)) await stopAgentPty(pty); }
  }, 10_000);
});
