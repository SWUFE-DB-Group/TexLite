import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, BellOff, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { UPDATE_COMMANDS, type UpdateMethod, type UpdateNotice } from "../shared/updates";

/** Mounted only for administrators, outside the writing workspace. */
export function UpdateNotification({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<UpdateMethod>("npm");
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState("");
  const dismissingRef = useRef(false);
  const dismissedVersion = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (document.visibilityState === "hidden" || pending) return;
      pending = true;
      try {
        const result = await api<{ update: UpdateNotice | null }>("/api/admin/updates", { signal: controller.signal });
        if (controller.signal.aborted) return;
        // An older GET can finish after a successful dismissal in this tab.
        if (result.update?.latestVersion === dismissedVersion.current) return;
        setNotice(result.update);
      } catch {
        // A failed optional check must not interrupt normal dashboard work.
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 30 * 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  const dismiss = async () => {
    if (!notice || dismissingRef.current) return;
    dismissingRef.current = true;
    setDismissing(true);
    setError("");
    try {
      await api("/api/admin/updates/dismiss", { method: "POST", body: JSON.stringify({ version: notice.latestVersion }) });
      dismissedVersion.current = notice.latestVersion;
      setNotice((current) => current?.latestVersion === notice.latestVersion ? null : current);
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      dismissingRef.current = false;
      setDismissing(false);
    }
  };

  if (!notice) return null;
  return <>
    <div className="update-notice" role="status">
      <ArrowUpCircle aria-hidden size={17} />
      <span>{t("updates.available", { version: notice.latestVersion })}</span>
      <button type="button" className="update-notice-details" onClick={() => { setMethod(notice.method); setOpen(true); }}>{t("updates.howToUpdate")}</button>
      <button type="button" className="update-notice-dismiss" disabled={dismissing} onClick={() => void dismiss()} aria-label={t("updates.dismiss")} title={t("updates.dismiss")}><X aria-hidden size={16} /></button>
    </div>
    {error && !open && <p className="error" role="alert">{error}</p>}
    <Modal open={open} onOpenChange={setOpen} title={t("updates.title")}
      description={t("updates.versions", { current: notice.currentVersion, latest: notice.latestVersion })}
      footer={<button type="button" className="update-dismiss-action" disabled={dismissing} onClick={() => void dismiss()}><BellOff aria-hidden size={15} />{t("updates.dismiss")}</button>}>
      <div className="update-methods" role="group" aria-label={t("updates.method")}>
        {(["npm", "docker"] as const).map((value) => <button type="button" key={value} aria-pressed={method === value} aria-controls="update-instructions" onClick={() => setMethod(value)}>{value === "npm" ? "npm" : "Docker"}</button>)}
      </div>
      <div id="update-instructions">
        <p className="update-command-hint">{t(method === "npm" ? "updates.npmHint" : "updates.dockerHint")}</p>
        <pre className="update-commands"><code>{UPDATE_COMMANDS[method]}</code></pre>
        <p className="muted update-command-hint">{t(method === "npm" ? "updates.restartHint" : "updates.imageHint")}</p>
      </div>
      <div className="update-links">
        <a href="https://github.com/SWUFE-DB-Group/TexLite/releases" target="_blank" rel="noreferrer">{t("updates.releaseNotes")}<ExternalLink aria-hidden size={12} /></a>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </Modal>
  </>;
}
