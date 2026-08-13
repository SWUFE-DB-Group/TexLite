import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import diff_match_patch from "diff-match-patch";
import { Clock3, FileClock, FileText, HardDrive, LoaderCircle, RotateCcw, Save, Tag, Trash2 } from "lucide-react";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import type { HistoryStats, HistoryVersion, HistoryVersionDetail, Project } from "./types";

interface HistoryComparison {
  path: string;
  historical: string;
  comparison: string;
  against: string;
}

export function HistoryDialog({ open, project, onOpenChange, onBeforeMutation }: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onBeforeMutation: () => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const [versions, setVersions] = useState<HistoryVersion[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<HistoryVersionDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [label, setLabel] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<"project" | string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HistoryVersion | "all" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const canRestore = project.permission !== "read";
  const isOwner = project.permission === "owner";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy("load"); setError(""); setComparison(null);
    void api<{ versions: HistoryVersion[]; stats: HistoryStats | null }>(`/api/projects/${project.id}/history`, { signal: controller.signal })
      .then((result) => {
        setVersions(result.versions);
        setStats(result.stats);
        setSelectedId((current) => result.versions.some((version) => version.id === current) ? current : result.versions[0]?.id ?? "");
      })
      .catch((reason) => { if (!isAbort(reason)) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => controller.abort();
  }, [open, project.id]);

  useEffect(() => {
    if (!open || !selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setBusy("detail"); setComparison(null);
    void api<HistoryVersionDetail>(`/api/projects/${project.id}/history/${selectedId}`, { signal: controller.signal }).then((result) => {
      setDetail(result);
      setLabel(result.version.label ?? "");
      const preferred = result.version.changedPaths.find((filePath) => result.files.some((file) => file.path === filePath))
        ?? result.files[0]?.path ?? "";
      setSelectedPath(preferred);
    }).catch((reason) => { if (!isAbort(reason)) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => controller.abort();
  }, [open, project.id, selectedId]);

  const compare = async (filePath = selectedPath) => {
    if (!filePath) return;
    setBusy("compare"); setError("");
    try {
      setComparison(await api<HistoryComparison>(`/api/projects/${project.id}/history/${selectedId}/file?path=${encodeURIComponent(filePath)}`));
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(""); }
  };

  const saveLabel = async () => {
    if (!detail) return;
    setBusy("label"); setError("");
    try {
      const result = await api<{ version: HistoryVersion; stats: HistoryStats | null }>(`/api/projects/${project.id}/history/${detail.version.id}`, {
        method: "PATCH", body: JSON.stringify({ label: label.trim() || null })
      });
      setDetail((current) => current ? { ...current, version: result.version } : current);
      setVersions((current) => current.map((version) => version.id === result.version.id ? result.version : version));
      setStats(result.stats);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(""); }
  };

  const removeHistory = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null); setBusy("delete"); setError("");
    try {
      if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
      const endpoint = target === "all"
        ? `/api/projects/${project.id}/history`
        : `/api/projects/${project.id}/history/${target.id}`;
      const result = await api<{ ok: true; stats: HistoryStats }>(endpoint, { method: "DELETE" });
      setStats(result.stats);
      if (target === "all") {
        setVersions([]); setSelectedId(""); setDetail(null); setComparison(null);
      } else {
        const remaining = versions.filter((version) => version.id !== target.id);
        setVersions(remaining);
        if (selectedId === target.id) {
          setSelectedId(remaining[0]?.id ?? "");
          setDetail(null); setComparison(null);
        }
      }
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(""); }
  };

  const restore = async () => {
    const target = restoreTarget;
    if (!target || !detail) return;
    setRestoreTarget(null); setBusy("restore"); setError("");
    try {
      if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
      await api(`/api/projects/${project.id}/history/${detail.version.id}/restore`, {
        method: "POST", body: JSON.stringify(target === "project" ? {} : { path: target })
      });
      window.location.reload();
    } catch (reason) { setError(message(reason)); setBusy(""); }
  };

  const diff = useMemo(() => {
    if (!comparison) return [];
    const engine = new diff_match_patch();
    engine.Diff_Timeout = 1;
    const result = engine.diff_main(comparison.historical, comparison.comparison, true);
    engine.diff_cleanupSemantic(result);
    return result;
  }, [comparison]);
  const deleteTargetName = deleteTarget && deleteTarget !== "all"
    ? deleteTarget.label || new Date(deleteTarget.createdAt).toLocaleString(i18n.resolvedLanguage)
    : "";

  return <><Modal open={open} extraWide className="history-dialog-modal" title={t("history.title")} description={t("history.description")} onOpenChange={onOpenChange}
    footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="history-dialog">
      {error && <p className="error history-message">{error}</p>}
      {busy === "load" && versions.length === 0 ? <div className="history-loading"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div> : <>
        <aside className="history-timeline">
          {isOwner && stats && <div className={`history-stats${stats.storageLimitExceeded ? " exceeded" : ""}`}>
            <header><span><HardDrive size={14} />{t("history.storage")}</span><button type="button" disabled={Boolean(busy) || versions.length === 0} title={t("history.clearAll")} aria-label={t("history.clearAll")} onClick={() => setDeleteTarget("all")}><Trash2 size={13} /></button></header>
            <strong>{t("history.storageUsage", { used: formatBytes(stats.objectBytes), limit: formatBytes(stats.maxStorageBytes) })}</strong>
            <progress max={stats.maxStorageBytes} value={Math.min(stats.objectBytes, stats.maxStorageBytes)} />
            <small>{t("history.versionUsage", { count: stats.ordinaryVersionCount, limit: stats.maxVersions })}{stats.labeledVersionCount > 0 ? ` · ${t("history.protectedVersions", { count: stats.labeledVersionCount })}` : ""}</small>
            {stats.storageLimitExceeded && <small className="history-storage-warning">{t("history.storageExceeded")}</small>}
          </div>}
          {versions.map((version) => <button className={version.id === selectedId ? "active" : ""} key={version.id} onClick={() => setSelectedId(version.id)}>
            <FileClock size={15} /><span><strong>{version.label || t(`history.reasons.${version.reason}`)}</strong><small>{new Date(version.createdAt).toLocaleString(i18n.resolvedLanguage)}</small><small>{version.author?.name ?? t("editor.deletedUser")} · {t("history.changedCount", { count: version.changedPaths.length })}</small></span>
          </button>)}
          {versions.length === 0 && <p className="muted padded">{t("history.empty")}</p>}
        </aside>
        <section className="history-detail">
          {detail && <>
            <header className="history-detail-header"><div><strong>{detail.version.label || t(`history.reasons.${detail.version.reason}`)}</strong><small><Clock3 size={12} />{new Date(detail.version.createdAt).toLocaleString(i18n.resolvedLanguage)} · {t("history.fileCount", { count: detail.version.fileCount })}</small></div><span className="history-detail-actions">{isOwner && <button className="danger-text" disabled={Boolean(busy)} onClick={() => setDeleteTarget(detail.version)}><Trash2 size={14} />{t("history.deleteVersion")}</button>}{canRestore && <button className="danger-text" disabled={Boolean(busy)} onClick={() => setRestoreTarget("project")}><RotateCcw size={14} />{t("history.restoreProject")}</button>}</span></header>
            {canRestore && <div className="history-label"><label><Tag size={14} /><input value={label} maxLength={80} placeholder={t("history.labelPlaceholder")} onChange={(event) => setLabel(event.target.value)} /></label><button disabled={busy === "label" || label.trim() === (detail.version.label ?? "")} onClick={() => void saveLabel()}>{busy === "label" ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}{t("history.saveLabel")}</button></div>}
            <div className="history-files">
              <div className="history-file-list">{detail.files.map((file) => {
                const changed = detail.version.changedPaths.includes(file.path);
                return <button className={file.path === selectedPath ? "active" : ""} key={file.path} title={file.path} onClick={() => { setSelectedPath(file.path); setComparison(null); }}><FileText size={13} /><span>{file.path}</span>{changed && <small>{t("history.changed")}</small>}</button>;
              })}</div>
              <div className="history-file-actions"><button disabled={!selectedPath || Boolean(busy)} onClick={() => void compare()}>{busy === "compare" ? <LoaderCircle className="spin" size={13} /> : <FileClock size={13} />}{t("history.compareCurrent")}</button>{canRestore && <button disabled={!selectedPath || Boolean(busy)} onClick={() => setRestoreTarget(selectedPath)}><RotateCcw size={13} />{t("history.restoreFile")}</button>}</div>
            </div>
            <div className="history-comparison">{comparison ? <><header><strong>{comparison.path}</strong><small>{t("history.comparingCurrent")}</small></header><pre>{diff.map(([operation, value], index) => <span className={operation < 0 ? "history-removed" : operation > 0 ? "history-added" : ""} key={index}>{value}</span>)}</pre></> : <div className="history-comparison-empty"><FileClock size={25} /><span>{t("history.chooseFile")}</span></div>}</div>
          </>}
        </section>
      </>}
    </div>
  </Modal><ConfirmDialog open={Boolean(restoreTarget)} title={restoreTarget === "project" ? t("history.restoreProjectTitle") : t("history.restoreFileTitle")}
    description={restoreTarget === "project" ? t("history.restoreProjectDescription") : t("history.restoreFileDescription", { path: restoreTarget ?? "" })}
    confirmLabel={t("history.restore")} danger onCancel={() => setRestoreTarget(null)} onConfirm={() => void restore()} />
    <ConfirmDialog open={Boolean(deleteTarget)} title={deleteTarget === "all" ? t("history.clearAllTitle") : t("history.deleteVersionTitle")}
      description={deleteTarget === "all" ? t("history.clearAllDescription") : t("history.deleteVersionDescription", { name: deleteTargetName })}
      confirmLabel={deleteTarget === "all" ? t("history.clearAll") : t("history.deleteVersion")} danger onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeHistory()} /></>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
  return `${Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10} GB`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isAbort(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}
