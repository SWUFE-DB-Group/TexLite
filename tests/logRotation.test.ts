import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogRotation, managedLogPaths } from "../src/server/logRotation.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "texlite-logs-"));
  roots.push(root);
  const logs = managedLogPaths(root);
  await fs.mkdir(path.dirname(logs.stdout));
  const errors = vi.fn();
  return { root, logs, errors, rotation: new LogRotation(root, errors, 10) };
}

describe("managed log rotation", () => {
  it("checks periodically and stops scheduling at shutdown", async () => {
    vi.useFakeTimers();
    const { logs, rotation } = await fixture();
    const check = vi.spyOn(rotation, "check");
    try {
      await rotation.start();
      await fs.writeFile(logs.stdout, "P".repeat(12));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(check).toHaveBeenCalledTimes(2);
      await rotation.check();
      expect(await fs.readFile(`${logs.stdout}.1`, "utf8")).toBe("P".repeat(12));
      await rotation.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { await rotation.stop(); }
  });
  it("retains three backups and preserves PM2's open file descriptor", async () => {
    const { logs, rotation, errors } = await fixture();
    const writer = await fs.open(logs.stdout, "a");
    try {
      for (let index = 1; index <= 5; index++) {
        await writer.write(String(index).repeat(12));
        await Promise.all([rotation.check(), rotation.check()]);
        expect(await fs.readFile(logs.stdout, "utf8")).toBe("");
      }
      for (let index = 1; index <= 3; index++) {
        expect(await fs.readFile(`${logs.stdout}.${index}`, "utf8")).toBe(String(6 - index).repeat(12));
      }
      await expect(fs.stat(`${logs.stdout}.4`)).rejects.toMatchObject({ code: "ENOENT" });
      await writer.write("next");
      expect(await fs.readFile(logs.stdout, "utf8")).toBe("next");
      expect(errors).not.toHaveBeenCalled();
    } finally { await writer.close(); await rotation.stop(); }
  });

  it("checks on startup, ignores missing/small logs and isolates other directories", async () => {
    const { logs, rotation, errors } = await fixture();
    const other = await fixture();
    await rotation.check();
    await fs.writeFile(logs.stdout, "small");
    await fs.writeFile(logs.stderr, "E".repeat(12));
    await fs.writeFile(other.logs.stderr, "O".repeat(12));
    await rotation.start();
    expect(await fs.readFile(logs.stdout, "utf8")).toBe("small");
    await rotation.stop();
    expect(await fs.readFile(`${logs.stderr}.1`, "utf8")).toBe("E".repeat(12));
    expect(await fs.readFile(other.logs.stderr, "utf8")).toBe("O".repeat(12));
    await fs.writeFile(logs.stdout, "X".repeat(12));
    await rotation.check();
    expect(await fs.readFile(logs.stdout, "utf8")).toBe("X".repeat(12));
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps the original log when backup fails and still rotates stderr", async () => {
    const { logs, rotation, errors } = await fixture();
    await fs.writeFile(logs.stdout, "A".repeat(12));
    await fs.writeFile(logs.stderr, "B".repeat(12));
    const originalCopy = fs.copyFile;
    vi.spyOn(fs, "copyFile").mockImplementation(async (source, target, mode) => {
      if (source === logs.stdout) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return originalCopy(source, target, mode);
    });
    await rotation.check();
    expect(await fs.readFile(logs.stdout, "utf8")).toBe("A".repeat(12));
    expect(await fs.readFile(`${logs.stderr}.1`, "utf8")).toBe("B".repeat(12));
    expect(errors).toHaveBeenCalledTimes(1);
    await rotation.stop();
  });
});
