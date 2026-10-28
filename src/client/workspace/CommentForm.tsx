import { useId, type FormEvent } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MentionTextarea } from "./MentionTextarea";
import { SaveButton } from "../SaveButton";

/** Presentation only: workspace drafts own contents and in-flight requests. */
export function CommentForm({
  projectId, value, onChange, onSubmit, onCancel, pending = false, error = "",
  label, editing = false, disabled = false, autoFocus = true
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<boolean>;
  onCancel: () => void;
  pending?: boolean;
  error?: string;
  label: string;
  editing?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const busy = pending || disabled;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !value.trim()) return;
    // The store guards synchronously, including a submit from an old render
    // or a newly remounted thread while its original request is in flight.
    void onSubmit();
  };
  return <form className={`comment-reply-form${editing ? " comment-edit-form" : ""}`} aria-busy={pending}
    onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()}>
    <MentionTextarea projectId={projectId} autoFocus={autoFocus} rows={editing ? 4 : 3} value={value} onChange={onChange}
      disabled={busy} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      placeholder={editing ? undefined : t("editor.replyPlaceholder")}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }} />
    {error && <p id={errorId} className="comment-form-error" role="alert">{error}</p>}
    <div>
      <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
      {editing ? <SaveButton type="submit" saving={pending} disabled={disabled || !value.trim()} iconSize={13}>{t(pending ? "editor.commentSaving" : "editor.saveChanges")}</SaveButton>
        : <button className="primary" type="submit" disabled={busy || !value.trim()}>
          {pending ? <LoaderCircle className="spin" aria-hidden size={13} /> : <Send aria-hidden size={13} />}
          {t(pending ? "editor.commentSending" : "editor.sendReply")}
        </button>}
    </div>
  </form>;
}
