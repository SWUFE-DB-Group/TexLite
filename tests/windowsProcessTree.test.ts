import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { afterProcessStop, spawnOwnedCommand, stopProcessTree } from "../src/server/processTree.js";
import { executeAgentCommand } from "../src/server/agents/adapters/common.js";

it.runIf(process.platform === "win32")("uses the same batch quoting for noninteractive Agent commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "texlite cli test "));
  try {
    for (const extension of ["cmd", "bat"]) {
      const launcher = path.join(root, `agent stub.${extension}`);
      await fs.writeFile(launcher, '@echo off\r\nif not "%~1"=="paper draft" exit /b 7\r\necho ok\r\n');
      const result = await executeAgentCommand(launcher, ["paper draft"], { windowsHide: true, timeout: 5_000 });
      expect(result.stdout.trim()).toBe("ok");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "win32")("cancels and waits for a Windows command and its descendants", async () => {
  const child = spawn(process.execPath, ["-e", `
    const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    console.log(worker.pid);
    setInterval(() => {}, 1000);
  `], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
  let pid: number | undefined;
  try {
    await vi.waitFor(() => expect(output.trim()).toMatch(/^\d+$/), { timeout: 5_000 });
    pid = Number(output.trim());
    expect(process.kill(pid, 0)).toBe(true);
    const first = stopProcessTree(child);
    expect(stopProcessTree(child)).toBe(first);
    await Promise.all([first, closed]);
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })));
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopProcessTree(child);
  }
}, 15_000);

it.runIf(process.platform === "win32").each(["command exit", "launcher exit", "parent disconnect", "cancel"])(
  "reclaims owned Windows descendants after %s", async (event) => {
    const child = spawnOwnedCommand(process.execPath, ["-e", `
      const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      console.log(worker.pid);
      ${event === "command exit" ? "worker.unref();" : "setTimeout(() => {}, 30000);"}
    `]);
    child.stderr.resume();
    const complete = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => afterProcessStop(child, resolve, reject));
    });
    void complete.catch(() => undefined);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    try {
      await vi.waitFor(() => expect(output.trim()).toMatch(/^\d+$/), { timeout: 15_000 });
      const pid = Number(output.trim());
      if (event !== "command exit") expect(process.kill(pid, 0)).toBe(true);
      if (event === "launcher exit") expect(child.kill()).toBe(true);
      if (event === "parent disconnect") child.disconnect();
      if (event === "cancel") await stopProcessTree(child);
      await complete;
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })));
    } finally {
      if (child.exitCode === null && child.signalCode === null) await stopProcessTree(child);
    }
  }, 40_000
);
