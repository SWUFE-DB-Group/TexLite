import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePenLine, X } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { MentionableUser, SuggestionDraft } from "../../shared/comments";
import { MAX_SUGGESTION_LENGTH } from "../../shared/comments";
import { SuggestionDiff } from "./SuggestionDiff";

export function SuggestionReviewerPicker({ projectId, authorId, commentId, value, onChange, disabled = false }: {
  projectId: string; authorId: string | null; commentId?: string; value: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<MentionableUser[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setUsers([]); setLoaded(false);
    const query = commentId ? `?${new URLSearchParams({ commentId })}` : "";
    void api<{ users: MentionableUser[] }>(`/api/projects/${projectId}/suggestion-reviewers${query}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setUsers(result.users.filter((user) => user.id !== authorId)); setLoaded(true); } })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [projectId, authorId, commentId, retry]);
  return <div className="suggestion-reviewer-picker">
    <label className="form-field">{t("suggestions.reviewer")}<select value={value === authorId ? "" : value} disabled={disabled || users.length === 0} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t("suggestions.chooseReviewer")}</option>
      {users.map((user) => <option key={user.id} value={user.id}>{user.displayName} (@{user.username})</option>)}
    </select></label>
    {loaded && users.length === 0 && <p className="field-hint">{t("suggestions.noReviewers")}</p>}
    {error && <p className="comment-form-error" role="alert">{error} <button type="button" disabled={disabled} onClick={() => setRetry((n) => n + 1)}>{t("common.retry")}</button></p>}
  </div>;
}

export function SuggestionEditor({ projectId, ownerId, authorId, commentId, original, value, onChange, disabled = false, autoFocus = false, variant = "compact" }: {
  projectId: string; ownerId: string; authorId: string; commentId?: string; original: string; value: SuggestionDraft | null;
  onChange: (value: SuggestionDraft | null) => void; disabled?: boolean; autoFocus?: boolean; variant?: "compact" | "composer";
}) {
  const { t } = useTranslation();
  if (!value) return original && original.length <= MAX_SUGGESTION_LENGTH ? <button type="button" className={`suggestion-add${variant === "composer" ? " suggestion-add-composer" : ""}`} disabled={disabled}
    onClick={() => onChange({ replacementText: original, reviewerId: ownerId === authorId ? "" : ownerId })}><FilePenLine size={variant === "composer" ? 16 : 14} aria-hidden />{t("suggestions.attach")}</button> : null;
  return <section className="suggestion-editor" aria-label={t("suggestions.title")}>
    <header><strong><FilePenLine size={14} />{t("suggestions.title")}</strong><button type="button" disabled={disabled} aria-label={t("suggestions.removeAttachment")} onClick={() => onChange(null)}><X size={14} /></button></header>
    <label className="form-field">{t("suggestions.replacement")}<textarea autoFocus={autoFocus} rows={4} maxLength={MAX_SUGGESTION_LENGTH} spellCheck={false} disabled={disabled}
      value={value.replacementText} onChange={(event) => onChange({ ...value, replacementText: event.target.value })} /></label>
    {value.replacementText === "" && <p className="field-hint">{t("suggestions.deletionHint")}</p>}
    {value.replacementText !== original && <details className="suggestion-preview"><summary>{t("suggestions.preview")}</summary>
      <SuggestionDiff original={original} replacement={value.replacementText} />
    </details>}
    <SuggestionReviewerPicker projectId={projectId} authorId={authorId} commentId={commentId} value={value.reviewerId} disabled={disabled} onChange={(reviewerId) => onChange({ ...value, reviewerId })} />
  </section>;
}
