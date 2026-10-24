import { lazy, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronRight, Languages, LoaderCircle, LogOut, Palette, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { User } from "./types";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { errorMessage } from "./errors";
import { GitHubIcon } from "./GitHubIcon";
import { UserAvatar } from "./UserAvatar";
import { LazyModal } from "./LazyLoadBoundary";
import { appLocale } from "../shared/locales";

const AvatarSettingsDialog = lazy(() => import("./AvatarSettingsDialog").then((module) => ({ default: module.AvatarSettingsDialog })));

export function UserMenu({ user, onGitHub, onSignOut, onUserChange }: {
  user: User;
  onGitHub: () => void;
  onSignOut: () => Promise<void>;
  onUserChange?: (user: User) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const openingGitHub = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const languageId = useId();
  const name = user.displayName || user.username;
  const signOut = async () => {
    if (pending.current) return;
    pending.current = true;
    setSigningOut(true);
    setError("");
    try { await onSignOut(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setSigningOut(false); }
  };

  return <><Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) setError(""); }}>
    <Popover.Trigger asChild>
      <button type="button" className="user-menu-trigger" aria-label={t("account.menu", { name })}>
        <UserAvatar userId={user.id} name={name} username={user.username} avatarStyle={user.avatarStyle} className="user-menu-avatar" /><span className="user-menu-name">{name}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={content} tabIndex={-1} className="user-menu-content" align="end" sideOffset={10} collisionPadding={12} aria-label={t("account.menu", { name })}
        onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }}
        onCloseAutoFocus={(event) => { if (openingGitHub.current) event.preventDefault(); openingGitHub.current = false; }}>
        <div className="user-menu-profile">
          <UserAvatar userId={user.id} name={name} username={user.username} avatarStyle={user.avatarStyle} className="user-menu-avatar" />
          <div><strong>{name}</strong><span>@{user.username}</span></div>
          <button type="button" className="user-menu-github" aria-label={t("account.openGithubSettings")} data-tooltip={t("account.githubTitle")}
            onClick={() => { openingGitHub.current = true; setOpen(false); onGitHub(); }}><GitHubIcon size={19} /></button>
        </div>
        <div className="user-menu-settings">
          <button type="button" className="user-menu-avatar-setting" onClick={() => { openingGitHub.current = true; setOpen(false); setAvatarOpen(true); }}>
            <span className="user-menu-setting-label"><UserRound size={16} aria-hidden />{t("account.avatarTitle")}</span><ChevronRight size={14} aria-hidden />
          </button>
          <div className="user-menu-language">
            <label htmlFor={languageId}><Languages size={16} aria-hidden="true" />{t("common.language")}</label>
            <div className="user-menu-language-select"><select id={languageId} value={appLocale(i18n.resolvedLanguage)} onChange={(event) => void i18n.changeLanguage(event.target.value)}>
              <option value="en">{t("common.languageEnglish")}</option><option value="zh">{t("common.languageChinese")}</option><option value="zh-Hant">{t("common.languageTraditionalChinese")}</option>
            </select><ChevronDown size={13} aria-hidden="true" /></div>
          </div>
          <div className="user-menu-theme"><span className="user-menu-setting-label"><Palette size={16} aria-hidden="true" />{t("theme.title")}</span><ThemeSwitcher /></div>
        </div>
        {error && <p className="user-menu-error" role="alert">{error}</p>}
        <button type="button" className="user-menu-signout" disabled={signingOut} aria-busy={signingOut} onClick={() => void signOut()}>
          {signingOut ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}{t("auth.logout")}
        </button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>{avatarOpen && <LazyModal title={t("account.avatarTitle")} onClose={() => setAvatarOpen(false)}>
    <AvatarSettingsDialog user={user} onClose={() => setAvatarOpen(false)} onSaved={(updated) => onUserChange?.(updated)} />
  </LazyModal>}</>;
}
