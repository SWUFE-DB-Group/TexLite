import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCpuSnapshot, CpuMetrics, type CpuSnapshot } from "../src/server/cpuMetrics.js";
import { collectTexResources, parseCpuTime, parseLinuxProcessCpu, parsePosixProcesses, parseWindowsProcesses } from "../src/server/resourceMetrics.js";

function readFiles(files: Record<string, string>) {
  return async (file: string) => {
    if (!(file in files)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return files[file];
  };
}

describe("portable process CPU counters", () => {
  it.each(["linux", "darwin", "win32"] as const)("includes Harper CLI memory and CPU in the existing %s scan", async (platform) => {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "S"; fields[11] = "100"; fields[12] = "25"; fields[19] = "12345";
    const io = {
      directories: async () => ["12", "13"],
      read: readFiles({
        "/proc/12/status": "Name:\tharper-cli\nState:\tS (sleeping)\nVmRSS:\t200 kB\n",
        "/proc/12/stat": `12 (harper-cli) ${fields.join(" ")}`,
        "/proc/13/status": "Name:\tharper-ls\nVmRSS:\t900 kB\n"
      }),
      command: vi.fn(async () => platform === "win32" ? JSON.stringify([
        { ProcessId: 12, Name: "harper-cli.exe", WorkingSetSize: 200 * 1024, UserModeTime: "10000000", KernelModeTime: "2500000", CreationDate: "12345" },
        { ProcessId: 13, Name: "harper-ls.exe", WorkingSetSize: 900 * 1024 }
      ]) : "12 200 0:01.25 Tue Oct 20 10:50:00 2026 /usr/local/bin/harper-cli\n13 900 /usr/local/bin/harper-ls\n")
    };
    const result = await collectTexResources(platform, io);
    expect(result.memory).toEqual({ rssBytes: 200 * 1024, processCount: 1 });
    expect(result.cpu).toEqual([{ pid: 12, time: platform === "linux" ? 125 : 1_250_000,
      started: platform === "darwin" ? "Tue Oct 20 10:50:00 2026" : "12345" }]);
    expect(io.command).toHaveBeenCalledTimes(platform === "linux" ? 0 : 1);
  });

  it("parses Linux stat without confusing spaces or parentheses inside comm", () => {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "S"; fields[11] = "120"; fields[12] = "30"; fields[19] = "12345";
    expect(parseLinuxProcessCpu(`42 (a b) c)) ${fields.join(" ")}`)).toEqual({ cpuTime: 150, started: "12345" });
    expect(() => parseLinuxProcessCpu("invalid")).toThrow();
  });

  it.each([["0:01.25", 1_250_000], ["01:02:03", 3_723_000_000], ["1-02:03:04", 93_784_000_000]])("parses BSD CPU time %s", (input, expected) => {
    expect(parseCpuTime(input as string)).toBe(expected);
  });

  it("parses macOS start identities and cumulative times, not lifetime CPU percentages", () => {
    expect(parsePosixProcesses("12 200 0:01.25 Tue Oct 20 10:50:00 2026 /Library/TeX/texbin/pdflatex")[0]).toEqual({
      pid: 12, name: "/Library/TeX/texbin/pdflatex", rssBytes: 200 * 1024, cpuTime: 1_250_000, started: "Tue Oct 20 10:50:00 2026"
    });
  });

  it("converts Windows 100 ns counters to microseconds and preserves process identities", () => {
    expect(parseWindowsProcesses(JSON.stringify({ ProcessId: 12, Name: "pdflatex.exe", WorkingSetSize: "200", UserModeTime: "10000000", KernelModeTime: "2500000", CreationDate: "2026-10-20T02:00:00Z" }))[0])
      .toMatchObject({ pid: 12, cpuTime: 1_250_000, started: "2026-10-20T02:00:00Z" });
  });

  it("collects memory and CPU in one scan and preserves memory if CPU reading fails", async () => {
    const io = { directories: async () => [], read: readFiles({}), command: vi.fn(async () => "12 200 0:01.25 Tue Oct 20 10:50:00 2026 /usr/bin/pdflatex\n") };
    expect(await collectTexResources("darwin", io)).toEqual({ memory: { rssBytes: 200 * 1024, processCount: 1 }, cpu: [{ pid: 12, time: 1_250_000, started: "Tue Oct 20 10:50:00 2026" }] });
    expect(io.command).toHaveBeenCalledTimes(1);
    io.command.mockResolvedValue("12 200 /usr/bin/pdflatex\n");
    expect(await collectTexResources("darwin", io)).toEqual({ memory: { rssBytes: 200 * 1024, processCount: 1 }, cpu: null });
  });
});

describe("CPU sampling and normalization", () => {
  function snapshot(overrides: Partial<CpuSnapshot> = {}): CpuSnapshot {
    return { scope: "host", at: 0, hostCores: 4, capacityCores: 4, hostTotal: 10000, hostIdle: 8000, linuxTicks: null,
      containerUsageUs: null, serviceUs: 0, tex: [], ...overrides };
  }
  function sum(sample: ReturnType<CpuMetrics["update"]>): number {
    return sample.texlitePercent! + sample.otherPercent! + sample.idlePercent!;
  }

  it("starts with a warm-up and normalizes a fully busy single core to 25% on a four-core host", () => {
    const cpu = new CpuMetrics();
    expect(cpu.update(snapshot(), "host")).toMatchObject({ status: "warming", texlitePercent: null });
    const result = cpu.update(snapshot({ at: 5000, hostTotal: 30000, hostIdle: 23000, serviceUs: 1_000_000,
      tex: [{ pid: 12, started: "new", time: 4_000_000 }] }), "host");
    expect(result).toEqual({ scope: "host", status: "ready", texlitePercent: 25, otherPercent: 0, idlePercent: 75 });
    expect(sum(result)).toBeCloseTo(100);
  });

  it("uses Linux aggregate tick ratios without assuming a fixed CLK_TCK", () => {
    const cpu = new CpuMetrics();
    cpu.update(snapshot({ linuxTicks: 10000, tex: [{ pid: 12, started: "a", time: 500 }] }), "host");
    const result = cpu.update(snapshot({ at: 5000, hostTotal: 12000, hostIdle: 9000, linuxTicks: 12000,
      tex: [{ pid: 12, started: "a", time: 1000 }] }), "host");
    expect(result).toMatchObject({ status: "ready", texlitePercent: 25, otherPercent: 25, idlePercent: 50 });
  });

  it("uses fractional container CPU quotas and container usage, not host busy time", () => {
    const cpu = new CpuMetrics();
    cpu.update(snapshot({ scope: "container", hostCores: 8, capacityCores: 1.5, containerUsageUs: 0, linuxTicks: 10000 }), "container");
    const result = cpu.update(snapshot({ scope: "container", at: 5000, hostCores: 8, capacityCores: 1.5, containerUsageUs: 3_750_000,
      hostTotal: 14000, hostIdle: 10000, linuxTicks: 14000, serviceUs: 750_000,
      tex: [{ pid: 12, started: "a", time: 150 }] }), "container");
    expect(result).toMatchObject({ status: "ready", texlitePercent: 30, otherPercent: 20, idlePercent: 50 });
    expect(sum(result)).toBeCloseTo(100);
  });

  it("bounds saturation, rounding and sampling skew without negative other/idle shares", () => {
    const cpu = new CpuMetrics();
    cpu.update(snapshot({ scope: "container", capacityCores: 1, containerUsageUs: 0 }), "container");
    const result = cpu.update(snapshot({ scope: "container", capacityCores: 1, containerUsageUs: 10_000_000,
      at: 5000, hostTotal: 30000, hostIdle: 8000, serviceUs: 9_000_000 }), "container");
    expect(result).toMatchObject({ texlitePercent: 100, otherPercent: 0, idlePercent: 0 });
    expect(sum(result)).toBeCloseTo(100);
  });

  it("recognizes new processes and PID reuse using the start identity", () => {
    const cpu = new CpuMetrics();
    cpu.update(snapshot({ tex: [{ pid: 12, started: "old", time: 90_000_000 }] }), "host");
    expect(cpu.update(snapshot({ at: 5000, hostTotal: 30000, hostIdle: 23000,
      tex: [{ pid: 12, started: "new", time: 5_000_000 }] }), "host")).toMatchObject({ status: "ready", texlitePercent: 25 });
  });

  it("keeps the displayed total at 100% at half-way rounding boundaries", () => {
    const cpu = new CpuMetrics();
    cpu.update(snapshot(), "host");
    const result = cpu.update(snapshot({ at: 5000, hostTotal: 30000, hostIdle: 27990, serviceUs: 10000 }), "host");
    expect(result).toMatchObject({ texlitePercent: 0.1, idlePercent: 99.9, otherPercent: 0 });
    expect(sum(result)).toBeCloseTo(100);
  });

  it("starts a fresh window after an idle gap or capacity change", () => {
    for (const change of [{ at: 20000 }, { at: 5000, capacityCores: 2 }]) {
      const cpu = new CpuMetrics();
      cpu.update(snapshot(), "host");
      expect(cpu.update(snapshot({ hostTotal: 30000, ...change }), "host").status).toBe("warming");
    }
  });

  it("reports failed counters as unavailable and recovers rather than returning a fake zero", () => {
    const cpu = new CpuMetrics();
    expect(cpu.update(null, "host").status).toBe("unavailable");
    expect(cpu.update(snapshot({ tex: null }), "host").status).toBe("unavailable");
    expect(cpu.update(snapshot({ at: 5000 }), "host").status).toBe("warming");
    expect(cpu.update(snapshot({ at: 10000, hostTotal: 30000, hostIdle: 24000 }), "host")).toMatchObject({ status: "ready", texlitePercent: 0, otherPercent: 20, idlePercent: 80 });
  });
});

describe("host and cgroup CPU counters", () => {
  afterEach(() => vi.restoreAllMocks());
  function host() {
    vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: 4 }, () => ({ model: "test", speed: 1000, times: { user: 20, sys: 10, nice: 0, irq: 0, idle: 70 } })));
    vi.spyOn(os, "availableParallelism").mockReturnValue(4);
  }
  const stat = "cpu  100 0 100 600 50 20 30 0 40 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n";

  it("does not double-count Linux guest time and treats I/O wait as non-executing time", async () => {
    host();
    expect(await collectCpuSnapshot("host", [], "linux", readFiles({ "/proc/stat": stat }))).toMatchObject({ hostTotal: 900, hostIdle: 650, linuxTicks: 900, capacityCores: 4 });
  });

  it("uses OS CPU timers on macOS/Windows without probing Linux files", async () => {
    host();
    const read = vi.fn(readFiles({}));
    for (const platform of ["darwin", "win32"] as const) {
      expect(await collectCpuSnapshot("host", [], platform, read)).toMatchObject({ hostTotal: 400, hostIdle: 280, capacityCores: 4, linuxTicks: null });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("reads cgroup v2 usage and the tightest ancestor quota", async () => {
    host();
    expect(await collectCpuSnapshot("container", [], "linux", readFiles({
      "/proc/stat": stat, "/proc/self/cgroup": "0::/docker/app\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
      "/sys/fs/cgroup/docker/app/cpu.stat": "usage_usec 123456\nuser_usec 100000\n",
      "/sys/fs/cgroup/docker/app/cpu.max": "max 100000\n", "/sys/fs/cgroup/docker/cpu.max": "150000 100000\n"
    }))).toMatchObject({ capacityCores: 1.5, containerUsageUs: 123456 });
  });

  it("reads separate v1 cpu/cpuacct controllers with fractional quotas", async () => {
    host();
    expect(await collectCpuSnapshot("container", [], "linux", readFiles({
      "/proc/stat": stat, "/proc/self/cgroup": "1:cpu:/app\n2:cpuacct:/app\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu\n2 0 0:2 / /sys/fs/cgroup/cpuacct rw - cgroup cgroup rw,cpuacct\n",
      "/sys/fs/cgroup/cpuacct/app/cpuacct.usage": "123456000\n",
      "/sys/fs/cgroup/cpu/app/cpu.cfs_quota_us": "50000\n", "/sys/fs/cgroup/cpu/app/cpu.cfs_period_us": "100000\n"
    }))).toMatchObject({ capacityCores: 0.5, containerUsageUs: 123456 });
  });

  it("does not replace missing container accounting with host-wide CPU usage", async () => {
    host();
    expect(await collectCpuSnapshot("container", [], "linux", readFiles({ "/proc/stat": stat }))).toBeNull();
  });
});
