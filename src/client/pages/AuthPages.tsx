import { useId, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { SiteFooter, SiteLogo } from "./SiteChrome";

function PasswordField({ label, hint, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & { label: string; hint?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const toggleLabel = t(visible ? "auth.hidePassword" : "auth.showPassword");
  return <div className="auth-password-field">
    <label htmlFor={id}>{label}</label>
    <div className="auth-password-input">
      <input {...input} id={id} type={visible ? "text" : "password"} />
      <button type="button" className="auth-password-toggle" aria-label={toggleLabel} title={toggleLabel} aria-controls={id} aria-pressed={visible}
        onMouseDown={(event) => event.preventDefault()} onClick={() => setVisible(value => !value)}>
        {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </div>
    {hint && <small className="field-hint">{hint}</small>}
  </div>;
}

export function ChangePassword({ site, user, onChanged }: { site: SiteConfig; user: User; onChanged: (user: User) => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (newPassword !== confirm) return setError(t("auth.mismatch"));
    if (newPassword.length < site.minPasswordLength) return setError(t("auth.passwordMinimum", { count: site.minPasswordLength }));
    try {
      setSaving(true);
      await api("/api/me/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged({ ...user, mustChangePassword: false });
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  };
  return <main className="login-page"><LanguageSwitcher /><form className="login-card" onSubmit={submit}>
    <SiteLogo siteName={site.siteName} auth /><h1 className="sr-only">{site.siteName}</h1><p className="muted">{t("auth.firstLogin")}</p>
    <PasswordField label={t("auth.currentPassword")} required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
    <PasswordField label={t("auth.newPassword")} required minLength={site.minPasswordLength} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} hint={t("auth.passwordMinimum", { count: site.minPasswordLength })} />
    <PasswordField label={t("auth.confirmPassword")} required minLength={site.minPasswordLength} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
    {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={saving}>{t("auth.updatePassword")}</button>
  </form><SiteFooter /></main>;
}
export function Login({ site, onLogin }: { site: SiteConfig; onLogin: (user: User) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }), suppressSessionExpired: true
      });
      onLogin(result.user);
    } catch (err) { setError(errorMessage(err)); }
  };
  return <main className="login-page"><LanguageSwitcher />
    <form className="login-card" onSubmit={submit}>
      <SiteLogo siteName={site.siteName} auth />
      <h1 className="sr-only">{site.siteName}</h1>
      <p className="muted">{t("auth.tagline")}</p>
      <label>{t("auth.username")}<input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <PasswordField label={t("auth.password")} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit">{t("auth.login")}</button>
      {site.adminEmail && <small className="support">{t("auth.contact", { email: site.adminEmail })}</small>}
    </form><SiteFooter />
  </main>;
}
