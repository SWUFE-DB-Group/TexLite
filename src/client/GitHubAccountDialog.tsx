import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ExternalLink, LoaderCircle, Mail, Trash2 } from "lucide-react";
import { api } from "./api";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { GitTokenGuidance } from "./GitTokenGuidance";
import { GitHubIcon } from "./GitHubIcon";
import { InfoPopover } from "./InfoPopover";
import { SaveButton } from "./SaveButton";
import { useSuccessNotice } from "./SuccessNotice";

interface GitHubAccountStatus {
  tokenConfigured: boolean;
  githubLogin: string | null;
  gitUsername: string;
  gitEmail: string;
}

type AccountTab = "token" | "identity";

export function GitHubAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitHubAccountStatus | null>(null);
  const [tab, setTab] = useState<AccountTab>("token");
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [gitUsername, setGitUsername] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const tokenFormId = useId();
  const tokenPanelId = `${tokenFormId}-panel`;
  const identityPanelId = `${tokenFormId}-identity-panel`;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { message: completedAction, show: confirmAction, clear: clearFeedback } = useSuccessNotice();

  useEffect(() => {
    if (!open) return;
    setBusy("load");
    setError("");
    clearFeedback();
    setStatus(null);
    setTab("token");
    setToken("");
    setEditingToken(false);
    setGitUsername("");
    setGitEmail("");
    void api<{ status: GitHubAccountStatus }>("/api/account/github")
      .then((result) => {
        setStatus(result.status);
        setGitUsername(result.status.gitUsername);
        setGitEmail(result.status.gitEmail);
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy((current) => current === "load" ? "" : current));
  }, [open, clearFeedback]);

  const selectTab = (next: AccountTab) => {
    if (busy) return;
    setTab(next);
    setError("");
    clearFeedback();
  };

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
      setStatus(result.status); setToken(""); setEditingToken(false); confirmAction("remove");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };

  const username = gitUsername.trim();
  const email = gitEmail.trim();
  const controlCharacter = /\p{Cc}/u;
  const usernameValid = Boolean(username) && username.length <= 100 && !controlCharacter.test(username) && !/[<>]/.test(username);
  const emailValid = Boolean(email) && email.length <= 254 && !controlCharacter.test(email) && /^[^\s<>@]+@[^\s<>@]+$/.test(email);
  const identityValid = usernameValid && emailValid;
  const identityDirty = username !== (status?.gitUsername ?? "") || email !== (status?.gitEmail ?? "");
  const canSaveIdentity = identityValid && identityDirty;

  const saveIdentity = async () => {
    if (busy || !canSaveIdentity) return;
    setBusy("saveIdentity"); setError(""); clearFeedback();
    try {
      const result = await api<{ status: GitHubAccountStatus }>("/api/account/github/identity", {
        method: "PUT", body: JSON.stringify({ username, email })
      });
      setStatus(result.status);
      setGitUsername(result.status.gitUsername);
      setGitEmail(result.status.gitEmail);
      confirmAction("saveIdentity");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };

  return <Modal open={open} title={t("account.githubTitle")} description={t("account.githubDescription")}
    onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
    footer={<><button disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>{t("common.close")}</button>
      {tab === "token"
        ? <SaveButton saving={busy === "save"} feedback={completedAction === "save" ? t("editor.saved") : ""} disabled={Boolean(busy) || Boolean(status?.tokenConfigured && !editingToken) || token.trim().length < 20} onClick={() => void save()}>{t("git.saveToken")}</SaveButton>
        : <SaveButton saving={busy === "saveIdentity"} feedback={completedAction === "saveIdentity" ? t("editor.saved") : ""} disabled={Boolean(busy) || !canSaveIdentity} onClick={() => void saveIdentity()}>{t("git.saveIdentity")}</SaveButton>}
    </>}>
    <div className="git-dialog account-github-dialog">
      {busy === "load" && !status && <div className="git-loading"><LoaderCircle className="spin" size={20} />{t("common.loading")}</div>}
      {error && <p className="git-message error dialog-error">{error}</p>}
      {status && <>
        <div className="share-scope-tabs" role="tablist" aria-label={t("account.githubTitle")}>
          {(["token", "identity"] as const).map((item) => <button key={item} type="button" role="tab"
            id={`${tokenFormId}-${item}-tab`} aria-controls={item === "token" ? tokenPanelId : identityPanelId}
            aria-selected={tab === item} disabled={Boolean(busy)} onClick={() => selectTab(item)}>
            {t(item === "token" ? "git.tokenTab" : "git.identityTab")}
          </button>)}
        </div>
        <div id={tokenPanelId} className="account-github-panel" role="tabpanel" aria-labelledby={`${tokenFormId}-token-tab`} hidden={tab !== "token"}>
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
        </div>
        <div id={identityPanelId} className="account-github-panel git-identity-form" role="tabpanel" aria-labelledby={`${tokenFormId}-identity-tab`} hidden={tab !== "identity"}>
          <div className="git-section-heading"><Mail size={16} /><div><div className="git-section-title"><strong>{t("git.identityTitle")}</strong><InfoPopover label={t("git.identityInfoLabel")} content={t("git.identityInfo")} /></div></div></div>
          <label className="form-field">{t("git.identityName")}
            <input value={gitUsername} autoComplete="off" spellCheck={false} maxLength={100}
              aria-invalid={Boolean(username) && !usernameValid} onChange={(event) => { setGitUsername(event.target.value); clearFeedback(); }} />
          </label>
          <label className="form-field">{t("git.identityEmail")}
            <input type="email" value={gitEmail} autoComplete="off" spellCheck={false} maxLength={254}
              aria-invalid={Boolean(email) && !emailValid} onChange={(event) => { setGitEmail(event.target.value); clearFeedback(); }} />
          </label>
          {email && !emailValid && <p className="git-identity-validation" role="alert">{t("git.identityEmailInvalid")}</p>}
        </div>
      </>}
    </div>
  </Modal>;
}
