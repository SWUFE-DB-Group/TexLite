import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import type { ProjectListPagination, SiteConfig, User } from "../types";
import {
  ChevronLeft, ChevronRight, Dices, KeyRound, LoaderCircle, LockKeyhole, MoreHorizontal, Search, Trash2,
  UserPlus, Users, X
} from "lucide-react";

function randomPassword(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

type RestrictedUserSetting = "demote" | "promote" | "allowProjectCreation" | "denyProjectCreation";

interface PendingUserSetting {
  target: User;
  setting: RestrictedUserSetting;
}

export function AdminUsers({ currentUser, minPasswordLength, onBack }: { currentUser: User; minPasswordLength: SiteConfig["minPasswordLength"]; onBack: () => void }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pagination, setPagination] = useState<ProjectListPagination>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [formError, setFormError] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", displayName: "", password: "", role: "user" as "user" | "admin", canCreateProjects: false });
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteProjects, setDeleteProjects] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pendingSetting, setPendingSetting] = useState<PendingUserSetting | null>(null);
  const [pendingSettingBusy, setPendingSettingBusy] = useState(false);
  const [pendingSettingError, setPendingSettingError] = useState("");
  const search = query.trim();
  const refreshUsers = () => setRefreshNonce((current) => current + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListFailed(false);
    setError("");
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(pageNumber) });
      if (search) params.set("q", search);
      void api<{ users: User[]; pagination: ProjectListPagination }>(`/api/admin/users?${params}`, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setUsers(result.users);
          setPagination(result.pagination);
          setPageNumber(result.pagination.page);
        })
        .catch((requestError) => {
          if (controller.signal.aborted) return;
          setError(errorMessage(requestError));
          setListFailed(true);
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 200 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, pageNumber, refreshNonce]);
  const create = async () => {
    if (mutationBusy) return;
    if (createForm.password.length < minPasswordLength) return setFormError(t("auth.passwordMinimum", { count: minPasswordLength }));
    setMutationBusy(true); setFormError("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({
        username: createForm.username,
        displayName: createForm.displayName || createForm.username,
        password: createForm.password,
        role: createForm.role,
        canCreateProjects: createForm.canCreateProjects
      }) });
      setCreateOpen(false); setCreateForm({ username: "", displayName: "", password: "", role: "user", canCreateProjects: false });
      refreshUsers();
      setNotice(t("users.saved"));
    } catch (e) { setFormError(errorMessage(e)); }
    finally { setMutationBusy(false); }
  };
  const toggleRole = async (target: User) => {
    setPendingSetting({ target, setting: target.role === "admin" ? "demote" : "promote" });
    setPendingSettingError("");
  };
  const toggleProjectCreation = async (target: User) => {
    setPendingSetting({ target, setting: target.canCreateProjects ? "denyProjectCreation" : "allowProjectCreation" });
    setPendingSettingError("");
  };
  const applyRestrictedSetting = async () => {
    if (!pendingSetting || pendingSettingBusy) return;
    const { target, setting } = pendingSetting;
    const patch = setting === "demote"
        ? { role: "user" }
        : setting === "promote" ? { role: "admin" } : { canCreateProjects: setting === "allowProjectCreation" };
    setPendingSettingBusy(true);
    setPendingSettingError("");
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      refreshUsers();
      setPendingSetting(null);
      setNotice(t("users.saved"));
    } catch (e) { setPendingSettingError(errorMessage(e)); }
    finally { setPendingSettingBusy(false); }
  };
  const resetPassword = async () => {
    if (!resetTarget || !resetValue || mutationBusy) return;
    if (resetValue.length < minPasswordLength) return setFormError(t("auth.passwordMinimum", { count: minPasswordLength }));
    setMutationBusy(true); setFormError("");
    try {
      await api(`/api/admin/users/${resetTarget.id}`, { method: "PATCH", body: JSON.stringify({ password: resetValue }) });
      setResetTarget(null); setResetValue("");
      setNotice(t("users.saved"));
    } catch (e) { setFormError(errorMessage(e)); }
    finally { setMutationBusy(false); }
  };
  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE", body: JSON.stringify({ deleteProjects }) });
      setDeleteTarget(null); setDeleteProjects(false);
      refreshUsers();
    } catch (e) { setDeleteError(errorMessage(e)); }
    finally { setDeleting(false); }
  };
  return <section className="admin-users-page">
    <div className="section-title"><div><h1><Users aria-hidden size={25} />{t("users.manage")}</h1><p className="muted">{t("users.onlyAdmin")}</p></div><button type="button" className="dashboard-back-button" onClick={onBack}><ChevronLeft size={15} />{t("projects.title")}</button></div>
    <div className="admin-user-toolbar">
      <div className="admin-user-filters">
      <div className="admin-user-search" role="search"><Search aria-hidden size={16} /><input role="searchbox" aria-label={t("users.searchPlaceholder")} placeholder={t("users.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setPageNumber(1); }} />{query && <button type="button" aria-label={t("users.clearSearch")} title={t("users.clearSearch")} onClick={() => { setQuery(""); setPageNumber(1); }}><X aria-hidden size={14} /></button>}</div>
      {!loading && !listFailed && <span className="admin-user-count" role="status">{t("users.total", { count: pagination.total })}</span>}
      </div>
      <button className="primary icon-button admin-user-add" onClick={() => { setFormError(""); setCreateOpen(true); }}><UserPlus aria-hidden size={15} />{t("users.add")}</button>
    </div>
    {notice && <p className="admin-user-notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="table-card admin-user-table" aria-busy={loading}><table><thead><tr><th>{t("common.user")}</th><th>{t("users.role")}</th><th>{t("users.createProjects")}</th><th>{t("users.ownedProjects")}</th><th>{t("users.actions")}</th></tr></thead>
      <tbody>{loading ? <tr><td colSpan={5} className="admin-user-list-state"><span role="status"><LoaderCircle className="spin" size={16} />{t("common.loading")}</span></td></tr> : listFailed ? <tr><td colSpan={5} className="admin-user-list-state"><span>{t("users.loadFailed")}</span><button type="button" onClick={refreshUsers}>{t("common.retry")}</button></td></tr> : users.length === 0 ? <tr><td colSpan={5} className="admin-user-list-state">{t(search ? "users.noMatches" : "users.empty")}</td></tr> : users.map((target) => {
        const self = target.id === currentUser.id;
        const busy = mutationBusy || pendingSettingBusy;
        return <tr key={target.id}>
          <td className="admin-user-identity"><strong>{target.displayName}</strong><small>@{target.username}</small></td>
          <td>{self ? <span className="admin-user-badge" title={t("users.selfProtected")}><LockKeyhole size={12} aria-hidden />{t("common.admin")}</span> : <select className="admin-user-role" aria-label={t("users.roleFor", { username: target.username })} value={target.role} disabled={busy} onChange={() => void toggleRole(target)}><option value="user">{t("common.user")}</option><option value="admin">{t("common.admin")}</option></select>}</td>
          <td>{target.role === "admin" ? <span className="admin-user-locked" title={t("users.adminCreation")}><LockKeyhole size={12} aria-hidden />{t("users.allow")}</span> : <button type="button" className="admin-user-switch" role="switch" aria-checked={target.canCreateProjects} aria-label={t("users.creationFor", { username: target.username })} disabled={busy} onClick={() => void toggleProjectCreation(target)}><span /></button>}</td>
          <td>{target.ownedProjects ?? 0}</td>
          <td><div className="admin-user-actions">
            <button className="icon-button" disabled={busy} onClick={() => { setResetTarget(target); setResetValue(""); setFormError(""); }}><KeyRound aria-hidden size={13} />{t("users.resetPassword")}</button>
            {!self && <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button className="icon-button" disabled={busy} aria-label={t("users.actionsFor", { username: target.username })}><MoreHorizontal size={17} aria-hidden /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="comment-actions-menu-content" align="end" sideOffset={5}><DropdownMenu.Item className="danger-text" onSelect={() => { setDeleteTarget(target); setDeleteProjects(false); setDeleteError(""); }}><Trash2 size={14} aria-hidden />{t("users.deleteTitle")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
          </div></td>
        </tr>;
      })}</tbody></table></div>
    {pagination.totalPages > 1 && <nav className="project-pagination admin-user-pagination" aria-label={t("users.pagination")}><button type="button" disabled={loading || listFailed || pagination.page <= 1} onClick={() => setPageNumber(pagination.page - 1)}><ChevronLeft size={15} />{t("users.previousPage")}</button><span>{t("users.pageOf", { page: pagination.page, totalPages: pagination.totalPages })}</span><button type="button" disabled={loading || listFailed || pagination.page >= pagination.totalPages} onClick={() => setPageNumber(pagination.page + 1)}>{t("users.nextPage")}<ChevronRight size={15} /></button></nav>}
    <Modal open={createOpen} title={t("users.add")} description={t("users.addDescription")} onOpenChange={(open) => { if (!mutationBusy) setCreateOpen(open); }} footer={<><button className="icon-button" disabled={mutationBusy} onClick={() => setCreateOpen(false)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={mutationBusy || !createForm.username.trim() || createForm.password.length < minPasswordLength} onClick={() => void create()}><UserPlus aria-hidden size={14} />{t("users.createUser")}</button></>}>
      {formError && <p className="error" role="alert">{formError}</p>}<fieldset className="admin-user-form form-stack" disabled={mutationBusy}><label className="form-field">{t("auth.username")}<input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} /></label><label className="form-field">{t("users.displayName")}<input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /></label><label className="form-field">{t("users.initialPassword")}<span className="password-generator"><input minLength={minPasswordLength} autoComplete="new-password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} /><button type="button" title={t("users.generatePassword")} onClick={() => setCreateForm({ ...createForm, password: randomPassword() })}><Dices size={15} />{t("users.randomPassword")}</button></span><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label><label className="form-field">{t("users.role")}<select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "user" | "admin" })}><option value="user">{t("common.user")}</option><option value="admin">{t("common.admin")}</option></select></label><label className="checkbox-field"><input type="checkbox" checked={createForm.canCreateProjects || createForm.role === "admin"} disabled={createForm.role === "admin"} onChange={(e) => setCreateForm({ ...createForm, canCreateProjects: e.target.checked })} /> {t("users.allowCreate")}</label></fieldset>
    </Modal>
    <Modal open={Boolean(resetTarget)} title={t("users.resetPassword")} description={t("users.resetDescription", { username: resetTarget?.username ?? "" })} onOpenChange={(open) => { if (!open && !mutationBusy) setResetTarget(null); }} footer={<><button className="icon-button" disabled={mutationBusy} onClick={() => setResetTarget(null)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={mutationBusy || resetValue.length < minPasswordLength} onClick={() => void resetPassword()}><KeyRound aria-hidden size={14} />{t("users.reset")}</button></>}>
      {formError && <p className="error" role="alert">{formError}</p>}<label className="form-field">{t("auth.newPassword")}<span className="password-generator"><input disabled={mutationBusy} autoFocus minLength={minPasswordLength} autoComplete="new-password" value={resetValue} onChange={(e) => setResetValue(e.target.value)} /><button type="button" disabled={mutationBusy} onClick={() => setResetValue(randomPassword())}><Dices size={15} />{t("users.randomPassword")}</button></span><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label>
    </Modal>
    <Modal open={Boolean(deleteTarget)} title={t("users.deleteTitle")} description={t("users.deleteDescription", { username: deleteTarget?.username ?? "" })} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(""); } }} footer={<><button className="icon-button" disabled={deleting} onClick={() => { setDeleteTarget(null); setDeleteError(""); }}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="danger icon-button" disabled={deleting} aria-busy={deleting} onClick={() => void remove()}>{deleting ? <LoaderCircle className="spin" aria-hidden size={14} /> : <Trash2 aria-hidden size={14} />}{deleting ? t("common.loading") : t("users.deleteTitle")}</button></>}>
      <>{deleteError && <p className="error dialog-error">{deleteError}</p>}<fieldset className="choice-group" disabled={deleting}><legend>{t("users.ownedChoice", { count: deleteTarget?.ownedProjects ?? 0 })}</legend><label><input type="radio" checked={!deleteProjects} onChange={() => setDeleteProjects(false)} /> {t("users.transferProjects")}</label><label><input type="radio" checked={deleteProjects} onChange={() => setDeleteProjects(true)} /> {t("users.deleteProjects")}</label></fieldset></>
    </Modal>
    <ConfirmDialog
      open={Boolean(pendingSetting)}
      title={t(`userConfirmations.${pendingSetting?.setting ?? "demote"}Title`)}
      description={t(`userConfirmations.${pendingSetting?.setting ?? "demote"}Description`, { username: pendingSetting?.target.username ?? "" })}
      confirmLabel={t(`userConfirmations.${pendingSetting?.setting ?? "demote"}Confirm`)}
      danger={pendingSetting?.setting !== "promote" && pendingSetting?.setting !== "allowProjectCreation"}
      busy={pendingSettingBusy}
      error={pendingSettingError}
      onCancel={() => { if (!pendingSettingBusy) { setPendingSetting(null); setPendingSettingError(""); } }}
      onConfirm={() => void applyRestrictedSetting()}
    />
  </section>;
}
