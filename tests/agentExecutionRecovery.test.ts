import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverAgentExecution } from "../src/server/agents/execution.js";
import { inspectAgentProcess, agentProcessGroupAlive } from "../src/server/agents/processIdentity.js";
import { stopAgentPty } from "../src/server/agents/terminal.js";

vi.mock("../src/server/agents/processIdentity.js", () => ({ inspectAgentProcess: vi.fn(), agentProcessGroupAlive: vi.fn() }));
vi.mock("../src/server/agents/terminal.js", () => ({ stopAgentPty: vi.fn(), windowsAgentCommand: vi.fn() }));
let root: string;
let filename: string;
let record: { version: number; executionId: string; platform: string; pid: number | null; identity: string | null };
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-agent-recovery-"));
  filename = path.join(root, "execution.json");
  record = { version: 1, executionId: randomUUID(), platform: process.platform, pid: 4242, identity: "birth-1" };
  fs.writeFileSync(filename, JSON.stringify(record));
  vi.mocked(inspectAgentProcess).mockResolvedValue(null);
  vi.mocked(agentProcessGroupAlive).mockResolvedValue(false);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

describe("agent crash recovery", () => {
  it("reaps only a verified launcher and clears its lease after the whole group exits", async () => {
    const owned = { identity: "birth-1", owned: true };
    vi.mocked(inspectAgentProcess).mockResolvedValueOnce(owned).mockResolvedValueOnce(owned);
    vi.mocked(stopAgentPty).mockImplementation(async () => { expect(fs.existsSync(filename)).toBe(true); });
    await recoverAgentExecution(filename);
    expect(stopAgentPty).toHaveBeenCalledWith({ pid: 4242 });
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("never kills a reused PID with a different birth identity", async () => {
    vi.mocked(inspectAgentProcess).mockResolvedValue({ identity: "birth-2", owned: false });
    await recoverAgentExecution(filename);
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("does not trust the birth identity without the execution marker", async () => {
    vi.mocked(inspectAgentProcess).mockResolvedValue({ identity: "birth-1", owned: false });
    await expect(recoverAgentExecution(filename)).rejects.toMatchObject({ code: "AGENT_RECOVERY_FAILED" });
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(true);
  });

  it("rechecks identity immediately before termination", async () => {
    vi.mocked(inspectAgentProcess).mockResolvedValueOnce({ identity: "birth-1", owned: true })
      .mockResolvedValueOnce({ identity: "birth-2", owned: false });
    await expect(recoverAgentExecution(filename)).rejects.toMatchObject({ code: "AGENT_RECOVERY_FAILED" });
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(true);
  });

  it("keeps a failed termination or unreadable identity retryable", async () => {
    vi.mocked(inspectAgentProcess).mockRejectedValueOnce(new Error("access denied"));
    await expect(recoverAgentExecution(filename)).rejects.toThrow("access denied");
    expect(fs.existsSync(filename)).toBe(true);
    vi.mocked(inspectAgentProcess).mockResolvedValue({ identity: "birth-1", owned: true });
    vi.mocked(stopAgentPty).mockRejectedValue(new Error("termination failed"));
    await expect(recoverAgentExecution(filename)).rejects.toThrow("termination failed");
    expect(fs.existsSync(filename)).toBe(true);
  });

  it("does not forget live descendants merely because the leader vanished", async () => {
    vi.mocked(agentProcessGroupAlive).mockResolvedValue(true);
    await expect(recoverAgentExecution(filename)).rejects.toMatchObject({ code: "AGENT_RECOVERY_FAILED" });
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(true);
    vi.mocked(agentProcessGroupAlive).mockResolvedValue(false);
    await recoverAgentExecution(filename);
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("cancels an uncommitted launch without allowing its CLI to start", async () => {
    fs.writeFileSync(filename, JSON.stringify({ ...record, pid: null, identity: null }));
    await recoverAgentExecution(filename);
    expect(inspectAgentProcess).not.toHaveBeenCalled();
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("preserves an invalid lease instead of guessing which process owns it", async () => {
    fs.writeFileSync(filename, '{"version":999}');
    await expect(recoverAgentExecution(filename)).rejects.toMatchObject({ code: "AGENT_RECOVERY_FAILED" });
    expect(stopAgentPty).not.toHaveBeenCalled();
    expect(fs.existsSync(filename)).toBe(true);
  });

  it("waits for asynchronous process exit after sending the kill", async () => {
    vi.useFakeTimers();
    const owned = { identity: "birth-1", owned: true };
    vi.mocked(inspectAgentProcess).mockResolvedValueOnce(owned).mockResolvedValueOnce(owned).mockResolvedValueOnce(owned);
    const recovering = recoverAgentExecution(filename);
    await vi.advanceTimersByTimeAsync(50);
    await recovering;
    expect(fs.existsSync(filename)).toBe(false);
  });
});
