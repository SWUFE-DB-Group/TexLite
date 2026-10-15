import { useId, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, Save, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../errors";
import { MentionTextarea } from "./MentionTextarea";

/** Shared request feedback; the parent continues to own the draft contents. */
export function CommentForm({
  projectId, value, onChange, onSubmit, onSubmitted, onCancel, onPendingChange,
  label, editing = false, disabled = false
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (content: string) => Promise<boolean>;
  onSubmitted: () => void;
  onCancel: () => void;
  onPendingChange: (pending: boolean) => void;
  label: string;
  editing?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = pending || disabled;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    // The ref closes the gap before React renders disabled controls. It also
    // guards repeated Ctrl/Cmd+Enter events and programmatic form submission.
    if (submitting.current || disabled || !value.trim()) return;
    submitting.current = true;
    setPending(true);
    setError("");
    onPendingChange(true);
    try {
      if (await onSubmit(value)) onSubmitted();
      else setError(t("editor.commentSubmitFailed"));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };
  return <form className={`comment-reply-form${editing ? " comment-edit-form" : ""}`} aria-busy={pending}
    onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()}>
    <MentionTextarea projectId={projectId} autoFocus rows={editing ? 4 : 3} value={value} onChange={onChange}
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
      <button className="primary" type="submit" disabled={busy || !value.trim()}>
        {pending ? <LoaderCircle className="spin" aria-hidden size={13} /> : editing ? <Save aria-hidden size={13} /> : <Send aria-hidden size={13} />}
        {t(pending ? editing ? "editor.commentSaving" : "editor.commentSending" : editing ? "editor.saveChanges" : "editor.sendReply")}
      </button>
    </div>
  </form>;
}
