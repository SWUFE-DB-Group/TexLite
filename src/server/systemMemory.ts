import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemMemorySample } from "../shared/resourceMetrics.js";
import { cgroupPaths } from "./cgroups.js";

type ReadText = (file: string) => Promise<string>;
const readText: ReadText = (file) => readFile(file, "utf8");

/** Linux containers expose their own cgroup, not the Docker daemon or host socket. */
export async function collectSystemMemory(platform = process.platform, read: ReadText = readText): Promise<SystemMemorySample> {
  const total = os.totalmem();
  const fallback = { scope: "host" as const, totalBytes: total, usedBytes: Math.max(0, total - os.freemem()) };
  if (platform !== "linux") return fallback;
  const optional = (file: string) => read(file).catch(() => null);
  const [groups, mounts, docker, podman] = await Promise.all([
    optional("/proc/self/cgroup"), optional("/proc/self/mountinfo"), optional("/.dockerenv"), optional("/run/.containerenv")
  ]);
  const container = docker !== null || podman !== null || /(?:docker|kubepods|libpod|containerd)/.test(groups ?? "");
  if (!container) {
    const info = await optional("/proc/meminfo");
    const available = info?.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (available) fallback.usedBytes = Math.max(0, total - Number(available[1]) * 1024);
    return fallback;
  }

  const candidates = cgroupPaths(groups ?? "", mounts ?? "", "memory");
  for (const { directory, mountPoint, v2 } of candidates) {
    const usage = await optional(`${directory}/${v2 ? "memory.current" : "memory.usage_in_bytes"}`);
    const usedBytes = memoryNumber(usage);
    if (usedBytes === null) continue;
    // A parent cgroup can impose a tighter limit than the container's own entry.
    let totalBytes: number | null = null;
    for (let current = directory; ; current = path.posix.dirname(current)) {
      const raw = await optional(`${current}/${v2 ? "memory.max" : "memory.limit_in_bytes"}`);
      const limit = memoryNumber(raw);
      // cgroup v1 uses a huge sentinel for an unlimited group; v2 uses "max".
      if (limit !== null && limit > 0 && limit < 2 ** 60) totalBytes = Math.min(totalBytes ?? total, limit, total);
      if (current === mountPoint || current === "/") break;
    }
    return { scope: "container", usedBytes, totalBytes };
  }
  // Never label host-wide usage as container usage when cgroup access is unavailable.
  return { scope: "container", usedBytes: null, totalBytes: null };
}

function memoryNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
}

