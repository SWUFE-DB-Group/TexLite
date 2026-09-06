import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2, Clock3, FileClock, FileCode2, FileText, GitCommitHorizontal, HardDrive,
  LoaderCircle, Maximize2, Minimize2, Minus, Plus, RotateCcw, Save, Tag, Trash2
} from "lucide-react";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import { formatCommitTime, formatVersionTitle, generateUnifiedDiff } from "./diff";
import type { HistoryPage, HistoryStats, HistoryVersion, HistoryVersionDetail, Project } from "./types";

interface HistoryComparison {
  path: string;
  historical: string;
  comparison: string;
  against: string;
  previousVersion: HistoryVersion | null;
}

const HISTORY_PAGE_SIZE = 100;

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
  const [diffMode, setDiffMode] = useState<"commit" | "current">("commit");
  const [diffFontSize, setDiffFontSize] = useState(11);
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  const [label, setLabel] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<"project" | string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HistoryVersion | "all" | null>(null);
  const [busy, setBusy] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const diffSectionRef = useRef<HTMLDivElement>(null);
  const olderPageAbortRef = useRef<AbortController | null>(null);
  const retentionRefreshRef = useRef<number | null>(null);

  const canRestore = project.permission !== "read";
  const isOwner = project.permission === "owner";
  const controlsBusy = Boolean(busy) || loadingOlder;

  useEffect(() => {
    if (!open) {
      if (retentionRefreshRef.current !== null) window.clearTimeout(retentionRefreshRef.current);
      retentionRefreshRef.current = null;
      olderPageAbortRef.current?.abort();
      olderPageAbortRef.current = null;
      setLoadingOlder(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setDiffFullscreen(false);
      return;
    }
    olderPageAbortRef.current?.abort();
    olderPageAbortRef.current = null;
    const controller = new AbortController();
    setBusy("load"); setError(""); setComparison(null); setNextCursor(null); setLoadingOlder(false);
    void api<HistoryPage>(`/api/projects/${project.id}/history?limit=${HISTORY_PAGE_SIZE}`, { signal: controller.signal })
      .then((result) => {
        setVersions(result.versions);
        setStats(result.stats);
        setNextCursor(result.nextCursor);
        setSelectedId((current) => result.versions.some((version) => version.id === current) ? current : result.versions[0]?.id ?? "");
      })
      .catch((reason) => { if (!isAbort(reason)) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => controller.abort();
  }, [open, project.id]);

  useEffect(() => () => {
    olderPageAbortRef.current?.abort();
    olderPageAbortRef.current = null;
    if (retentionRefreshRef.current !== null) window.clearTimeout(retentionRefreshRef.current);
  }, [project.id]);

  const loadOlder = async () => {
    const cursor = nextCursor;
    if (!cursor || loadingOlder || busy) return;
    olderPageAbortRef.current?.abort();
    const controller = new AbortController();
    olderPageAbortRef.current = controller;
    setLoadingOlder(true); setError("");
    try {
      const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE), before: cursor });
      const result = await api<HistoryPage>(`/api/projects/${project.id}/history?${query.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setVersions((current) => {
        const loaded = new Set(current.map((version) => version.id));
        return [...current, ...result.versions.filter((version) => !loaded.has(version.id))];
      });
      setStats(result.stats);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      if (!isAbort(reason)) setError(message(reason));
    } finally {
      if (olderPageAbortRef.current === controller) {
        olderPageAbortRef.current = null;
        setLoadingOlder(false);
      }
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => setDiffFullscreen(document.fullscreenElement === diffSectionRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!diffFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) setDiffFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffFullscreen]);

  useEffect(() => {
    if (!open || !selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setBusy("detail"); setComparison(null);
    void api<HistoryVersionDetail>(`/api/projects/${project.id}/history/${selectedId}`, { signal: controller.signal }).then((result) => {
      setDetail(result);
      setLabel(result.version.label ?? "");
      const preferred = result.version.changedPaths.find((filePath) => result.files.some((file) => file.path === filePath)) ?? "";
      setSelectedPath(preferred);
    }).catch((reason) => { if (!isAbort(reason)) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => controller.abort();
  }, [open, project.id, selectedId]);

  const previousVersion = comparison?.previousVersion ?? null;

  useEffect(() => {
    if (!open || !selectedId || !selectedPath) {
      setComparison(null);
      return;
    }
    const controller = new AbortController();
    setBusy("compare");
    setError("");
    const againstParam = diffMode === "commit"
      ? "&against=__previous__"
      : "";
    void api<HistoryComparison>(
      `/api/projects/${project.id}/history/${selectedId}/file?path=${encodeURIComponent(selectedPath)}${againstParam}`,
      { signal: controller.signal }
    )
      .then((res) => {
        setComparison(res);
      })
      .catch((reason) => {
        if (!isAbort(reason)) setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy((current) => (current === "compare" ? "" : current));
      });
    return () => controller.abort();
  }, [open, project.id, selectedId, selectedPath, diffMode]);

  const changedFiles = useMemo(() => {
    if (!detail) return [];
    const set = new Set(detail.version.changedPaths);
    return detail.files.filter((file) => set.has(file.path));
  }, [detail]);

  useEffect(() => {
    if (changedFiles.length > 0 && !changedFiles.some((f) => f.path === selectedPath)) {
      setSelectedPath(changedFiles[0].path);
    } else if (changedFiles.length === 0 && selectedPath) {
      setSelectedPath("");
    }
  }, [changedFiles, selectedPath]);

  const toggleDiffFullscreen = async () => {
    if (diffFullscreen) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setDiffFullscreen(false);
      return;
    }
    const section = diffSectionRef.current;
    if (section?.requestFullscreen) {
      try { await section.requestFullscreen(); } catch { /* Fall back to CSS */ }
    }
    setDiffFullscreen(true);
  };

  const saveLabel = async () => {
    if (!detail) return;
    setBusy("label"); setError("");
    try {
      const result = await api<{ version: HistoryVersion; retentionScheduled: boolean; retentionRefreshAfterMs: number; stats: HistoryStats | null }>(`/api/projects/${project.id}/history/${detail.version.id}`, {
        method: "PATCH", body: JSON.stringify({ label: label.trim() || null })
      });
      setDetail((current) => current ? { ...current, version: result.version } : current);
      setVersions((current) => current.map((version) => version.id === result.version.id ? result.version : version));
      setStats(result.stats);
      if (result.retentionScheduled) {
        if (retentionRefreshRef.current !== null) window.clearTimeout(retentionRefreshRef.current);
        retentionRefreshRef.current = window.setTimeout(() => {
          retentionRefreshRef.current = null;
          void api<HistoryPage>(`/api/projects/${project.id}/history?limit=1`).then((page) => {
            // Retention runs asynchronously. Refresh only capacity here so a
            // delayed cleanup never discards the user's loaded pages or moves
            // them away from the snapshot they chose to inspect.
            setStats(page.stats);
          }).catch(() => undefined);
        }, result.retentionRefreshAfterMs);
      }
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
        setVersions([]); setSelectedId(""); setDetail(null); setComparison(null); setNextCursor(null);
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

  const authorName = detail?.version.author?.name
    || detail?.version.author?.username
    || (detail?.version.reason === "autosave" ? t("history.reasons.autosave") : t("editor.deletedUser"));

  const commitTime = detail ? formatCommitTime(detail.version.createdAt, i18n.resolvedLanguage) : "";

  const diffResult = useMemo(() => {
    if (!comparison || !detail) return { diffText: "", additions: 0, deletions: 0, hasChanges: false };
    if (diffMode === "commit") {
      const oldText = comparison.comparison;
      const newText = comparison.historical;
      const oldLabel = previousVersion
        ? `${previousVersion.label || t(`history.reasons.${previousVersion.reason}`)} (${formatCommitTime(previousVersion.createdAt, i18n.resolvedLanguage)})`
        : "/dev/null";
      const newLabel = `${authorName} @ ${commitTime}`;
      return generateUnifiedDiff(comparison.path, oldText, newText, oldLabel, newLabel);
    } else {
      const oldText = comparison.historical;
      const newText = comparison.comparison;
      const oldLabel = `${detail.version.label || t(`history.reasons.${detail.version.reason}`)} (${commitTime})`;
      const newLabel = t("history.currentVersion");
      return generateUnifiedDiff(comparison.path, oldText, newText, oldLabel, newLabel);
    }
  }, [comparison, detail, diffMode, previousVersion, authorName, commitTime, t, i18n.resolvedLanguage]);

  const detailReasonLabel = detail ? t(`history.reasons.${detail.version.reason}`) : "";
  const detailTitle = detail ? formatVersionTitle(detail.version, detailReasonLabel, i18n.resolvedLanguage) : "";

  const deleteTargetName = deleteTarget && deleteTarget !== "all"
    ? formatVersionTitle(deleteTarget, t(`history.reasons.${deleteTarget.reason}`), i18n.resolvedLanguage)
    : "";

  return <><Modal open={open} extraWide draggable className="history-dialog-modal" title={t("history.projectSnapshots")} description={t("history.description")} onOpenChange={onOpenChange}
    footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="history-dialog">
      {error && <p className="error history-message">{error}</p>}
      {busy === "load" && versions.length === 0 ? <div className="history-loading"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div> : <div className="history-dialog-layout">
        <aside className="history-timeline">
          {isOwner && stats && <div className={`history-stats${stats.storageLimitExceeded ? " exceeded" : ""}`}>
            <header><span><HardDrive size={14} />{t("history.storage")}</span><button type="button" disabled={controlsBusy || versions.length === 0} title={t("history.clearAll")} aria-label={t("history.clearAll")} onClick={() => setDeleteTarget("all")}><Trash2 size={13} /></button></header>
            <strong>{t("history.storageUsage", { used: formatBytes(stats.totalBytes), limit: formatBytes(stats.maxStorageBytes) })}</strong>
            <progress max={stats.maxStorageBytes} value={Math.min(stats.totalBytes, stats.maxStorageBytes)} />
            <small>{t("history.storageBreakdown", { objects: formatBytes(stats.objectBytes), metadata: formatBytes(stats.metadataBytes), protected: formatBytes(stats.protectedBytes) })}</small>
            <small>{t("history.versionUsage", { count: stats.ordinaryVersionCount, limit: stats.maxVersions > 0 ? stats.maxVersions : "∞" })}{stats.labeledVersionCount > 0 ? ` · ${t("history.protectedVersions", { count: stats.labeledVersionCount })}` : ""}</small>
            {stats.storageLimitExceeded && <small className="history-storage-warning">{t("history.storageExceeded")}</small>}
          </div>}
          {versions.map((version) => {
            const reasonLabel = t(`history.reasons.${version.reason}`);
            const title = formatVersionTitle(version, reasonLabel, i18n.resolvedLanguage);
            const author = version.author?.name || version.author?.username || (version.reason === "autosave" ? t("history.reasons.autosave") : t("editor.deletedUser"));
            return (
              <button className={version.id === selectedId ? "active" : ""} key={version.id} onClick={() => setSelectedId(version.id)}>
                <FileClock size={15} />
                <span>
                  <div className="history-item-heading">
                    <strong title={title}>{title}</strong>
                    <span className={`history-reason-badge reason-${version.reason}`}>{reasonLabel}</span>
                  </div>
                  <small>{new Date(version.createdAt).toLocaleString(i18n.resolvedLanguage)}</small>
                  <small>{author} · {t("history.changedCount", { count: version.changedPaths.length })}</small>
                </span>
              </button>
            );
          })}
          {nextCursor && <div className="history-load-more">
            <button type="button" disabled={controlsBusy} aria-busy={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? <LoaderCircle className="spin" size={13} /> : <Clock3 size={13} />}
              {loadingOlder ? t("common.loading") : t("history.loadOlder")}
            </button>
          </div>}
          {versions.length === 0 && <p className="muted padded">{t("history.empty")}</p>}
        </aside>
        <section className="history-detail">
          {detail && <>
            <header className="history-detail-header">
              <div>
                <div className="history-detail-title-row">
                  <strong title={detailTitle}>{detailTitle}</strong>
                  <span className={`history-reason-badge reason-${detail.version.reason}`}>{detailReasonLabel}</span>
                </div>
                <small><Clock3 size={12} />{new Date(detail.version.createdAt).toLocaleString(i18n.resolvedLanguage)} · {authorName} · {t("history.fileCount", { count: detail.version.fileCount })}</small>
              </div>
              <span className="history-detail-actions">
                {isOwner && <button className="danger-text" disabled={controlsBusy} onClick={() => setDeleteTarget(detail.version)}><Trash2 size={14} />{t("history.deleteVersion")}</button>}
                {canRestore && <button className="danger-text" disabled={controlsBusy} onClick={() => setRestoreTarget("project")}><RotateCcw size={14} />{t("history.restoreProject")}</button>}
              </span>
            </header>
            {canRestore && <div className="history-label">
              <label><Tag size={14} /><input value={label} maxLength={80} placeholder={t("history.labelPlaceholder")} onChange={(event) => setLabel(event.target.value)} /></label>
              <button disabled={controlsBusy || label.trim() === (detail.version.label ?? "")} onClick={() => void saveLabel()}>{busy === "label" ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}{t("history.saveLabel")}</button>
            </div>}
            <div className="history-files">
              <div className="history-files-toolbar">
                <div className="history-files-heading">
                  <FileCode2 size={13} />
                  <span>{t("history.changedFilesHeading", { count: changedFiles.length })}</span>
                </div>
                <div className="history-file-actions">
                  {canRestore && <button disabled={!selectedPath || controlsBusy} onClick={() => setRestoreTarget(selectedPath)}><RotateCcw size={13} />{t("history.restoreFile")}</button>}
                </div>
              </div>
              {changedFiles.length > 0 ? (
                <div className="history-file-list">{changedFiles.map((file) => (
                  <button type="button" className={file.path === selectedPath ? "active" : ""} key={file.path} title={file.path} onClick={() => setSelectedPath(file.path)}>
                    <FileText size={13} />
                    <span>{file.path}</span>
                  </button>
                ))}</div>
              ) : (
                <p className="muted padded-small">{t("history.noChangedFiles")}</p>
              )}
            </div>
            <div ref={diffSectionRef} className={`history-comparison${diffFullscreen ? " is-fullscreen" : ""}`}>
              {selectedPath ? <>
                <header>
                  <div className="history-comparison-meta">
                    <strong>{selectedPath}</strong>
                    <small className="history-commit-summary">
                      {diffMode === "commit" ? <>
                        <span className="history-commit-author">{authorName}</span>
                        <span>{previousVersion ? t("history.changedAt", { time: commitTime }) : t("history.createdAt", { time: commitTime })}</span>
                      </> : <span>{t("history.comparingCurrent")}</span>}
                      {diffResult.hasChanges && <span className="history-diff-stats"><span className="addition">+{diffResult.additions}</span> <span className="deletion">-{diffResult.deletions}</span></span>}
                    </small>
                  </div>
                  <div className="history-diff-controls">
                    <div className="history-mode-toggle" role="group" aria-label={t("history.diffMode")}>
                      <button
                        type="button"
                        className={diffMode === "commit" ? "active" : ""}
                        onClick={() => setDiffMode("commit")}
                        title={t("history.diffModeCommitHint")}
                      >
                        <GitCommitHorizontal size={13} />
                        <span>{t("history.diffModeCommit")}</span>
                      </button>
                      <button
                        type="button"
                        className={diffMode === "current" ? "active" : ""}
                        onClick={() => setDiffMode("current")}
                        title={t("history.diffModeCurrentHint")}
                      >
                        <FileClock size={13} />
                        <span>{t("history.diffModeCurrent")}</span>
                      </button>
                    </div>
                    <div className="git-diff-font-controls" role="group" aria-label={t("git.diffFontSize")}>
                      <button type="button" className="git-diff-font-button" disabled={diffFontSize <= 8} title={t("git.diffFontDecrease")} aria-label={t("git.diffFontDecrease")} onClick={() => setDiffFontSize((current) => Math.max(8, current - 1))}><Minus size={14} /></button>
                      <span className="git-diff-font-value" aria-live="polite">{diffFontSize}px</span>
                      <button type="button" className="git-diff-font-button" disabled={diffFontSize >= 24} title={t("git.diffFontIncrease")} aria-label={t("git.diffFontIncrease")} onClick={() => setDiffFontSize((current) => Math.min(24, current + 1))}><Plus size={14} /></button>
                    </div>
                    <button type="button" className="git-diff-fullscreen" title={diffFullscreen ? t("git.exitFullscreenDiff") : t("git.fullscreenDiff")} aria-label={diffFullscreen ? t("git.exitFullscreenDiff") : t("git.fullscreenDiff")} onClick={() => void toggleDiffFullscreen()}>{diffFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
                  </div>
                </header>
                {busy === "compare" && !comparison ? <div className="history-comparison-empty"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div>
                  : !diffResult.hasChanges ? <div className="git-diff-empty history-diff-empty"><CheckCircle2 size={24} /><span>{diffMode === "commit" ? t("history.noDifferencesInCommit") : t("history.noDifferences")}</span></div>
                    : <pre className="git-diff history-git-diff" style={{ fontSize: `${diffFontSize}px` }}>{diffResult.diffText.split("\n").map((line, index) => {
                      const tone = line.startsWith("+") && !line.startsWith("+++") ? "addition"
                        : line.startsWith("-") && !line.startsWith("---") ? "deletion"
                          : line.startsWith("@@") ? "hunk"
                            : line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") ? "header" : "";
                      return <span className={tone} key={index}>{line}{"\n"}</span>;
                    })}</pre>}
              </> : <div className="history-comparison-empty"><FileClock size={25} /><span>{changedFiles.length === 0 ? t("history.noChangedFiles") : t("history.chooseFile")}</span></div>}
            </div>
          </>}
        </section>
      </div>}
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
