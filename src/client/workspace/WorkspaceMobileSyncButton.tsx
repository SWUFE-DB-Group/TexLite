import { useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

/** One direction per phone view; leave the source/PDF tabs as plain switches. */
export function WorkspaceMobileSyncButton({ direction, disabled, onClick }: {
  direction: "pdf" | "source";
  disabled: boolean;
  onClick: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const Icon = direction === "pdf" ? ArrowRight : ArrowLeft;
  const label = t(direction === "pdf" ? "editor.showInPdf" : "editor.showInSource");
  return <button type="button" className={`workspace-mobile-sync workspace-mobile-sync-${direction}`}
    title={label} aria-label={label} aria-busy={busy} disabled={disabled || busy}
    onClick={async () => {
      setBusy(true);
      try { await onClick(); }
      finally { setBusy(false); }
    }}>
    {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}
  </button>;
}
