import { describe, expect, it, vi } from "vitest";
import { inspectAgentProcess, agentProcessGroupAlive, type AgentProcessIO } from "../src/server/agents/processIdentity.js";

const executionId = "11111111-2222-4333-8444-555555555555";
const command = `/usr/bin/node /app/agents/launcher.js /data/execution.json ${executionId}`;
function linux(state = "S", launch = command): AgentProcessIO {
  const fields = Array<string>(20).fill("0"); fields[0] = state; fields[19] = "12345";
  return { platform: "linux", command: vi.fn(), read: vi.fn(async (filename) => {
    if (filename.endsWith("/stat")) return `4242 (node with spaces) ${fields.join(" ")}`;
    if (filename.endsWith("/cmdline")) return launch.replaceAll(" ", "\0") + "\0";
    return "boot-id\n";
  }) };
}

describe("durable agent process identity", () => {
  it("uses Linux boot identity, birth ticks and the unique launcher marker", async () => {
    await expect(inspectAgentProcess(4242, executionId, linux())).resolves.toEqual({ identity: "boot-id:12345", owned: true });
    await expect(inspectAgentProcess(4242, executionId, linux("S", "/usr/bin/node other.js"))).resolves.toEqual({ identity: "boot-id:12345", owned: false });
  });

  it.each(["Z", "X"])("does not count Linux %s processes as live executions", async (state) => {
    await expect(inspectAgentProcess(4242, executionId, linux(state))).resolves.toBeNull();
  });

  it("distinguishes missing process files from denied or malformed identity data", async () => {
    const io = linux();
    vi.mocked(io.read).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(inspectAgentProcess(4242, executionId, io)).resolves.toBeNull();
    vi.mocked(io.read).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(inspectAgentProcess(4242, executionId, io)).rejects.toThrow("denied");
    vi.mocked(io.read).mockResolvedValue("malformed");
    await expect(inspectAgentProcess(4242, executionId, io)).rejects.toThrow("Cannot verify");
  });

  it("reads macOS start time and full command without assuming PID absence from ps errors", async () => {
    const io: AgentProcessIO = { platform: "darwin", read: vi.fn(), command: vi.fn(async () => `  4242 Mon Oct 26 12:30:01 2026 ${command}\n`) };
    await expect(inspectAgentProcess(4242, executionId, io)).resolves.toEqual({ identity: "Mon Oct 26 12:30:01 2026", owned: true });
    vi.mocked(io.command).mockResolvedValue("  4243 Mon Oct 26 12:30:01 2026 /other\n");
    await expect(inspectAgentProcess(4242, executionId, io)).resolves.toBeNull();
    vi.mocked(io.command).mockRejectedValue(new Error("ps unavailable"));
    await expect(inspectAgentProcess(4242, executionId, io)).rejects.toThrow("ps unavailable");
  });

  it("uses Windows creation time and command marker and refuses unreadable metadata", async () => {
    const io: AgentProcessIO = { platform: "win32", read: vi.fn(), command: vi.fn(async () => JSON.stringify({
      CreationDate: "2026-10-26T04:30:01Z", CommandLine: `node.exe C:\\app\\agents\\launcher.js C:\\execution.json ${executionId}`
    })) };
    await expect(inspectAgentProcess(4242, executionId, io)).resolves.toEqual({ identity: "2026-10-26T04:30:01Z", owned: true });
    expect(io.command).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining([expect.stringContaining("ProcessId = 4242")]));
    vi.mocked(io.command).mockResolvedValue("");
    await expect(inspectAgentProcess(4242, executionId, io)).resolves.toBeNull();
    vi.mocked(io.command).mockResolvedValue('{"CreationDate":"date","CommandLine":null}');
    await expect(inspectAgentProcess(4242, executionId, io)).rejects.toThrow("Cannot verify");
    vi.mocked(io.command).mockRejectedValue(new Error("CIM unavailable"));
    await expect(inspectAgentProcess(4242, executionId, io)).rejects.toThrow("CIM unavailable");
  });

  it("ignores zombie group members but detects a live leaderless POSIX group", async () => {
    const io: AgentProcessIO = { platform: "linux", read: vi.fn(), command: vi.fn(async () => "4242 Z\n4242 Zs\n42 S\n") };
    await expect(agentProcessGroupAlive(4242, io)).resolves.toBe(false);
    vi.mocked(io.command).mockResolvedValue("4242 Z\n4242 S+\n");
    await expect(agentProcessGroupAlive(4242, io)).resolves.toBe(true);
  });
});
