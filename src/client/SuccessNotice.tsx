import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Restart the display interval even when two successful saves have the same text. */
export function useSuccessNotice() {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setMessage("");
  }, []);
  const show = useCallback((value: string) => {
    if (!mounted.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    setMessage(value);
    timer.current = setTimeout(() => { timer.current = null; setMessage(""); }, 2000);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) clearTimeout(timer.current); };
  }, []);
  return { message, show, clear };
}

export function SuccessNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  if (!message) return null;
  return <div className="operation-success" role="status" aria-live="polite">
    <CheckCircle2 size={14} aria-hidden /><span>{message}</span>
    <button type="button" aria-label={t("common.close")} onClick={onDismiss}><X size={13} aria-hidden /></button>
  </div>;
}
