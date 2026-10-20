import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { cgroupPaths } from "./cgroups.js";
import type { CpuUsageSample } from "../shared/resourceMetrics.js";

export interface CpuProcessCounter { pid: number; started: string; time: number }
export interface CpuSnapshot {
  scope: "host" | "container";
  at: number;
  hostCores: number;
  capacityCores: number;
  hostTotal: number;
  hostIdle: number;
  linuxTicks: number | null;
  containerUsageUs: number | null;
  serviceUs: number;
  tex: CpuProcessCounter[] | null;
}

type ReadText = (file: string) => Promise<string>;

/** Counters, not load averages or lifetime-average ps percentages. */
export async function collectCpuSnapshot(
  scope: CpuSnapshot["scope"], tex: CpuProcessCounter[] | null,
  platform = process.platform, read: ReadText = (file) => readFile(file, "utf8")
): Promise<CpuSnapshot | null> {
  try {
    const cpus = os.cpus();
    if (!cpus.length) return null;
    const optional = (file: string) => read(file).catch(() => null);
    let hostTotal = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((sum, time) => sum + time, 0), 0);
    let hostIdle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    let linuxTicks: number | null = null;
    let capacityCores = cpus.length;
    let containerUsageUs: number | null = null;
    if (platform === "linux") {
      const stat = await read("/proc/stat");
      const values = stat.match(/^cpu[ \t]+([\d \t]+)$/m)?.[1].trim().split(/\s+/).map(Number);
      if (!values || values.length < 4) return null;
      // guest/guest_nice are already included in user/nice; don't add them twice.
      hostTotal = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
      hostIdle = values[3] + (values[4] ?? 0); // Idle and I/O wait are not executing work.
      linuxTicks = hostTotal;
      if (scope === "container") {
        const [groups, mounts] = await Promise.all([optional("/proc/self/cgroup"), optional("/proc/self/mountinfo")]);
        capacityCores = Math.min(cpus.length, os.availableParallelism());
        for (const entry of cgroupPaths(groups ?? "", mounts ?? "", "cpuacct")) {
          const usage = await optional(`${entry.directory}/${entry.v2 ? "cpu.stat" : "cpuacct.usage"}`);
          const value = entry.v2 ? usage?.match(/^usage_usec\s+(\d+)$/m)?.[1] : usage?.trim();
          if (value && /^\d+$/.test(value)) { containerUsageUs = Number(value) / (entry.v2 ? 1 : 1_000); break; }
        }
        if (containerUsageUs === null) return null;
        for (const entry of cgroupPaths(groups ?? "", mounts ?? "", "cpu")) {
          for (let current = entry.directory; ; current = path.posix.dirname(current)) {
            let quota: number;
            let period: number;
            if (entry.v2) {
              const fields = (await optional(`${current}/cpu.max`))?.trim().split(/\s+/);
              quota = Number(fields?.[0]); period = Number(fields?.[1]);
            } else {
              const fields = await Promise.all([optional(`${current}/cpu.cfs_quota_us`), optional(`${current}/cpu.cfs_period_us`)]);
              quota = Number(fields[0]); period = Number(fields[1]);
            }
            if (Number.isFinite(quota) && quota > 0 && period > 0) capacityCores = Math.min(capacityCores, quota / period);
            if (current === entry.mountPoint || current === "/") break;
          }
        }
      }
    } else if (scope === "container") return null;
    const service = process.cpuUsage();
    return { scope, at: performance.now(), hostCores: cpus.length, capacityCores, hostTotal, hostIdle, linuxTicks,
      containerUsageUs, serviceUs: service.user + service.system, tex };
  } catch { return null; }
}

/** One baseline per server, shared by administrators; idle gaps start a fresh window. */
export class CpuMetrics {
  private previous: CpuSnapshot | null = null;

  update(current: CpuSnapshot | null, scope: CpuUsageSample["scope"]): CpuUsageSample {
    const empty = (status: "warming" | "unavailable"): CpuUsageSample => ({ scope, status, texlitePercent: null, otherPercent: null, idlePercent: null });
    const previous = this.previous;
    this.previous = current;
    if (!current || current.tex === null) return empty("unavailable");
    const elapsed = previous ? current.at - previous.at : 0;
    if (!previous || previous.tex === null || elapsed < 500 || elapsed > 15_000 || current.scope !== previous.scope
      || current.capacityCores !== previous.capacityCores || current.hostCores !== previous.hostCores) return empty("warming");
    const hostDelta = current.hostTotal - previous.hostTotal;
    const idleDelta = current.hostIdle - previous.hostIdle;
    const serviceDelta = current.serviceUs - previous.serviceUs;
    if (hostDelta <= 0 || idleDelta < 0 || serviceDelta < 0 || current.capacityCores <= 0) return empty("unavailable");
    const oldProcesses = new Map(previous.tex.map((process) => [`${process.pid}:${process.started}`, process.time]));
    let texDelta = 0;
    for (const process of current.tex) {
      const delta = process.time - (oldProcesses.get(`${process.pid}:${process.started}`) ?? 0);
      if (delta < 0 || !Number.isFinite(delta)) return empty("unavailable");
      texDelta += delta;
    }
    const capacityUs = elapsed * 1_000 * current.capacityCores;
    let texPercent: number;
    if (current.linuxTicks !== null && previous.linuxTicks !== null) {
      const ticks = current.linuxTicks - previous.linuxTicks;
      if (ticks <= 0) return empty("unavailable");
      texPercent = texDelta / ticks * current.hostCores / current.capacityCores * 100;
    } else texPercent = texDelta / capacityUs * 100;
    let busy = (hostDelta - idleDelta) / hostDelta * 100;
    if (scope === "container") {
      if (current.containerUsageUs === null || previous.containerUsageUs === null || current.containerUsageUs < previous.containerUsageUs) return empty("unavailable");
      busy = (current.containerUsageUs - previous.containerUsageUs) / capacityUs * 100;
    }
    busy = Math.max(0, Math.min(100, busy));
    // Partition integer tenths before formatting; independently rounded shares
    // can otherwise add up to 100.1% at half-way boundaries.
    const busyTenths = Math.round(busy * 10);
    const texliteTenths = Math.min(busyTenths, Math.round(Math.min(busy, texPercent + serviceDelta / capacityUs * 100) * 10));
    return { scope, status: "ready", texlitePercent: texliteTenths / 10,
      idlePercent: (1_000 - busyTenths) / 10, otherPercent: (busyTenths - texliteTenths) / 10 };
  }
}
