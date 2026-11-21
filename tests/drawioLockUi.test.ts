// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDrawioLock } from "../src/client/workspace/useDrawioLock";

vi.mock("../src/client/basePath", () => ({ appPath: (path: string) => `/tools/texlite${path}` }));
class Socket {
  static OPEN = 1; static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: URL) { Socket.instances.push(this); }
  message(value: object) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
  acquire(token = "token-1") { this.readyState = 1; this.message({ type: "acquired", token }); }
}
let root: Root, host: HTMLDivElement, lock: ReturnType<typeof useDrawioLock>;
function Harness({ path = "figure.drawio", readOnly = false }: { path?: string; readOnly?: boolean }) {
  lock = useDrawioLock("p1", path, readOnly); return null;
}
const render = (path = "figure.drawio", readOnly = false) => act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { path, readOnly }))));
beforeEach(() => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("browser draw.io lock lifecycle", () => {
  it("opens one mounted connection under StrictMode, uses the base path, and releases on unmount", async () => {
    await render(); expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    expect(socket.url.pathname).toBe("/tools/texlite/api/projects/p1/drawio/lock");
    expect(socket.url.searchParams.get("path")).toBe("figure.drawio");
    await act(async () => socket.acquire());
    expect(lock.state.status).toBe("owned");
    await act(async () => root.render(null));
    expect(socket.send).toHaveBeenCalledExactlyOnceWith("release"); expect(socket.close).toHaveBeenCalledOnce();
    expect(lock.current.current.token).toBe("");
    await act(async () => socket.message({ type: "acquired", token: "late" }));
    expect(lock.current.current.token).toBe("");
  });

  it("keeps a busy editor read-only, retries explicitly, and ignores old connections after switching files", async () => {
    await render(); const first = Socket.instances[0];
    await act(async () => { first.message({ type: "busy", name: "Writer" }); first.close(); });
    expect(lock.state).toMatchObject({ status: "busy", name: "Writer", token: "" });
    await act(async () => lock.retry());
    const second = Socket.instances[1]; await act(async () => second.acquire("second"));
    await act(async () => first.message({ type: "acquired", token: "stale" }));
    expect(lock.current.current.token).toBe("second");
    await render("other.drawio");
    expect(second.send).toHaveBeenCalledWith("release"); expect(second.close).toHaveBeenCalledOnce();
    await act(async () => Socket.instances[2].acquire("third"));
    await act(async () => second.onclose?.());
    expect(lock.current.current.token).toBe("third");
  });

  it("does not open locks for readers and releases ownership when permission becomes read-only", async () => {
    await render("figure.drawio", true);
    expect(Socket.instances).toHaveLength(0); expect(lock.state.status).toBe("readonly");
    await render(); const socket = Socket.instances[0]; await act(async () => socket.acquire());
    await render("figure.drawio", true);
    expect(Socket.instances).toHaveLength(1); expect(socket.send).toHaveBeenCalledWith("release");
    expect(lock.state.status).toBe("readonly"); expect(lock.current.current.token).toBe("");
  });

  it("drops ownership immediately on disconnect and refuses a late grant after initialization times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render(); const first = Socket.instances[0]; await act(async () => first.acquire());
    await act(async () => first.close()); expect(lock.current.current.token).toBe("");
    await act(async () => lock.retry()); const next = Socket.instances[1];
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(next.close).toHaveBeenCalledOnce(); expect(lock.state.status).toBe("lost");
    await act(async () => next.acquire("too-late"));
    expect(lock.current.current.token).toBe(""); expect(lock.state.status).toBe("lost");
  });

  it("can give up an unreconciled lease without releasing a successor", async () => {
    await render(); const first = Socket.instances[0]; await act(async () => first.acquire("first"));
    await act(async () => lock.relinquish("first"));
    expect(first.send).toHaveBeenCalledExactlyOnceWith("release");
    expect(lock.state.status).toBe("lost");
    await act(async () => lock.retry()); const second = Socket.instances[1]; await act(async () => second.acquire("second"));
    await act(async () => lock.relinquish("first"));
    expect(second.close).not.toHaveBeenCalled();
    expect(lock.current.current.token).toBe("second");
  });

  it("releases on pagehide even without React unmounting, and ignores a late queued grant", async () => {
    await render(); const socket = Socket.instances[0]; await act(async () => socket.acquire());
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(socket.send).toHaveBeenCalledExactlyOnceWith("release"); expect(lock.state.status).toBe("lost");
    await act(async () => socket.acquire("late"));
    expect(lock.current.current.token).toBe("");
  });
});
