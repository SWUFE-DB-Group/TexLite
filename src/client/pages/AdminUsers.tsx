import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";
import {
  Dices, FolderCheck, FolderX, KeyRound, LoaderCircle, ShieldCheck, ShieldOff, Trash2,
  UserCheck, UserPlus, UserX, Users, X
} from "lucide-react";

function randomPassword(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

type RestrictedUserSetting = "disable" | "demote" | "denyProjectCreation";

interface PendingUserSetting {
  target: User;
  setting: RestrictedUserSetting;
}

export function AdminUsers({ currentUser, minPasswordLength }: { currentUser: User; minPasswordLength: SiteConfig["minPasswordLength"] }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
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
  const load = () => api<{ users: User[] }>("/api/admin/users").then(({ users }) => setUsers(users)).catch((e) => setError(errorMessage(e)));
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (createForm.password.length < minPasswordLength) return setError(t("auth.passwordMinimum", { count: minPasswordLength }));
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({
        username: createForm.username,
        displayName: createForm.displayName || createForm.username,
        password: createForm.password,
        role: createForm.role,
        canCreateProjects: createForm.canCreateProjects
      }) });
      setCreateOpen(false); setCreateForm({ username: "", displayName: "", password: "", role: "user", canCreateProjects: false });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const updateUser = async (target: User, patch: Record<string, unknown>) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggle = async (target: User) => {
    if (!target.disabled) {
      setPendingSetting({ target, setting: "disable" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { disabled: false });
  };
  const toggleRole = async (target: User) => {
    if (target.role === "admin") {
      setPendingSetting({ target, setting: "demote" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { role: "admin" });
  };
  const toggleProjectCreation = async (target: User) => {
    if (target.canCreateProjects) {
      setPendingSetting({ target, setting: "denyProjectCreation" });
      setPendingSettingError("");
      return;
    }
    await updateUser(target, { canCreateProjects: true });
  };
  const applyRestrictedSetting = async () => {
    if (!pendingSetting) return;
    const { target, setting } = pendingSetting;
    const patch = setting === "disable"
      ? { disabled: true }
      : setting === "demote"
        ? { role: "user" }
        : { canCreateProjects: false };
    setPendingSettingBusy(true);
    setPendingSettingError("");
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
      setPendingSetting(null);
    } catch (e) { setPendingSettingError(errorMessage(e)); }
    finally { setPendingSettingBusy(false); }
  };
  const resetPassword = async () => {
    if (!resetTarget || !resetValue) return;
    if (resetValue.length < minPasswordLength) return setError(t("auth.passwordMinimum", { count: minPasswordLength }));
    try {
      await api(`/api/admin/users/${resetTarget.id}`, { method: "PATCH", body: JSON.stringify({ password: resetValue }) });
      setResetTarget(null); setResetValue("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE", body: JSON.stringify({ deleteProjects }) });
      setDeleteTarget(null); setDeleteProjects(false);
      await load();
    } catch (e) { setDeleteError(errorMessage(e)); }
    finally { setDeleting(false); }
  };
  return <main className="dashboard">
    <div className="section-title"><div><h1><Users aria-hidden size={25} />{t("users.manage")}</h1><p className="muted">{t("users.onlyAdmin")}</p></div><button className="primary icon-button" onClick={() => setCreateOpen(true)}><UserPlus aria-hidden size={15} />{t("users.add")}</button></div>
    {error && <p className="error">{error}</p>}
    <div className="table-card"><table><thead><tr><th>{t("common.user")}</th><th>{t("users.role")}</th><th>{t("users.createProjects")}</th><th>{t("users.ownedProjects")}</th><th>{t("users.status")}</th><th>{t("users.actions")}</th></tr></thead>
      <tbody>{users.map((target) => <tr key={target.id}><td><strong>{target.displayName}</strong><small>@{target.username}</small></td><td>{target.role === "admin" ? t("common.admin") : t("common.user")}</td><td>{target.canCreateProjects ? t("users.allow") : t("users.deny")}</td><td>{target.ownedProjects}</td><td>{target.disabled ? t("common.disabled") : t("common.normal")}</td><td>
        <button className="icon-button" disabled={target.id === currentUser.id} onClick={() => toggle(target)}>{target.disabled ? <UserCheck aria-hidden size={13} /> : <UserX aria-hidden size={13} />}{target.disabled ? t("users.enable") : t("users.disable")}</button>
        <button className="icon-button" disabled={target.id === currentUser.id} onClick={() => toggleRole(target)}>{target.role === "admin" ? <ShieldOff aria-hidden size={13} /> : <ShieldCheck aria-hidden size={13} />}{target.role === "admin" ? t("users.demote") : t("users.promote")}</button>
        <button className="icon-button" disabled={target.role === "admin"} onClick={() => toggleProjectCreation(target)}>{target.canCreateProjects ? <FolderX aria-hidden size={13} /> : <FolderCheck aria-hidden size={13} />}{target.canCreateProjects ? t("users.denyCreate") : t("users.allowCreate")}</button>
        <button className="icon-button" onClick={() => { setResetTarget(target); setResetValue(""); }}><KeyRound aria-hidden size={13} />{t("users.resetPassword")}</button>
        <button className="icon-button danger-text" disabled={target.id === currentUser.id} onClick={() => { setDeleteTarget(target); setDeleteProjects(false); setDeleteError(""); }}><Trash2 aria-hidden size={13} />{t("common.delete")}</button>
      </td></tr>)}</tbody></table></div>
    <Modal open={createOpen} title={t("users.add")} description={t("users.addDescription")} onOpenChange={setCreateOpen} footer={<><button className="icon-button" onClick={() => setCreateOpen(false)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={createForm.password.length < minPasswordLength} onClick={() => void create()}><UserPlus aria-hidden size={14} />{t("users.createUser")}</button></>}>
      <div className="form-stack"><label className="form-field">{t("auth.username")}<input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} /></label><label className="form-field">{t("users.displayName")}<input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /></label><label className="form-field">{t("users.initialPassword")}<span className="password-generator"><input minLength={minPasswordLength} autoComplete="new-password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} /><button type="button" title={t("users.generatePassword")} onClick={() => setCreateForm({ ...createForm, password: randomPassword() })}><Dices size={15} />{t("users.randomPassword")}</button></span><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label><label className="form-field">{t("users.role")}<select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "user" | "admin" })}><option value="user">{t("common.user")}</option><option value="admin">{t("common.admin")}</option></select></label><label className="checkbox-field"><input type="checkbox" checked={createForm.canCreateProjects || createForm.role === "admin"} disabled={createForm.role === "admin"} onChange={(e) => setCreateForm({ ...createForm, canCreateProjects: e.target.checked })} /> {t("users.allowCreate")}</label></div>
    </Modal>
    <Modal open={Boolean(resetTarget)} title={t("users.resetPassword")} description={t("users.resetDescription", { username: resetTarget?.username ?? "" })} onOpenChange={(open) => { if (!open) setResetTarget(null); }} footer={<><button className="icon-button" onClick={() => setResetTarget(null)}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="primary icon-button" disabled={resetValue.length < minPasswordLength} onClick={() => void resetPassword()}><KeyRound aria-hidden size={14} />{t("users.reset")}</button></>}>
      <label className="form-field">{t("auth.newPassword")}<input autoFocus type="password" minLength={minPasswordLength} autoComplete="new-password" value={resetValue} onChange={(e) => setResetValue(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: minPasswordLength })}</small></label>
    </Modal>
    <Modal open={Boolean(deleteTarget)} title={t("users.deleteTitle")} description={t("users.deleteDescription", { username: deleteTarget?.username ?? "" })} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(""); } }} footer={<><button className="icon-button" disabled={deleting} onClick={() => { setDeleteTarget(null); setDeleteError(""); }}><X aria-hidden size={14} />{t("common.cancel")}</button><button className="danger icon-button" disabled={deleting} aria-busy={deleting} onClick={() => void remove()}>{deleting ? <LoaderCircle className="spin" aria-hidden size={14} /> : <Trash2 aria-hidden size={14} />}{deleting ? t("common.loading") : t("users.deleteTitle")}</button></>}>
      <>{deleteError && <p className="error dialog-error">{deleteError}</p>}<fieldset className="choice-group" disabled={deleting}><legend>{t("users.ownedChoice", { count: deleteTarget?.ownedProjects ?? 0 })}</legend><label><input type="radio" checked={!deleteProjects} onChange={() => setDeleteProjects(false)} /> {t("users.transferProjects")}</label><label><input type="radio" checked={deleteProjects} onChange={() => setDeleteProjects(true)} /> {t("users.deleteProjects")}</label></fieldset></>
    </Modal>
    <ConfirmDialog
      open={Boolean(pendingSetting)}
      title={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Title`)}
      description={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Description`, { username: pendingSetting?.target.username ?? "" })}
      confirmLabel={t(`userConfirmations.${pendingSetting?.setting ?? "disable"}Confirm`)}
      danger
      busy={pendingSettingBusy}
      error={pendingSettingError}
      onCancel={() => { if (!pendingSettingBusy) { setPendingSetting(null); setPendingSettingError(""); } }}
      onConfirm={() => void applyRestrictedSetting()}
    />
  </main>;
}
