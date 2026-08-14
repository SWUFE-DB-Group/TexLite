import { describe, expect, it } from "vitest";
import { formatProcessStatus, parseArgs } from "../src/server/cli.js";
import type { ProcessStatus } from "../src/server/pm2.js";

describe("CLI argument parsing", () => {
  it("accepts a command followed by an explicit config path", () => {
    expect(parseArgs(["start", "--config", "./custom.json"])).toEqual({
      command: "start",
      configPath: "./custom.json",
      checkGit: false,
      json: false
    });
  });

  it("accepts global options before the command", () => {
    expect(parseArgs(["--config=/tmp/texlite.json", "doctor", "--git"])).toEqual({
      command: "doctor",
      configPath: "/tmp/texlite.json",
      checkGit: true,
      json: false
    });
  });

  it("rejects an option without its value", () => {
    expect(() => parseArgs(["init", "--config"])).toThrow(/--config requires a configuration file path/);
  });

  it("supports machine-readable status output", () => {
    expect(parseArgs(["status", "--json"]).json).toBe(true);
  });

  it("formats a healthy process like a service status", () => {
    const status: ProcessStatus = {
      name: "texlite", configPath: "/tmp/config.json", status: "online", pm2Status: "online", healthy: true,
      pid: 1234, startedAt: "2026-08-14T02:00:00.000Z", uptimeSeconds: 125, restarts: 0, version: "0.3.0",
      address: "http://127.0.0.1:3000", dataDir: "/tmp/data", cwd: "/opt/texlite",
      outputLog: "/tmp/out.log", errorLog: "/tmp/error.log"
    };
    const plain = formatProcessStatus(status);
    expect(plain).toContain("● TexLite - Lightweight collaborative LaTeX editor");
    expect(plain).toContain("Active: active (running)");
    expect(plain).toContain("2min 5s ago");
    expect(plain).not.toContain("\u001b[");
    expect(formatProcessStatus(status, true)).toContain("\u001b[32m●\u001b[0m");
  });
});
