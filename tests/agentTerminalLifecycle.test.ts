import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopAgentPty, type AgentPty } from "../src/server/agents/terminal.js";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

const pty: AgentPty = {
  pid: 123456789,
  write: vi.fn(), resize: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() }))
};
const osError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation((_command, _args, _options, callback) => callback(null, "", ""));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("agent process termination", () => {
  it("accepts an already exited Windows process without invoking taskkill", async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw osError("ESRCH"); });
    await expect(stopAgentPty(pty)).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledWith(pty.pid, 0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("accepts a Windows process that exits while taskkill is starting", async () => {
    vi.mocked(process.kill).mockReturnValueOnce(true).mockImplementation(() => { throw osError("ESRCH"); });
    execFile.mockImplementation((_command, _args, _options, callback) => callback(osError("EXIT_128")));
    await expect(stopAgentPty(pty)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith("taskkill", ["/pid", String(pty.pid), "/T", "/F"],
      { windowsHide: true }, expect.any(Function));
    expect(process.kill).toHaveBeenCalledTimes(2);
  });

  it("keeps Windows termination idempotent after a successful tree kill", async () => {
    await expect(stopAgentPty(pty)).resolves.toBeUndefined();
    vi.mocked(process.kill).mockImplementation(() => { throw osError("ESRCH"); });
    await expect(stopAgentPty(pty)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["EXIT_128", "ENOENT"])("does not hide %s when the Windows process still exists", async (code) => {
    const failure = osError(code);
    execFile.mockImplementation((_command, _args, _options, callback) => callback(failure));
    await expect(stopAgentPty(pty)).rejects.toBe(failure);
  });

  it("does not mistake denied Windows process probes for a completed termination", async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw osError("EPERM"); });
    const failure = osError("EACCES");
    execFile.mockImplementation((_command, _args, _options, callback) => callback(failure));
    await expect(stopAgentPty(pty)).rejects.toBe(failure);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("still reaps the entire POSIX process group after the grace period", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.useFakeTimers();
    const stopping = stopAgentPty(pty);
    expect(process.kill).toHaveBeenCalledWith(-pty.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(process.kill).toHaveBeenLastCalledWith(-pty.pid, "SIGKILL");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("accepts a missing POSIX group without changing the Windows code path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(process.kill).mockImplementation(() => { throw osError("ESRCH"); });
    await expect(stopAgentPty(pty)).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledWith(-pty.pid, "SIGTERM");
    expect(execFile).not.toHaveBeenCalled();
  });
});
