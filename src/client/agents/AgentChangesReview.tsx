import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, GitCompareArrows, LoaderCircle, RefreshCw } from "lucide-react";
import { formatDateTime } from "../dateTime";
import { SuggestionDiff } from "../workspace/SuggestionDiff";
import type { AgentChangeReview, PendingAgentChange } from "./useAgentChanges";

/** The affected lines after the change, with the agent's surviving text marked. */
function NewContent({ change }: { change: PendingAgentChange }) {
  const after = change.after ?? "";
  const parts: Array<{ text: string; agent: boolean }> = [];
  let cursor = 0;
  for (const piece of [...change.pieces].sort((left, right) => left.from - right.from)) {
    const from = Math.max(cursor, piece.from - change.afterFrom);
    const to = Math.min(after.length, piece.to - change.afterFrom);
    if (to <= from) continue;
    if (from > cursor) parts.push({ text: after.slice(cursor, from), agent: false });
    parts.push({ text: after.slice(from, to), agent: true });
    cursor = to;
  }
  if (cursor < after.length) parts.push({ text: after.slice(cursor), agent: false });
  return <pre className="agent-review-content">{parts.map((part, index) => part.agent ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</pre>;
}

/**
 * Manual review of the user's own coding-agent changes, shown in the agent
 * panel above the terminal. Previous/next moves through unreviewed changes
 * across files and shows each one in the editor; marking one reviewed only
 * hides it in this browser and never changes the source.
 */
export function AgentChangesReview({ review, activeId, onShow, focus = null }: {
  review: AgentChangeReview;
  activeId: string | null;
  /** Select this change and open its details, for example from the editor. */
  focus?: { id: string; nonce: number } | null;
  /** Show a change in the editor; `focus` moves the keyboard there too. */
  onShow: (change: PendingAgentChange, focus: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focus?.id ?? activeId);
  const [view, setView] = useState<"content" | "diff">("diff");
  const { pending } = review;
  const index = useMemo(() => {
    const found = pending.findIndex((change) => change.id === selectedId);
    return found >= 0 ? found : pending.length ? 0 : -1;
  }, [pending, selectedId]);
  const current = index >= 0 ? pending[index] : null;

  // A request from the editor selects that change; the editor already shows it.
  useEffect(() => {
    if (!focus) return;
    setSelectedId(focus.id);
    setExpanded(true);
  }, [focus?.nonce]);

  // Keep the selection valid as changes are reviewed or refreshed.
  useEffect(() => {
    if (current && current.id !== selectedId) setSelectedId(current.id);
  }, [current, selectedId]);

  const show = (target: number) => {
    const change = pending[(target + pending.length) % pending.length];
    if (!change) return;
    setSelectedId(change.id);
    setExpanded(true);
    onShow(change, false);
  };

  const markCurrent = () => {
    if (!current) return;
    // Stay at the same position, which now holds the next change.
    const next = pending[index + 1] ?? pending[index - 1] ?? null;
    review.markReviewed(current);
    setSelectedId(next?.id ?? null);
    if (next) onShow(next, false);
  };

  // Polling must not depend on `loading` here: a bar that appears for one request
  // resizes the terminal below it, and the PTY redraws the whole screen.
  if (!pending.length && !review.error) return null;
  return <section className="agent-review" aria-label={t("agents.reviewTitle")}>
    <div className="agent-review-bar">
      <button type="button" className="agent-review-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <GitCompareArrows size={13} aria-hidden />{t("agents.reviewTitle")}<span className="agent-review-count">{pending.length}</span>
        {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
      </button>
      {pending.length > 0 && <>
        <button type="button" className="agent-icon-button" aria-label={t("agents.previousChange")} title={t("agents.previousChange")} onClick={() => show(index - 1)}><ChevronLeft size={13} /></button>
        <small className="agent-review-position">{index + 1} / {pending.length}</small>
        <button type="button" className="agent-icon-button" aria-label={t("agents.nextChange")} title={t("agents.nextChange")} onClick={() => show(index + 1)}><ChevronRight size={13} /></button>
      </>}
      <span className="agent-toolbar-spacer" />
      {pending.length > 0 && <button type="button" onClick={review.markAllReviewed}><CheckCheck size={12} aria-hidden />{t("agents.markAllReviewed")}</button>}
      <button type="button" className="agent-icon-button" aria-label={t("agents.refreshChanges")} title={t("agents.refreshChanges")} disabled={review.loading} onClick={review.refresh}>
        {review.loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
      </button>
    </div>
    {review.error && <p className="error agent-inline-error" role="alert">{review.error}</p>}
    {expanded && current && <div className="agent-review-detail">
      <div className="agent-review-location">
        <button type="button" className="agent-review-file" onClick={() => onShow(current, true)} title={t("agents.openChange")}>
          <FileText size={12} aria-hidden /><span>{current.path}:{current.line}</span>
        </button>
        <time dateTime={current.at}>{formatDateTime(current.at, i18n.resolvedLanguage, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
      </div>
      <div className="agent-review-tabs" role="tablist" aria-label={t("agents.reviewTitle")}>
        <button type="button" role="tab" id={`agent-review-tab-content-${current.id}`} aria-selected={view === "content"} aria-controls="agent-review-panel"
          className={view === "content" ? "active" : ""} onClick={() => setView("content")}>{t("agents.contentTab")}</button>
        <button type="button" role="tab" id={`agent-review-tab-diff-${current.id}`} aria-selected={view === "diff"} aria-controls="agent-review-panel"
          className={view === "diff" ? "active" : ""} onClick={() => setView("diff")}>{t("agents.diffTab")}</button>
      </div>
      <div id="agent-review-panel" role="tabpanel" aria-labelledby={`agent-review-tab-${view}-${current.id}`}>
        {view === "content"
          ? current.after !== null ? <NewContent change={current} /> : <p className="agent-review-unavailable">{t("agents.contentUnavailable")}</p>
          : current.before !== null && current.after !== null
            ? <SuggestionDiff original={current.before} replacement={current.after} />
            : <p className="agent-review-unavailable">{t("agents.changePreviewUnavailable")}</p>}
      </div>
      <div className="agent-review-actions">
        <button type="button" onClick={() => onShow(current, true)}><FileText size={12} aria-hidden />{t("agents.openChange")}</button>
        <button type="button" className="primary" onClick={markCurrent}><Check size={12} aria-hidden />{t("agents.markReviewed")}</button>
      </div>
    </div>}
  </section>;
}
