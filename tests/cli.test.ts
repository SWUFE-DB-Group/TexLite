import { describe, expect, it } from "vitest";
import { formatDoctorReport, formatProcessStatus, formatRequirementsReport, parseArgs, type DoctorReport, type RequirementsReport } from "../src/server/cli.js";
import type { ProcessStatus } from "../src/server/pm2.js";

describe("CLI argument parsing", () => {
  it("accepts a command followed by an explicit config path", () => {
    expect(parseArgs(["start", "--config", "./custom.json"])).toEqual({
      command: "start",
      configPath: "./custom.json",
      json: false
    });
  });

  it("accepts global options before the command", () => {
    expect(parseArgs(["--config=/tmp/texlite.json", "doctor", "--json"])).toEqual({
      command: "doctor",
      configPath: "/tmp/texlite.json",
      json: true
    });
  });

  it("rejects an option without its value", () => {
    expect(() => parseArgs(["init", "--config"])).toThrow(/--config requires a configuration file path/);
  });

  it("supports machine-readable status output", () => {
    expect(parseArgs(["status", "--json"]).json).toBe(true);
  });

  it("parses a configuration-free requirements check", () => {
    expect(parseArgs(["requirements", "--json"])).toEqual({ command: "requirements", configPath: undefined, json: true });
    expect(() => parseArgs(["requirements", "--config", "./texlite.config.json"])).toThrow("does not use --config");
  });

  it("rejects the obsolete Git-only doctor flag", () => {
    expect(() => parseArgs(["doctor", "--git"])).toThrow("Unknown option: --git");
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

  it("renders doctor checks in a readable table", () => {
    const report: DoctorReport = {
      configPath: "/tmp/texlite.json", dataDir: "/tmp/texlite-data", clientDir: "/tmp/client", ok: true,
      application: [{ name: "Configuration", status: "passed", detail: "Valid" }],
      hostTools: [
        { id: "node", name: "Node.js 24+", command: "node", requirement: "required", purpose: "Runtime", status: "installed", version: "v24.14.0", detail: null },
        { id: "texcount", name: "TeXcount", command: "texcount", requirement: "optional", purpose: "Statistics", status: "missing", version: null, detail: "spawn texcount ENOENT" }
      ]
    };
    const output = formatDoctorReport(report);
    expect(output).toContain("Host software");
    expect(output).toContain("Tool / command");
    expect(output).toContain("Not installed");
    expect(output).toContain("Required tools must be installed");
  });

  it("renders the configuration-free requirements report", () => {
    const report: RequirementsReport = {
      ok: true,
      hostTools: [
        { id: "node", name: "Node.js 24+", command: "node", requirement: "required", purpose: "Runtime", status: "installed", version: "v24.14.0", detail: null },
        { id: "engine:xelatex", name: "xelatex", command: "xelatex", requirement: "one-of", requirementGroup: "latex-engine", purpose: "Engine", status: "installed", version: "XeTeX", detail: null }
      ]
    };
    const output = formatRequirementsReport(report);
    expect(output).toContain("TexLite requirements");
    expect(output).toContain("default commands on PATH");
    expect(output).toContain("One of");
    expect(output).toContain("does not read a TexLite configuration");
  });
});
