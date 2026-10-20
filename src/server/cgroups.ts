import path from "node:path";

export interface CgroupPath { directory: string; mountPoint: string; v2: boolean }

/** Resolve the current process's controller in both private and host cgroup namespaces. */
export function cgroupPaths(groups: string, mounts: string, controller: "memory" | "cpu" | "cpuacct"): CgroupPath[] {
  const memberships = groups.split("\n").flatMap((line) => {
    const match = line.match(/^\d+:([^:]*):(\/.*)$/);
    return match && (!match[1] || match[1].split(",").includes(controller))
      ? [{ group: path.posix.normalize(match[2]), v2: !match[1] }] : [];
  });
  const paths: CgroupPath[] = [];
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of mounts.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right) continue;
    const fields = left.split(" ");
    const [kind, , options = ""] = right.split(" ");
    if (kind !== "cgroup2" && !(kind === "cgroup" && options.split(",").includes(controller))) continue;
    if (!fields[3] || !fields[4]) continue;
    const root = unescape(fields[3]);
    const mountPoint = unescape(fields[4]);
    for (const membership of memberships.filter((entry) => entry.v2 === (kind === "cgroup2"))) {
      const relative = path.posix.relative(root, membership.group);
      if (relative === ".." || relative.startsWith("../")) continue;
      paths.push({ directory: path.posix.join(mountPoint, relative), mountPoint, v2: membership.v2 });
    }
  }
  return paths.length ? paths : [
    { directory: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup", v2: true },
    { directory: `/sys/fs/cgroup/${controller}`, mountPoint: `/sys/fs/cgroup/${controller}`, v2: false },
    ...(controller === "memory" ? [] : [{ directory: "/sys/fs/cgroup/cpu,cpuacct", mountPoint: "/sys/fs/cgroup/cpu,cpuacct", v2: false }])
  ];
}
