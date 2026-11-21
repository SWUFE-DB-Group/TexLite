import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "../basePath";

export type DrawioLockState = { status: "connecting" | "owned" | "busy" | "lost" | "readonly"; token: string; name: string; revision?: string };
const empty = (status: DrawioLockState["status"]): DrawioLockState => ({ status, token: "", name: "" });

/** One connection per mounted diagram editor, not per login/account. */
export function useDrawioLock(projectId: string, path: string, readOnly: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DrawioLockState>(() => empty(readOnly ? "readonly" : "connecting"));
  const current = useRef(state);
  const releaseCurrent = useRef<() => void>(null);
  const relinquish = useCallback((token: string) => {
    if (current.current.status === "owned" && current.current.token === token) releaseCurrent.current?.();
  }, []);
  useEffect(() => {
    let disposed = false;
    const update = (next: DrawioLockState) => {
      if (disposed) return;
      current.current = next; setState(next);
    };
    if (readOnly) { update(empty("readonly")); return; }
    update(empty("connecting"));
    const url = new URL(appPath(`/api/projects/${projectId}/drawio/lock?${new URLSearchParams({ path })}`), window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | undefined;
    let settled = false, ended = false;
    let timeout: number | undefined;
    const release = () => {
      ended = true; window.clearTimeout(timeout); update(empty("lost"));
      current.current = empty("lost");
      if (socket?.readyState === WebSocket.OPEN) socket.send("release");
      socket?.close();
    };
    releaseCurrent.current = release;
    // Full-page navigation/bfcache may not unmount React first. Merely
    // backgrounding a tab does not release its editing ownership.
    window.addEventListener("pagehide", release);
    // StrictMode's probe mount must not open an abandoned connection.
    queueMicrotask(() => {
      if (disposed || ended) return;
      try { socket = new WebSocket(url); } catch { update(empty("lost")); return; }
      timeout = window.setTimeout(() => { ended = true; update(empty("lost")); socket?.close(); }, 15_000);
      socket.onmessage = (event) => {
        if (disposed || ended) return;
        let message: { type?: string; token?: string; name?: string; revision?: string };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === "acquired" && typeof message.token === "string") {
          settled = true; window.clearTimeout(timeout); update({ status: "owned", token: message.token, name: "", revision: message.revision });
        } else if (message.type === "busy" && typeof message.name === "string") {
          settled = true; window.clearTimeout(timeout); update({ status: "busy", token: "", name: message.name });
        }
      };
      socket.onclose = () => {
        ended = true;
        window.clearTimeout(timeout);
        if (!settled || current.current.status !== "busy") update(empty("lost"));
      };
      socket.onerror = () => { ended = true; window.clearTimeout(timeout); update(empty("lost")); socket?.close(); };
    });
    return () => {
      disposed = true; ended = true; window.clearTimeout(timeout);
      window.removeEventListener("pagehide", release);
      releaseCurrent.current = null;
      // A connecting socket's close() cancels its handshake; the server also
      // checks readyState after waiting for the project mutation queue.
      release();
    };
  }, [projectId, path, readOnly, attempt]);
  return { state, current, relinquish, retry: () => setAttempt((value) => value + 1) };
}
