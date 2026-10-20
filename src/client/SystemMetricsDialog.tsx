import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Clock3, Cpu, Layers3, MemoryStick, RefreshCw, Timer, Users, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { Modal } from "./Dialog";
import type { CpuUsageSample, ResourceSample } from "../shared/resourceMetrics";

interface MetricSummary {
  count: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

interface SystemMetrics extends ResourceSample {
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  eventLoopDelay: { p50Ms: number; p95Ms: number; maxMs: number };
  compileQueue: { concurrency: number; running: number; pending: number };
  collaboration: { rooms: number; sessions: number; dirtyFiles: number };
  durationsMs: Record<string, MetricSummary>;
}

export function SystemMetricsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setMetrics(await api<SystemMetrics>("/api/health/metrics"));
      setUpdatedAt(new Date());
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("errors.generic"));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [open, load]);

  return <Modal open={open} onOpenChange={onOpenChange} extraWide className="system-metrics-dialog" title={t("metrics.title")} description={t("metrics.description")}
    footer={<>
      <span className="metric-refresh-status">{updatedAt ? t("metrics.updatedAt", { time: updatedAt.toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }) : t("metrics.autoRefresh")}</span>
      <button onClick={() => void load()} disabled={loading}><RefreshCw aria-hidden="true" size={14} className={loading ? "spin" : ""} />{t("metrics.refresh")}</button>
    </>}>
    {error && <p className="error">{error}</p>}
    {!metrics && !error && <p className="muted">{t("common.loading")}</p>}
    {metrics && <div className="system-metrics">
      <div className="metric-resource-panels">
        <section className="metric-section">
          <h3><MemoryStick aria-hidden="true" size={16} />{t(metrics.systemMemory.scope === "container" ? "metrics.containerMemory" : "metrics.hostMemory")}</h3>
          <MemoryOverview metrics={metrics} />
          <p className="muted metric-memory-note">{t("metrics.memoryNote")}</p>
        </section>
        <section className="metric-section">
          <h3><Cpu aria-hidden="true" size={16} />{t(metrics.cpu.scope === "container" ? "metrics.containerCpu" : "metrics.hostCpu")}</h3>
          <CpuOverview cpu={metrics.cpu} />
          <p className="muted metric-memory-note">{t("metrics.cpuNote")}</p>
        </section>
      </div>
      <div className="metric-runtime">
        <RuntimeMetric icon={Clock3} label={t("metrics.uptime")} value={formatDuration(metrics.uptimeSeconds)} />
        <RuntimeMetric icon={Layers3} label={t("metrics.compileQueue")} value={`${metrics.compileQueue.running} / ${metrics.compileQueue.concurrency}`} detail={t("metrics.pending", { count: metrics.compileQueue.pending })} />
        <RuntimeMetric icon={Users} label={t("metrics.collaboration")} value={t("metrics.sessions", { count: metrics.collaboration.sessions })} detail={t("metrics.roomsAndDirty", { rooms: metrics.collaboration.rooms, dirty: metrics.collaboration.dirtyFiles })} />
      </div>
      <section className="metric-section metric-latency">
        <h3><Activity aria-hidden="true" size={16} />{t("metrics.eventLoop")}</h3>
        <dl aria-label={t("metrics.latencySummary", metrics.eventLoopDelay)}>
          <div><dt>P50</dt><dd>{formatMs(metrics.eventLoopDelay.p50Ms)}</dd></div>
          <div><dt>P95</dt><dd>{formatMs(metrics.eventLoopDelay.p95Ms)}</dd></div>
          <div><dt>{t("metrics.max")}</dt><dd>{formatMs(metrics.eventLoopDelay.maxMs)}</dd></div>
        </dl>
      </section>
      <section className="metric-section">
        <h3><Timer aria-hidden="true" size={16} />{t("metrics.operationDurations")}</h3>
        {Object.keys(metrics.durationsMs).length === 0 ? <p className="metric-empty">{t("metrics.noSamples")}</p> : <div className="metric-table-wrap"><table className="metric-table">
          <thead><tr><th>{t("metrics.operation")}</th><th>{t("metrics.samples")}</th><th>{t("metrics.last")}</th><th>P50</th><th>P95</th><th>{t("metrics.max")}</th></tr></thead>
          <tbody>{Object.entries(metrics.durationsMs).sort(([left], [right]) => left.localeCompare(right)).map(([name, summary]) => <tr key={name}>
            <td>{operationLabel(name, t)}</td><td>{summary.count}</td><td>{formatMs(summary.last)}</td><td>{formatMs(summary.p50)}</td><td>{formatMs(summary.p95)}</td><td>{formatMs(summary.max)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </div>}
  </Modal>;
}

function MemoryOverview({ metrics }: { metrics: SystemMetrics }) {
  const { t } = useTranslation();
  const { usedBytes: used, totalBytes: total, scope } = metrics.systemMemory;
  const service = metrics.memory.rssBytes;
  const tex = metrics.texMemory.rssBytes;
  const other = used !== null && tex !== null ? Math.max(0, used - service - tex) : null;
  const free = used !== null && total !== null ? Math.max(0, total - used) : null;
  const denominator = total ?? used;
  // RSS can count shared pages twice. Fit estimated process shares inside the
  // measured used region without inventing negative "other" or free memory.
  const tracked = service + (tex ?? 0);
  const scale = used !== null && tracked > used && tracked > 0 ? used / tracked : 1;
  const segments = [
    { key: "service", bytes: service, plotted: service * scale, label: t("metrics.serviceMemory") },
    { key: "tex", bytes: tex, plotted: (tex ?? 0) * scale, label: t("metrics.texMemory") },
    { key: "other", bytes: other, plotted: used === null ? 0 : Math.max(0, used - tracked * scale), label: t("metrics.otherMemory") },
    ...(total === null ? [] : [{ key: "free", bytes: free, plotted: free ?? 0, label: t("metrics.freeMemory") }])
  ];

  return <div className="metric-resource-overview">
    <div className="metric-resource-heading">
      <div><strong><MemoryValue bytes={used} unavailable={t("metrics.unavailable")} /></strong>{used !== null && <span>{t("metrics.usedMemory")}</span>}</div>
      <span>{total === null ? t("metrics.noReportedLimit") : t(scope === "container" ? "metrics.memoryLimit" : "metrics.memoryCapacity", { total: formatBytes(total) })}</span>
    </div>
    {used !== null && denominator !== null && denominator > 0 && <div className="metric-resource-bar" aria-hidden="true">
      {segments.map((segment) => <span key={segment.key} className={`resource-segment-${segment.key}`} style={{ width: `${Math.max(0, Math.min(100, segment.plotted / denominator * 100))}%` }} />)}
    </div>}
    <dl className="metric-resource-legend">
      {segments.map((segment) => <div key={segment.key}>
        <dt><span className={`metric-resource-dot resource-segment-${segment.key}`} aria-hidden="true" />{segment.label}</dt>
        <dd>{segment.bytes === null ? t("metrics.unavailable") : formatBytes(segment.bytes)}</dd>
      </div>)}
    </dl>
  </div>;
}

function CpuOverview({ cpu }: { cpu: CpuUsageSample }) {
  const { t } = useTranslation();
  const segments = [
    { key: "service", value: cpu.texlitePercent, label: t("metrics.texliteCpu") },
    { key: "other", value: cpu.otherPercent, label: t("metrics.otherMemory") },
    { key: "free", value: cpu.idlePercent, label: t("metrics.cpuIdle") }
  ];
  return <div className="metric-resource-overview">
    <div className="metric-resource-heading">
      <div>{cpu.status === "ready" && cpu.idlePercent !== null
        ? <><strong>{Math.round((100 - cpu.idlePercent) * 10) / 10}<span className="metric-value-unit">%</span></strong><span>{t("metrics.usedMemory")}</span></>
        : <span className="metric-unavailable">{t(cpu.status === "warming" ? "metrics.cpuSampling" : "metrics.unavailable")}</span>}</div>
      <span>{t("metrics.cpuCapacity")}</span>
    </div>
    <div className="metric-resource-bar" aria-hidden="true">
      {cpu.status === "ready" && segments.map((segment) => <span key={segment.key} className={`resource-segment-${segment.key}`} style={{ width: `${segment.value ?? 0}%` }} />)}
    </div>
    <dl className="metric-resource-legend">
      {segments.map((segment) => <div key={segment.key}>
        <dt><span className={`metric-resource-dot resource-segment-${segment.key}`} aria-hidden="true" />{segment.label}</dt>
        <dd>{segment.value === null ? "—" : `${segment.value}%`}</dd>
      </div>)}
    </dl>
  </div>;
}

function MemoryValue({ bytes, unavailable }: { bytes: number | null; unavailable?: string }) {
  if (bytes === null) return <span className="metric-unavailable">{unavailable}</span>;
  const [number, unit] = formatBytes(bytes).split(" ");
  return <>{number}<span className="metric-value-unit">{unit}</span></>;
}

function RuntimeMetric({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail?: string }) {
  return <div className="metric-runtime-item">
    <span className="metric-runtime-label"><Icon aria-hidden="true" size={14} />{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </div>;
}

function formatBytes(value: number): string {
  const unit = value >= 1024 ** 3 ? "GB" : "MB";
  return `${Math.round(value / 1024 ** (unit === "GB" ? 3 : 2) * 10) / 10} ${unit}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} m` : `${minutes} m`;
}

function formatMs(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10} s` : `${Math.round(value * 10) / 10} ms`;
}

function operationLabel(name: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`metrics.operations.${name}`, { defaultValue: name });
}
