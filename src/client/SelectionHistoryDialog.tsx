import { useEffect, useMemo, useState } from "react";
import { Clock3, LoaderCircle, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { digest } from "lib0/hash/sha256";
import { ConfirmDialog, Modal } from "./Dialog";
import { generateSelectionHistoryDiff, type SelectionHistoryDiffPiece, type SelectionHistorySemanticDiff } from "./selectionHistoryDiff";
import type { Project, SelectionHistoryAuthor, SelectionHistoryEntry, SelectionHistoryResult } from "./types";

interface SourceSelection {
  selectedText: string;
  startOffset: number;
  endOffset: number;
}

export function SelectionHistoryDialog({ open, project, filePath: inputFilePath, selection: inputSelection, currentSource, onOpenChange }: {
  open: boolean;
  project: Project;
  filePath: string;
  selection: SourceSelection;
  currentSource: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  // Keep the inspected passage fixed while collaborators continue editing.
  const [{ filePath, selection, source }] = useState(() => ({ filePath: inputFilePath, selection: inputSelection, source: currentSource }));
  const [entries, setEntries] = useState<SelectionHistoryEntry[]>([]);
  const [baseline, setBaseline] = useState<SelectionHistoryResult["baseline"]>(null);
  const [hasMore, setHasMore] = useState(false);
  const [chainComplete, setChainComplete] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<{ segmentCount: number; payloadBytes: number; maxStorageBytes: number } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [statsRevision, setStatsRevision] = useState(0);
  useEffect(() => {
    setStats(null);
    if (!open || project.permission !== "owner") return;
    const controller = new AbortController();
    void api<NonNullable<typeof stats>>(`/api/projects/${project.id}/edit-history/stats`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setStats(result); })
      .catch((reason) => { if (!controller.signal.aborted && !isAbort(reason)) setError(message(reason)); });
    return () => controller.abort();
  }, [open, project.id, project.permission, statsRevision]);

  const clearHistory = async () => {
    if (clearing) return;
    setClearing(true); setClearError("");
    try {
      await api(`/api/projects/${project.id}/edit-history`, { method: "DELETE" });
      setEntries([]); setBaseline(null); setHasMore(false); setChainComplete(true);
      setStatsRevision((revision) => revision + 1);
      setClearOpen(false);
    } catch (reason) { setClearError(message(reason)); }
    finally { setClearing(false); }
  };
  const [entryViews, setEntryViews] = useState<Record<string, "content" | "diff">>({});
  const selectedLength = Math.max(0, selection.endOffset - selection.startOffset);

  useEffect(() => {
    if (!open || !filePath || selectedLength <= 0) return;
    const controller = new AbortController();
    setBusy(true); setError(""); setEntries([]); setChainComplete(true); setEntryViews({});
    setBaseline(null); setHasMore(false);
    if (source.slice(selection.startOffset, selection.endOffset) !== selection.selectedText) {
      setError(t("selectionHistory.sourceChanged")); setBusy(false);
      return;
    }
    const params = new URLSearchParams({
      path: filePath,
      start: String(selection.startOffset),
      end: String(selection.endOffset),
      sourceHash: Array.from(digest(new TextEncoder().encode(source)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    });
    void api<SelectionHistoryResult>(`/api/projects/${project.id}/edit-history?${params}`, { signal: controller.signal })
      .then((result) => {
        setEntries(result.entries);
        setChainComplete(result.chainComplete);
        setBaseline(result.baseline);
        setHasMore(result.hasMore);
      })
      .catch((reason) => {
        if (!isAbort(reason)) setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, project.id, filePath, selection, selectedLength, source, t]);

  const description = useMemo(() => t("selectionHistory.description", {
    path: filePath,
    count: selectedLength
  }), [t, filePath, selectedLength]);

  return <Modal open={open} wide draggable className="selection-history-modal" title={t("selectionHistory.title")} description={description} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="selection-history-dialog">
      {project.permission === "owner" && stats && <div className="history-stats">
        <strong>{t("selectionHistory.storageUsage", { used: (stats.payloadBytes / 1048576).toFixed(2), limit: (stats.maxStorageBytes / 1048576).toFixed(0), count: stats.segmentCount })}</strong>
        <small>{t("selectionHistory.storageDescription")}</small>
        <button type="button" className="danger-text" disabled={busy || clearing || stats.segmentCount === 0} onClick={() => { setClearError(""); setClearOpen(true); }}>{t("selectionHistory.clearAll")}</button>
      </div>}
      <ConfirmDialog open={clearOpen} title={t("selectionHistory.clearAll")} description={t("selectionHistory.clearDescription")} confirmLabel={t("common.delete")} danger busy={clearing} error={clearError} onConfirm={() => void clearHistory()} onCancel={() => { if (!clearing) setClearOpen(false); }} />
      {error && <p className="error selection-history-message">{error}</p>}
      {busy ? <div className="selection-history-loading"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div> : <>
        {!chainComplete && <p className="selection-history-boundary">{t("selectionHistory.boundary")}</p>}
        {hasMore && <p className="selection-history-boundary">{t("selectionHistory.limited", { count: entries.length })}</p>}
        {entries.length === 0 && !error
          ? <div className="selection-history-empty"><Clock3 size={28} /><strong>{t("selectionHistory.emptyTitle")}</strong><span>{t("selectionHistory.emptyDescription")}</span></div>
          : <ol className="selection-history-list">{entries.map((entry, index) => {
            const view = entryViews[entry.id] || "content";
            const previous = entries[index + 1] || baseline;
            const canCompare = Boolean(previous
              && entry.content !== null
              && previous.content !== null
              && !entry.contentTruncated
              && !previous.contentTruncated);
            const diff = view === "diff" && canCompare
              ? generateSelectionHistoryDiff(previous!.content!, entry.content!)
              : null;
            const diffMessage = !previous
              ? t("selectionHistory.noPrevious")
              : !canCompare
                ? t("selectionHistory.diffUnavailable")
                : diff && !diff.hasChanges
                  ? t("selectionHistory.noDiff")
                  : null;
            return <li key={entry.id}>
            <article className="selection-history-entry">
              <header>
                <time title={new Date(entry.updatedAt).toLocaleString(i18n.resolvedLanguage)}>{formatTime(entry.updatedAt, i18n.resolvedLanguage)}</time>
                <span className="selection-history-authors"><UserRound size={14} /><span>{t("selectionHistory.changedBy")}</span><span className="selection-history-author-list">{entry.authors.map((author, authorIndex) => <span key={author.id || `deleted-${authorIndex}`}>{authorLabel(author, t("editor.deletedUser"))}</span>)}</span></span>
              </header>
              <div className="selection-history-tabs" role="tablist" aria-label={t("selectionHistory.view")}>
                <button type="button" className={view === "content" ? "active" : ""} role="tab" aria-selected={view === "content"} aria-controls={`selection-history-content-${entry.id}`} onClick={() => setEntryViews((current) => ({ ...current, [entry.id]: "content" }))}>{t("selectionHistory.contentTab")}</button>
                <button type="button" className={view === "diff" ? "active" : ""} role="tab" aria-selected={view === "diff"} aria-controls={`selection-history-diff-${entry.id}`} onClick={() => setEntryViews((current) => ({ ...current, [entry.id]: "diff" }))}>{t("selectionHistory.diffTab")}</button>
              </div>
              {view === "content"
                ? <div className="selection-history-content" id={`selection-history-content-${entry.id}`} role="tabpanel">
                  {entry.content === null
                    ? <p className="selection-history-content-unavailable">{t("selectionHistory.contentUnavailable")}</p>
                    : <pre>{entry.content || "∅"}</pre>}
                  {entry.contentTruncated && <small>{t("selectionHistory.contentTruncated")}</small>}
                </div>
                : <div className="selection-history-content" id={`selection-history-diff-${entry.id}`} role="tabpanel">
                  {diffMessage
                    ? <p className="selection-history-content-unavailable">{diffMessage}</p>
                    : diff && <SelectionDiff diff={diff} previousLabel={t("selectionHistory.previousVersion")} currentLabel={t("selectionHistory.currentVersion")} />}
                </div>}
            </article>
          </li>})}</ol>}
      </>}
    </div>
  </Modal>;
}

function authorLabel(author: SelectionHistoryAuthor, deletedUser: string): string {
  if (!author.name && !author.username) return deletedUser;
  if (author.name && author.username) return `${author.name} (@${author.username})`;
  return author.name || `@${author.username}`;
}

function SelectionDiff({ diff, previousLabel, currentLabel }: {
  diff: SelectionHistorySemanticDiff;
  previousLabel: string;
  currentLabel: string;
}) {
  return <div className="selection-history-semantic-diff">
    <DiffSide label={previousLabel} pieces={diff.previous} variant="previous" />
    <DiffSide label={currentLabel} pieces={diff.current} variant="current" />
  </div>;
}

function DiffSide({ label, pieces, variant }: {
  label: string;
  pieces: readonly SelectionHistoryDiffPiece[];
  variant: "previous" | "current";
}) {
  return <section className={`selection-history-diff-side ${variant}`}>
    <header>{label}</header>
    <pre>{pieces.length
      ? pieces.map((piece, index) => <span className={piece.kind} key={`${index}-${piece.kind}`}>{piece.text}</span>)
      : "∅"}</pre>
  </section>;
}

function formatTime(value: string, language?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
