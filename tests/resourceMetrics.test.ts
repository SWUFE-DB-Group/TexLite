import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { collectTexResources, isTexProcess, parsePosixProcesses, parseWindowsProcesses, ResourceMetrics, sumTexMemory } from "../src/server/resourceMetrics.js";
import { collectSystemMemory } from "../src/server/systemMemory.js";
import type { ResourceSample } from "../src/shared/resourceMetrics.js";

const KiB = 1024;
const MiB = KiB ** 2;
function files(values: Record<string, string>) {
  return vi.fn(async (file: string) => {
    if (!(file in values)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return values[file];
  });
}

describe("TeX process memory", () => {
  it("matches tool names rather than substrings and recognizes Perl-hosted latexmk", () => {
    for (const name of ["pdflatex", "/usr/bin/xelatex", "luahbtex", "biber.exe", "MiKTeX-pdftex.exe", "makeindex", "chktex", "texcount", "harper-cli", "/usr/local/bin/harper-cli", "C:\\Tools\\harper-cli.exe"]) {
      expect(isTexProcess({ pid: 1, name, rssBytes: 1 }), name).toBe(true);
    }
    for (const name of ["textedit", "context-menu", "texlite", "node", "perl", "pdflatex-backup", "harper-ls", "harper-cli-backup"]) {
      expect(isTexProcess({ pid: 1, name, rssBytes: 1 }), name).toBe(false);
    }
    expect(isTexProcess({ pid: 1, name: "perl", rssBytes: 1, argv: ["perl", "-w", "/usr/bin/latexmk", "main.tex"] })).toBe(true);
    expect(isTexProcess({ pid: 1, name: "perl", rssBytes: 1, argv: ["perl", "-I", "/lib", "C:\\Program Files\\TeX\\latexmk.pl"] })).toBe(true);
    for (const argv of [["perl", "unrelated.pl", "latexmk"], ["perl", "-e", "latexmk"], ["perl", "-M", "latexmk", "other.pl"]]) {
      expect(isTexProcess({ pid: 1, name: "perl", rssBytes: 1, argv })).toBe(false);
    }
  });

  it("deduplicates PIDs, preserves missing measurements and uses zero only for an empty sample", () => {
    const process = { pid: 1, name: "pdflatex", rssBytes: 32 * MiB };
    expect(sumTexMemory([process, process, { pid: 2, name: "node", rssBytes: MiB }])).toEqual({ rssBytes: 32 * MiB, processCount: 1 });
    expect(sumTexMemory([{ ...process, rssBytes: null }])).toEqual({ rssBytes: null, processCount: null });
    expect(sumTexMemory([])).toEqual({ rssBytes: 0, processCount: 0 });
  });

  it("samples Linux engines and Perl scripts without relying on ps being installed", async () => {
    const read = files({
      "/proc/10/status": "Name:\tpdflatex\nState:\tS (sleeping)\nVmRSS:\t120 kB\n",
      "/proc/11/status": "Name:\tperl\nVmRSS:\t20 kB\n", "/proc/11/cmdline": "perl\0/usr/bin/latexmk\0main.tex\0",
      "/proc/12/status": "Name:\tnode\nVmRSS:\t900 kB\n",
      "/proc/13/status": "Name:\tpdflatex\nState:\tZ (zombie)\n"
    });
    const command = vi.fn(async () => "");
    expect((await collectTexResources("linux", { read, command, directories: async () => ["self", "10", "11", "12", "13", "99"] })).memory)
      .toEqual({ rssBytes: 140 * KiB, processCount: 2 });
    expect(command).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalledWith("/proc/12/cmdline");
  });

  it("parses macOS ps values as KiB and resolves the Perl script separately", async () => {
    const command = vi.fn(async (_file: string, args: string[]) => args.includes("-p")
      ? '11 /usr/bin/perl "/Applications/TeX Live/latexmk.pl" main.tex\n'
      : "10 120 /Library/TeX/texbin/pdflatex\n11 20 /usr/bin/perl\n12 999 /usr/bin/node\n");
    const io = { read: files({}), directories: async () => [], command };
    expect((await collectTexResources("darwin", io)).memory).toEqual({ rssBytes: 140 * KiB, processCount: 2 });
    expect(command.mock.calls[0]).toEqual(["ps", ["-ww", "-axo", "pid=,rss=,time=,lstart=,comm="]]);
    expect(parsePosixProcesses("1 120 /Applications/TeX Live/pdftex\n")[0].name).toBe("/Applications/TeX Live/pdftex");
    expect(() => parsePosixProcesses("invalid output")).toThrow();
  });

  it("parses Windows CIM byte values, single-record JSON, BOMs and quoted paths", async () => {
    const record = { ProcessId: 12, Name: "perl.exe", WorkingSetSize: "20480", CommandLine: '"C:\\Program Files\\Perl\\perl.exe" "C:\\Program Files\\TeX\\latexmk.pl" main.tex' };
    const command = vi.fn(async (_file: string, _args: string[]) => `\uFEFF${JSON.stringify(record)}`);
    const io = { read: files({}), directories: async () => [], command };
    expect((await collectTexResources("win32", io)).memory).toEqual({ rssBytes: 20480, processCount: 1 });
    expect(command.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(sumTexMemory(parseWindowsProcesses(JSON.stringify([record, { ProcessId: 13, Name: "pdflatex.exe", WorkingSetSize: 4096 }]))))
      .toEqual({ rssBytes: 24576, processCount: 2 });
    expect(sumTexMemory(parseWindowsProcesses('{"ProcessId":13,"Name":"pdflatex.exe","WorkingSetSize":null}')).rssBytes).toBeNull();
  });

  it("degrades to unavailable when OS facilities are missing, invalid or unsupported", async () => {
    const failed = async (): Promise<never> => { throw new Error("unavailable"); };
    const io = { read: failed, directories: failed, command: failed };
    for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
      expect((await collectTexResources(platform, io)).memory).toEqual({ rssBytes: null, processCount: null });
    }
    expect((await collectTexResources("win32", { ...io, command: async () => "not JSON" })).memory).toEqual({ rssBytes: null, processCount: null });
  });

  it.skipIf(process.platform !== "linux")("includes a visible TeX-named process not started by the compiler", async () => {
    const child = spawn(process.execPath, ["-e", 'process.title = "pdflatex"; process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const { memory: sample } = await collectTexResources();
      expect(sample.processCount).toBeGreaterThanOrEqual(1);
      expect(sample.rssBytes).toBeGreaterThan(MiB);
    } finally {
      child.kill();
      await once(child, "close");
    }
  });
});

describe("host and container memory", () => {
  it("does not probe Linux files on macOS or Windows", async () => {
    const read = files({});
    for (const platform of ["darwin", "win32"] as const) {
      const sample = await collectSystemMemory(platform, read);
      expect(sample.scope).toBe("host");
      expect(sample.totalBytes).toBeGreaterThan(0);
      expect(sample.usedBytes).toBeGreaterThanOrEqual(0);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("uses available memory instead of counting Linux reclaimable cache as occupied", async () => {
    const read = files({ "/proc/meminfo": "MemAvailable:     1234 kB\n" });
    const sample = await collectSystemMemory("linux", read);
    expect(sample.usedBytes).toBe(sample.totalBytes! - 1234 * KiB);
  });

  it("reads namespaced cgroup v2 usage and limit", async () => {
    const sample = await collectSystemMemory("linux", files({
      "/.dockerenv": "", "/proc/self/cgroup": "0::/\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n",
      "/sys/fs/cgroup/memory.current": String(40 * MiB), "/sys/fs/cgroup/memory.max": String(128 * MiB)
    }));
    expect(sample).toEqual({ scope: "container", usedBytes: 40 * MiB, totalBytes: 128 * MiB });
  });

  it("resolves a host-visible cgroup hierarchy and respects a tighter parent limit", async () => {
    const sample = await collectSystemMemory("linux", files({
      "/proc/self/cgroup": "0::/docker/container/app\n",
      "/proc/self/mountinfo": "1 0 0:1 /docker /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
      "/sys/fs/cgroup/container/app/memory.current": String(20 * MiB),
      "/sys/fs/cgroup/container/app/memory.max": "max\n",
      "/sys/fs/cgroup/container/memory.max": String(128 * MiB),
      "/sys/fs/cgroup/memory.max": String(256 * MiB)
    }));
    expect(sample).toEqual({ scope: "container", usedBytes: 20 * MiB, totalBytes: 128 * MiB });
  });

  it("supports cgroup v1 and preserves unreported limits rather than substituting host capacity", async () => {
    const base = {
      "/run/.containerenv": "", "/proc/self/cgroup": "4:cpu:/\n5:memory:/\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(40 * MiB)
    };
    expect(await collectSystemMemory("linux", files({ ...base, "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(128 * MiB) })))
      .toEqual({ scope: "container", usedBytes: 40 * MiB, totalBytes: 128 * MiB });
    expect(await collectSystemMemory("linux", files({ ...base, "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" })))
      .toEqual({ scope: "container", usedBytes: 40 * MiB, totalBytes: null });
    expect(await collectSystemMemory("linux", files({ "/.dockerenv": "" })))
      .toEqual({ scope: "container", usedBytes: null, totalBytes: null });
  });
});

describe("on-demand resource sampling", () => {
  const value: ResourceSample = { systemMemory: { scope: "host", usedBytes: MiB, totalBytes: 10 * MiB }, texMemory: { rssBytes: 0, processCount: 0 },
    cpu: { scope: "host", status: "warming", texlitePercent: null, otherPercent: null, idlePercent: null } };
  it("coalesces concurrent requests, caches briefly and only samples when requested", async () => {
    let now = 0;
    const collect = vi.fn(async () => value);
    const metrics = new ResourceMetrics(collect, () => now);
    expect(collect).not.toHaveBeenCalled();
    const first = metrics.sample();
    expect(metrics.sample()).toBe(first);
    await first;
    expect(await metrics.sample()).toBe(value);
    expect(collect).toHaveBeenCalledTimes(1);
    now = 2000;
    await metrics.sample();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("clears in-flight state after a failure so a later request can retry", async () => {
    const collect = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(value);
    const metrics = new ResourceMetrics(collect);
    await expect(metrics.sample()).rejects.toThrow("failed");
    expect(await metrics.sample()).toBe(value);
  });
});
