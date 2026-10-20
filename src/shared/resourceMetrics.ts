/** Current samples, not peaks. Process RSS is an estimate and may count shared pages twice. */
export interface SystemMemorySample {
  scope: "host" | "container";
  usedBytes: number | null;
  /** Physical capacity on a host; effective visible memory limit in a container. */
  totalBytes: number | null;
}

export interface TexMemorySample {
  rssBytes: number | null;
  processCount: number | null;
}

export interface ResourceMemorySample {
  systemMemory: SystemMemorySample;
  texMemory: TexMemorySample;
}

export interface CpuUsageSample {
  scope: "host" | "container";
  status: "warming" | "ready" | "unavailable";
  texlitePercent: number | null;
  otherPercent: number | null;
  idlePercent: number | null;
}

export interface ResourceSample extends ResourceMemorySample {
  cpu: CpuUsageSample;
}
