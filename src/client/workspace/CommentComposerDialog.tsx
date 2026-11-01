import { useEffect, useId, useRef, useState } from "react";
import { FilePenLine, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "../Dialog";
import { MAX_SUGGESTION_LENGTH, type SuggestionDraft } from "../../shared/comments";
import type { SourceSelection } from "./commentDrafts";
import { MentionTextarea } from "./MentionTextarea";
import { SuggestionReviewerPicker, SuggestionTextEditor } from "./SuggestionEditor";
import { commentSubmission } from "./commentSubmission";

export interface CommentComposerDialogProps {
  open: boolean; projectId: string; ownerId: string; authorId: string;
  selection: SourceSelection; text: string; onText: (text: string) => void;
  suggestion: SuggestionDraft | null; onSuggestion: (suggestion: SuggestionDraft | null) => void;
  submitting: boolean; error: string; onSubmit: () => Promise<void>;
  onClose: () => void; onCancel: () => void;
  draftRestored: boolean; canRetarget: boolean; onRetarget: () => void;
}

export function CommentComposerDialog({ open, projectId, ownerId, authorId, selection, text, onText, suggestion, onSuggestion,
  submitting, error, onSubmit, onClose, onCancel, draftRestored, canRetarget, onRetarget }: CommentComposerDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const [attempted, setAttempted] = useState(false);
  const [focusEdit, setFocusEdit] = useState(false);
  const editDraft = useRef<SuggestionDraft | null>(null);
  useEffect(() => { if (!open) { setAttempted(false); setFocusEdit(false); editDraft.current = null; } }, [open]);
  const submission = commentSubmission(text, selection.selectedText, suggestion, authorId);
  const canSuggest = Boolean(selection.selectedText && selection.selectedText.length <= MAX_SUGGESTION_LENGTH);
  const issueKey = submission.issue === "selfReview" ? "errors.codes.SUGGESTION_SELF_REVIEW"
    : submission.issue === "reviewer" ? "commentComposer.chooseReviewer" : canSuggest ? "commentComposer.empty" : "commentComposer.emptyComment";
  const failed = Boolean(error || attempted && submission.issue);
  const summary = error || (submission.issue ? t(issueKey) : `${t(`commentComposer.${submission.kind}`)}${submission.edit ? ` · ${t("commentComposer.reviewRequested")}` : ""}`);
  const submit = () => {
    if (submitting) return;
    setAttempted(true);
    if (!submission.issue) void onSubmit();
  };
  return <Modal open={open} draggable wide className="comment-compose-modal" title={t("editor.addComment")}
    description={selection.selectedText ? t("editor.commentDescription", { count: selection.endOffset - selection.startOffset }) : t("editor.pointComment")}
    onOpenChange={(next) => { if (!next && !submitting) onClose(); }}
    footer={<>
      <p className={`comment-compose-status${failed ? " has-error" : ""}`} role={failed ? "alert" : "status"} aria-live="polite">{submitting ? t("editor.commentSending") : summary}</p>
      <div className="comment-compose-actions"><button type="button" disabled={submitting} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="primary" aria-busy={submitting} disabled={submitting} onClick={submit}>
          {submitting && <LoaderCircle className="spin" size={14} />}{t(submitting ? "editor.commentSending" : "editor.addComment")}
        </button></div>
    </>}>
    {draftRestored && <p className="comment-draft-restored"><span>{t("editor.commentDraftRestored")}</span>
      {canRetarget && <button type="button" disabled={submitting} onClick={onRetarget}>{t("editor.commentDraftUseSelection")}</button>}
    </p>}
    {selection.selectedText && <section className="comment-compose-original" aria-label={t("commentComposer.original")}>
      <span>{t("commentComposer.original")}</span><blockquote>{selection.selectedText}</blockquote>
    </section>}
    <label className="form-field comment-compose-note">{t("editor.commentContent")}
      <MentionTextarea projectId={projectId} autoFocus rows={3} disabled={submitting} value={text} placeholder={t("commentComposer.placeholder")} onChange={onText}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.stopPropagation(); submit();
          }
        }} />
    </label>
    {canSuggest && <div className="comment-compose-edit">
      <label className="comment-compose-edit-toggle"><input type="checkbox" role="switch" disabled={submitting} checked={Boolean(suggestion)}
        aria-controls={suggestion ? `${id}-edit` : undefined} onChange={(event) => {
          if (event.target.checked) {
            setFocusEdit(true);
            onSuggestion(editDraft.current ?? { replacementText: selection.selectedText, reviewerId: ownerId === authorId ? "" : ownerId });
          } else {
            editDraft.current = suggestion;
            setFocusEdit(false); onSuggestion(null);
          }
        }} /><FilePenLine size={16} aria-hidden /><span>{t("commentComposer.suggestEdit")}</span></label>
      {suggestion && <div className="comment-compose-edit-fields" id={`${id}-edit`}><SuggestionTextEditor original={selection.selectedText} replacement={suggestion.replacementText}
        onChange={(replacementText) => onSuggestion({ ...suggestion, replacementText })} disabled={submitting} autoFocus={focusEdit} /></div>}
    </div>}
    {suggestion && <div className="comment-compose-reviewer"><SuggestionReviewerPicker projectId={projectId} authorId={authorId}
      value={suggestion.reviewerId} onChange={(reviewerId) => onSuggestion({ ...suggestion, reviewerId })} disabled={submitting} /></div>}
  </Modal>;
}
