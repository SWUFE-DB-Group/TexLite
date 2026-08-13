import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { Modal } from "./Dialog";

interface MetricSummary {
  count: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

interface SystemMetrics {
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  eventLoopDelay: { p50Ms: number; p95Ms: number; maxMs: number };
  compileQueue: { concurrency: number; running: number; pending: number };
  collaboration: { rooms: number; sessions: number; dirtyFiles: number };
  durationsMs: Record<string, MetricSummary>;
}

export function SystemMetricsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(await api<SystemMetrics>("/api/health/metrics"));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("errors.generic"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [open, load]);

  return <Modal open={open} onOpenChange={onOpenChange} wide title={t("metrics.title")} description={t("metrics.description")}
    footer={<button onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />{t("metrics.refresh")}</button>}>
    {error && <p className="error">{error}</p>}
    {!metrics && !error && <p className="muted">{t("common.loading")}</p>}
    {metrics && <div className="system-metrics">
      <div className="metric-summary-grid">
        <MetricCard label={t("metrics.uptime")} value={formatDuration(metrics.uptimeSeconds)} />
        <MetricCard label={t("metrics.memory")} value={`${formatBytes(metrics.memory.rssBytes)} RSS`} detail={`${formatBytes(metrics.memory.heapUsedBytes)} / ${formatBytes(metrics.memory.heapTotalBytes)} ${t("metrics.heap")}`} />
        <MetricCard label={t("metrics.compileQueue")} value={`${metrics.compileQueue.running} / ${metrics.compileQueue.concurrency}`} detail={t("metrics.pending", { count: metrics.compileQueue.pending })} />
        <MetricCard label={t("metrics.collaboration")} value={t("metrics.sessions", { count: metrics.collaboration.sessions })} detail={t("metrics.roomsAndDirty", { rooms: metrics.collaboration.rooms, dirty: metrics.collaboration.dirtyFiles })} />
      </div>
      <section className="metric-section">
        <h3><Activity size={15} />{t("metrics.eventLoop")}</h3>
        <p>{t("metrics.latencySummary", metrics.eventLoopDelay)}</p>
      </section>
      <section className="metric-section">
        <h3>{t("metrics.operationDurations")}</h3>
        {Object.keys(metrics.durationsMs).length === 0 ? <p className="muted">{t("metrics.noSamples")}</p> : <div className="metric-table-wrap"><table className="metric-table">
          <thead><tr><th>{t("metrics.operation")}</th><th>{t("metrics.samples")}</th><th>{t("metrics.last")}</th><th>P50</th><th>P95</th><th>{t("metrics.max")}</th></tr></thead>
          <tbody>{Object.entries(metrics.durationsMs).sort(([left], [right]) => left.localeCompare(right)).map(([name, summary]) => <tr key={name}>
            <td>{operationLabel(name, t)}</td><td>{summary.count}</td><td>{formatMs(summary.last)}</td><td>{formatMs(summary.p50)}</td><td>{formatMs(summary.p95)}</td><td>{formatMs(summary.max)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </div>}
  </Modal>;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
}

function formatBytes(value: number): string {
  return `${Math.round(value / 1024 / 1024 * 10) / 10} MB`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatMs(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}s` : `${Math.round(value * 10) / 10}ms`;
}

function operationLabel(name: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`metrics.operations.${name}`, { defaultValue: name });
}
