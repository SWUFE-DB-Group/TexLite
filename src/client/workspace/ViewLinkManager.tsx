import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link, LoaderCircle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { copyTextToClipboard } from "../clipboard";
import { errorMessage } from "../errors";
import { formatDateTime } from "../dateTime";
import { ConfirmDialog } from "../Dialog";
import type { CreatedProjectViewLink, ProjectViewLink } from "../../shared/projectViewLinks";

export function ViewLinkManager({ projectId, onBusyChange }: { projectId: string; onBusyChange: (busy: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [links, setLinks] = useState<ProjectViewLink[]>([]);
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("168");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ProjectViewLink | null>(null);
  const [now, setNow] = useState(Date.now);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const copying = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busyChange = useRef(onBusyChange); busyChange.current = onBusyChange;
  useEffect(() => {
    const controller = new AbortController(); view.current = controller;
    setLoading(true); setLinks([]); setError(""); setConfirm(null); setCopiedId(null); setNow(Date.now());
    void api<{ links: ProjectViewLink[] }>(`/api/projects/${projectId}/view-links`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setLinks(result.links); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); clearTimeout(copiedTimer.current); busyChange.current(false); };
  }, [projectId]);
  // Let the create form reappear when the link expires, without reopening Share.
  useEffect(() => {
    const expiries = links.flatMap((link) => link.expiresAt && Date.parse(link.expiresAt) > now ? [Date.parse(link.expiresAt)] : []);
    if (!expiries.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(1, Math.min(...expiries) - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [links, now]);
  const hasActiveLink = links.some((link) => !link.expiresAt || Date.parse(link.expiresAt) > now);
  const mutate = async (action: (signal: AbortSignal) => Promise<void>) => {
    const controller = view.current;
    if (!controller || controller.signal.aborted || pending.current || copying.current) return;
    pending.current = true; setBusy(true); busyChange.current(true); setError("");
    try { await action(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!controller.signal.aborted) { setBusy(false); busyChange.current(false); } }
  };
  const create = () => mutate(async (signal) => {
    if (hasActiveLink) return;
    try {
      const result = await api<CreatedProjectViewLink>(`/api/projects/${projectId}/view-links`, { method: "POST", signal,
        body: JSON.stringify({ label, expiresAt: hours === "never" ? null : new Date(Date.now() + Number(hours) * 3600_000).toISOString() }) });
      if (!signal.aborted) { setLinks((current) => [result.link, ...current]); setLabel(""); }
    } catch (reason) {
      // Another tab may have created a link since this dialog was opened.
      if (reason instanceof ApiError && reason.code === "VIEW_LINK_EXISTS") {
        const result = await api<{ links: ProjectViewLink[] }>(`/api/projects/${projectId}/view-links`, { signal });
        if (!signal.aborted) setLinks(result.links);
      }
      throw reason;
    }
  });
  const revoke = () => {
    if (!confirm) return;
    const link = confirm;
    void mutate(async (signal) => {
      await api(`/api/projects/${projectId}/view-links/${link.id}`, { method: "DELETE", signal });
      if (!signal.aborted) setLinks((current) => current.filter((item) => item.id !== link.id));
      if (!signal.aborted) setConfirm(null);
    });
  };
  const copy = async (link: ProjectViewLink) => {
    const controller = view.current;
    if (!controller || controller.signal.aborted || pending.current || copying.current) return;
    if (!link.path) return;
    copying.current = true; setCopyingId(link.id); setCopiedId(null); setError(""); clearTimeout(copiedTimer.current);
    try {
      await copyTextToClipboard(new URL(link.path, window.location.origin).href, () => host.current);
      if (!controller.signal.aborted) { setCopiedId(link.id); copiedTimer.current = setTimeout(() => setCopiedId(null), 2000); }
    } catch { if (!controller.signal.aborted) setError(t("viewLinks.copyFailed")); }
    finally { copying.current = false; if (!controller.signal.aborted) setCopyingId(null); }
  };
  return <div className="view-link-manager" ref={host} aria-busy={loading || busy}>
    <p className="view-link-description"><ShieldCheck size={17} aria-hidden />{t("viewLinks.description")}</p>
    {!loading && !hasActiveLink && <div className="view-link-create">
      <label className="form-field">{t("viewLinks.label")}<input maxLength={80} value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="form-field">{t("viewLinks.expiry")}<select value={hours} disabled={busy} onChange={(event) => setHours(event.target.value)}>
        {[['1', 'hour'], ['24', 'day'], ['168', 'week'], ['720', 'month'], ['never', 'never']].map(([value, key]) => <option key={value} value={value}>{t(`viewLinks.${key}`)}</option>)}
      </select></label>
      <button className="primary icon-button" disabled={busy || loading || copyingId !== null} onClick={() => void create()}><Plus size={15} />{t("viewLinks.create")}</button>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <div className="share-empty" role="status"><LoaderCircle size={20} className="spin" />{t("common.loading")}</div> : <div className="view-link-list">{links.map((link) => {
      const status = link.expiresAt && Date.parse(link.expiresAt) <= now ? "expired" : "active";
      const address = link.path ? new URL(link.path, window.location.origin).href : "";
      return <div className={`view-link-item ${status}`} key={link.id}>
        <div className="view-link-heading"><Link size={16} aria-hidden /><div className="view-link-identity"><strong>{link.label || t("viewLinks.untitled")}</strong><small>{link.expiresAt ? t("viewLinks.expires", { time: formatDateTime(link.expiresAt, i18n.resolvedLanguage) }) : t("viewLinks.never")}</small></div>
          <span className="view-link-status">{t(`viewLinks.${status}`)}</span>
          <div className="view-link-actions"><button className="icon-only danger-text" disabled={busy || copyingId !== null} aria-label={t("viewLinks.delete")} data-tooltip={t("viewLinks.delete")} onClick={() => { setError(""); setConfirm(link); }}><Trash2 size={15} /></button></div>
        </div>
        <div className="view-link-address"><input readOnly spellCheck={false} autoComplete="off" aria-label={t("viewLinks.address", { name: link.label || t("viewLinks.untitled") })} value={address} placeholder={t("viewLinks.addressUnavailable")} onFocus={(event) => event.target.select()} />
          <button type="button" className="save-button view-link-copy" disabled={busy || copyingId !== null || status !== "active" || !link.path} aria-busy={copyingId === link.id} onClick={() => void copy(link)}>
            {copyingId === link.id ? <LoaderCircle className="spin" size={14} /> : copiedId === link.id ? <Check className="save-button-confirmation" size={14} /> : <Copy size={14} />}<span role="status" aria-live="polite">{t(copiedId === link.id ? "viewLinks.copied" : "viewLinks.copy")}</span>
          </button>
        </div>
      </div>;
    })}{links.length === 0 && <div className="share-empty"><Link size={24} /><span>{t("viewLinks.empty")}</span></div>}</div>}
    <ConfirmDialog open={Boolean(confirm)} title={t("viewLinks.delete")} description={t("viewLinks.deleteConfirm")}
      confirmLabel={t("viewLinks.delete")} danger busy={busy} error={error}
      onCancel={() => { if (!busy) { setConfirm(null); setError(""); } }} onConfirm={revoke} />
  </div>;
}
