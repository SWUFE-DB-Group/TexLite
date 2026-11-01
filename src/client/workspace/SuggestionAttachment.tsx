import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Comment, SuggestionDraft } from "../../shared/comments";
import { MAX_SUGGESTION_LENGTH } from "../../shared/comments";
import { useCommentMutations } from "./useCommentMutations";
import { SuggestionEditor, SuggestionReviewerPicker } from "./SuggestionEditor";
import { SuggestionDiff } from "./SuggestionDiff";
import { errorMessage } from "../errors";
import { formatDateTime } from "../dateTime";

export interface SuggestionSourceTarget { original: string; sourceHash: string }

export function canAttachCommentSuggestion(comment: Comment, userId: string): boolean {
  return !comment.suggestion && comment.authorId === userId && !comment.resolved && !comment.orphaned
    && Boolean(comment.anchorSourceHash) && comment.selectedText.length > 0 && comment.selectedText.length <= MAX_SUGGESTION_LENGTH;
}

export function SuggestionAttachment({ projectId, ownerId, currentUserId, canEdit, comment, draftTarget, onCloseComposer }: {
  projectId: string; ownerId: string; currentUserId: string; canEdit: boolean; comment: Comment;
  draftTarget?: SuggestionSourceTarget | null; onCloseComposer?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const write = useCommentMutations(projectId);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<SuggestionDraft | null>(() => draftTarget
    ? { replacementText: draftTarget.original, reviewerId: ownerId === currentUserId ? "" : ownerId } : null);
  const [assigning, setAssigning] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const suggestion = comment.suggestion;
  const operation = async (path: string, method: string, body: unknown) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try {
      await write(`/${comment.id}/suggestion${path}`, { method, body: JSON.stringify(body) });
      setDraft(null); setAssigning(false);
      if (method === "POST" && path === "") onCloseComposer?.();
    }
    catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  if (!suggestion) {
    if (!draftTarget || !draft || comment.authorId !== currentUserId || comment.resolved) return null;
    return <div className="suggestion-new" onClick={(event) => event.stopPropagation()}>
      <SuggestionEditor projectId={projectId} ownerId={ownerId} authorId={currentUserId} commentId={comment.id} original={draftTarget.original} value={draft} disabled={busy} autoFocus
        onChange={(next) => { setDraft(next); if (!next) onCloseComposer?.(); }} />
      {error && <p className="comment-form-error" role="alert">{error}</p>}
      <button type="button" className="suggestion-submit" disabled={busy || !draft.reviewerId || draft.reviewerId === comment.authorId || draft.replacementText === draftTarget.original}
        onClick={() => void operation("", "POST", { ...draft, sourceHash: draftTarget.sourceHash })}>{busy && <LoaderCircle size={13} className="spin" />}{t(draft.replacementText === "" ? "suggestions.submitDeletion" : "suggestions.submit")}</button>
    </div>;
  }
  const pending = suggestion.status === "pending";
  const reviewer = suggestion.reviewerDisplayName ?? suggestion.reviewerUsername ?? t("editor.deletedUser");
  const selfReview = suggestion.reviewerId !== null && suggestion.reviewerId === comment.authorId;
  const canReview = canEdit && !selfReview && suggestion.reviewerId === currentUserId && suggestion.reviewerAvailable;
  const reviewerLabel = pending ? canReview ? t("suggestions.awaitingYou") : t("suggestions.awaiting", { name: reviewer }) : t(`suggestions.${suggestion.status}`);
  return <section className={`comment-suggestion ${suggestion.status}`} onClick={(event) => event.stopPropagation()}>
    <button type="button" className="suggestion-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{t("suggestions.title")}</strong><span>{reviewerLabel}</span>
    </button>
    {expanded && <div className="suggestion-details">
      <SuggestionDiff original={suggestion.originalText} replacement={suggestion.replacementText} />
      {pending && !suggestion.applicable && !suggestion.applying && <p className="suggestion-warning">{t("suggestions.sourceChanged")}</p>}
      {pending && (selfReview || !suggestion.reviewerAvailable) && <p className="suggestion-warning">{t(selfReview ? "errors.codes.SUGGESTION_SELF_REVIEW" : "suggestions.reviewerUnavailable")}</p>}
      {suggestion.applying && <p className="suggestion-warning">{t("suggestions.saving")}</p>}
      {!pending && <p className="suggestion-decision"><span data-tooltip={suggestion.decidedByUsername ? `@${suggestion.decidedByUsername}` : undefined} data-texlite-tooltip-always>{t("suggestions.decidedBy", { name: suggestion.decidedByDisplayName ?? suggestion.decidedByUsername ?? t("editor.deletedUser") })}</span>{suggestion.decidedAt && <time dateTime={suggestion.decidedAt}>{formatDateTime(suggestion.decidedAt, i18n.resolvedLanguage)}</time>}</p>}
      {error && <p className="comment-form-error" role="alert">{error}</p>}
      {pending && canReview && <div className="suggestion-actions">
        <button type="button" className="primary" disabled={busy || !suggestion.applicable && !suggestion.applying} onClick={() => void operation("/review", "POST", { action: "accept" })}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{t("suggestions.accept")}</button>
        <button type="button" disabled={busy || suggestion.applying} onClick={() => void operation("/review", "POST", { action: "reject" })}><X size={13} />{t("suggestions.reject")}</button>
      </div>}
      {pending && ownerId === currentUserId && !suggestion.applying && <div className="suggestion-assignment">
        {assigning ? <><SuggestionReviewerPicker projectId={projectId} authorId={comment.authorId} commentId={comment.id} value={reviewerId} onChange={setReviewerId} disabled={busy} /><div className="suggestion-actions"><button type="button" disabled={busy || !reviewerId || reviewerId === comment.authorId || reviewerId === suggestion.reviewerId} onClick={() => void operation("", "PATCH", { reviewerId })}>{t("common.save")}</button><button type="button" disabled={busy} onClick={() => setAssigning(false)}>{t("common.cancel")}</button></div></>
          : <button type="button" className="suggestion-text-action" onClick={() => { setReviewerId(suggestion.reviewerId ?? ""); setAssigning(true); }}>{t("suggestions.changeReviewer")}</button>}
      </div>}
    </div>}
  </section>;
}
