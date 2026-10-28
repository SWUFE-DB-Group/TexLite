import { useCallback, useEffect, useRef, useState } from "react";

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
