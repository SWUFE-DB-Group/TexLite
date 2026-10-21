import { useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AvatarStylePicker } from "./AvatarStylePicker";
import { api } from "./api";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { UserAvatar } from "./UserAvatar";
import type { User } from "./types";

export function AvatarSettingsDialog({ user, onClose, onSaved }: {
  user: User; onClose: () => void; onSaved: (user: User) => void;
}) {
  const { t } = useTranslation();
  const [style, setStyle] = useState<string | null>(user.avatarStyle ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const save = async () => {
    if (pending.current || style === (user.avatarStyle ?? null)) return;
    pending.current = true;
    setSaving(true); setError("");
    try {
      const result = await api<{ user: User }>("/api/me/avatar", { method: "PUT", body: JSON.stringify({ style }) });
      onSaved(result.user); onClose();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <Modal open className="avatar-settings-modal" title={t("account.avatarTitle")} description={t("account.avatarDescription")}
    onOpenChange={(open) => { if (!open && !pending.current) onClose(); }}
    footer={<><button type="button" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <button type="button" className="primary icon-button" disabled={saving || style === (user.avatarStyle ?? null)} aria-busy={saving} onClick={() => void save()}>
        {saving && <LoaderCircle className="spin" size={14} aria-hidden />}{t("common.save")}
      </button></>}>
    <div className="avatar-settings">
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      <div className="avatar-settings-choice">
        <AvatarStylePicker value={style} disabled={saving} onChange={setStyle} />
        <UserAvatar userId={user.id} name={user.displayName} username={user.username} avatarStyle={style}
          preview={style !== (user.avatarStyle ?? null)} className="avatar-style-preview" />
      </div>
      <p className="avatar-settings-note"><a href="https://www.dicebear.com/styles/" target="_blank" rel="noreferrer">{t("account.avatarStyles")}</a></p>
    </div>
  </Modal>;
}
