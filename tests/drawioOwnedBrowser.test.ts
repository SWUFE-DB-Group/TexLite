import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import { expect, it, vi } from "vitest";
import { launchOwnedDrawioBrowser } from "../src/server/drawioOwnedBrowser.js";

// Real inherited pipes and a fake browser command; on Windows this goes
// through the same job-assignment gate as the production browser.
const echo = String.raw`
  const fs = require('node:fs');
  const request = Buffer.alloc(1);
  fs.readSync(3, request);
  if (request.toString() !== '?') process.exit(2);
  const text = Buffer.from(JSON.stringify({ label: '图表', pid: process.pid }) + '\0');
  fs.writeSync(4, text.subarray(0, 12));
  setTimeout(() => {
    fs.writeSync(4, text.subarray(12));
  }, 20);
  setTimeout(() => {}, 30000);
`;

it.each(["cancellation", "unresponsive browser close"])("passes DevTools pipes through the launcher and reaps the browser after %s", async (event) => {
  const controller = new AbortController();
  let profile = "", pid: number | undefined;
  const close = vi.fn(() => new Promise<void>(() => {}));
  const launched = await launchOwnedDrawioBrowser({
    defaultArgs: async ({ userDataDir } = {}) => {
      profile = userDataDir!;
      return ["-e", echo, "--"];
    },
    connect: async ({ transport }) => new Promise<Browser>((resolve, reject) => {
      const pipe = transport!;
      pipe.onclose = () => reject(new Error("Chrome pipe closed during startup"));
      pipe.onmessage = (data) => {
        const message = JSON.parse(data) as { label: string; pid: number };
        pid = message.pid;
        if (message.label !== "图表") return reject(new Error("Corrupted UTF-8 response"));
        resolve({ close } as unknown as Browser);
      };
      pipe.send("?");
    })
  }, process.execPath, controller.signal);
  try {
    expect(fs.existsSync(profile)).toBe(true);
    expect(process.kill(pid!, 0)).toBe(true);
    if (event === "cancellation") controller.abort();
    await launched.close();
    expect(close).toHaveBeenCalledTimes(event === "cancellation" ? 0 : 1);
    expect(fs.existsSync(profile)).toBe(false);
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })));
  } finally {
    controller.abort();
    await launched.close();
  }
}, 35_000);

it("cleans up the job and profile when the browser exits before connecting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-drawio-pid-"));
  const marker = path.join(root, "child.pid");
  // Do not leave a test grandchild on POSIX, where this production path is
  // unused. Windows must reclaim it after the browser root exits.
  const crash = 'console.error("host browser diagnostic");\n' + (process.platform === "win32" ? `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid));
    child.unref();
    process.exit(2);
  ` : "process.exit(2)");
  try {
    let profile = "";
    await expect(launchOwnedDrawioBrowser({
      defaultArgs: async ({ userDataDir } = {}) => {
        profile = userDataDir!;
        return ["-e", crash, "--", marker];
      },
      connect: async ({ transport }) => new Promise<Browser>((_resolve, reject) => {
        transport!.onclose = () => reject(new Error("Chrome exited before connecting"));
      })
    }, process.execPath, new AbortController().signal)).rejects.toMatchObject({
      message: expect.stringContaining("host browser diagnostic"),
      cause: expect.objectContaining({ message: "Chrome exited before connecting" })
    });
    expect(profile).toBeTruthy();
    expect(fs.existsSync(profile)).toBe(false);
    if (process.platform === "win32") {
      const pid = Number(fs.readFileSync(marker, "utf8"));
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
}, 30_000);
