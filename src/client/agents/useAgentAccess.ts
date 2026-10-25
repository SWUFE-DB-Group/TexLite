import { useEffect, useState } from "react";
import { api } from "../api";

export function useAgentAccess(scope: string): { visible: boolean } {
  const [access, setAccess] = useState({ visible: false });
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      void api<{ visible: boolean }>("/api/agents/access", { signal: controller.signal })
        .then((value) => { if (!disposed) setAccess(value); }).catch(() => undefined);
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("texlite:agents-policy", load);
    return () => { disposed = true; controller?.abort(); window.removeEventListener("focus", load); window.removeEventListener("texlite:agents-policy", load); };
  }, [scope]);
  return access;
}
