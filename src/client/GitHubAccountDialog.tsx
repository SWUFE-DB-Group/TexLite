import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { api } from "./api";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { GitTokenGuidance } from "./GitTokenGuidance";
import { GitHubIcon } from "./GitHubIcon";
import { SaveButton } from "./SaveButton";
import { useSuccessNotice } from "./SuccessNotice";

interface GitHubAccountStatus {
  tokenConfigured: boolean;
  githubLogin: string | null;
}

export function GitHubAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitHubAccountStatus | null>(null);
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const tokenFormId = useId();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { message: completedAction, show: confirmAction, clear: clearFeedback } = useSuccessNotice();

  useEffect(() => {
    if (!open) return;
    setBusy("load");
    setError("");
    clearFeedback();
    setToken("");
    setEditingToken(false);
    void api<{ status: GitHubAccountStatus }>("/api/account/github")
      .then((result) => setStatus(result.status))
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy((current) => current === "load" ? "" : current));
  }, [open, clearFeedback]);

  const save = async () => {
    if (busy) return;
    setBusy("save"); setError(""); clearFeedback();
    try {
      const result = await api<{ status: GitHubAccountStatus }>("/api/account/github", {
        method: "PUT", body: JSON.stringify({ token })
      });
      setStatus(result.status); setToken(""); setEditingToken(false); confirmAction("save");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove"); setError(""); clearFeedback();
    try {
      const result = await api<{ status: GitHubAccountStatus }>("/api/account/github", { method: "DELETE" });
      setStatus(result.status); setToken(""); confirmAction("remove");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };

  return <Modal open={open} title={t("account.githubTitle")} description={t("account.githubDescription")}
    onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
    footer={<><button disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>{t("common.close")}</button><SaveButton saving={busy === "save"} feedback={completedAction === "save" ? t("editor.saved") : ""} disabled={Boolean(busy) || Boolean(status?.tokenConfigured && !editingToken) || token.trim().length < 20} onClick={() => void save()}>{t("git.saveToken")}</SaveButton></>}>
    <div className="git-dialog account-github-dialog">
      {busy === "load" && !status && <div className="git-loading"><LoaderCircle className="spin" size={20} />{t("common.loading")}</div>}
      {error && <p className="git-message error dialog-error">{error}</p>}
      {status && <>
        {status.tokenConfigured && <div className="git-account"><GitHubIcon size={17} /><span>{t("git.connectedAs", { login: status.githubLogin })}</span><button className="danger-text" disabled={Boolean(busy)} onClick={() => void remove()}>{busy === "remove" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("git.removeToken")}</button></div>}
        {status.tokenConfigured && <button type="button" className="git-token-disclosure" aria-expanded={editingToken} aria-controls={tokenFormId}
          disabled={Boolean(busy)} onClick={() => setEditingToken(value => !value)}>
          {editingToken ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{t("git.replaceToken")}
        </button>}
        <div id={tokenFormId} className="git-token-form" hidden={status.tokenConfigured && !editingToken}>
          <GitTokenGuidance />
          <label className="form-field">{t("git.token")}
            <input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" autoCorrect="off"
              value={token} placeholder={t("git.tokenPlaceholder")} onChange={(event) => { setToken(event.target.value); clearFeedback(); }} />
          </label>
          <div className="git-inline-actions"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">{t("git.createToken")}<ExternalLink size={12} /></a></div>
          <p className="muted account-github-encryption-note">{t("account.githubEncryption")}</p>
        </div>
      </>}
    </div>
  </Modal>;
}
