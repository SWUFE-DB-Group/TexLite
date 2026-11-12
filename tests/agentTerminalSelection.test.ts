// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../src/shared/agentProtocol";

const terminal = vi.hoisted(() => ({ selected: false, fit: vi.fn(), resize: vi.fn() }));
let latestSocket: WebSocket;
let notifyResize: ResizeObserverCallback;

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { terminal.fit(); } } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {}; cols = 80; rows = 24;
    loadAddon() {}
    open(parent: HTMLElement) { parent.append(document.createElement("canvas")); }
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; terminal.resize(cols, rows); }
    hasSelection() { return terminal.selected; }
    getSelection() { return terminal.selected ? "picked text" : ""; }
    refresh() {} reset() {} write() {} focus() {} dispose() {}
  }
}));

const { AgentTerminalSurface } = await import("../src/client/agents/AgentTerminalSurface");

describe("agent terminal right click", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    terminal.fit.mockClear(); terminal.resize.mockClear();
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { notifyResize = callback; } observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; constructor() { latestSocket = this as unknown as WebSocket; } close() {} send() {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(AgentTerminalSurface, { task: { id: "t" } as AgentTask, onTask: () => {} })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const reaches = (type: string, init: MouseEventInit) => {
    const canvas = host.querySelector("canvas")!;
    const listener = vi.fn();
    canvas.addEventListener(type, listener);
    canvas.dispatchEvent(new MouseEvent(type, { ...init, bubbles: true }));
    return listener.mock.calls.length > 0;
  };
  const reachesTerminal = (button: number) => reaches("mousedown", { button });

  it("follows PTY dimensions while viewing and only fits locally after taking control", async () => {
    const receive = (data: unknown) => act(async () => latestSocket.onmessage?.call(latestSocket, new MessageEvent("message", { data: JSON.stringify(data) })));
    await receive({ type: "size", cols: 120, rows: 35 });
    expect(terminal.resize).toHaveBeenLastCalledWith(120, 35);
    const fitted = terminal.fit.mock.calls.length;
    await act(async () => notifyResize([], {} as ResizeObserver));
    expect(terminal.fit).toHaveBeenCalledTimes(fitted);
    await receive({ type: "control", writable: true });
    expect(terminal.fit.mock.calls.length).toBeGreaterThan(fitted);
    await receive({ type: "size", cols: 100, rows: 20 });
    expect(terminal.resize).toHaveBeenCalledTimes(1);
    await receive({ type: "control", writable: false });
    await receive({ type: "size", cols: 100, rows: 20 });
    expect(terminal.resize).toHaveBeenLastCalledWith(100, 20);
  });

  it("keeps a right click on a selection away from mouse reporting", () => {
    terminal.selected = true;
    expect(reachesTerminal(2)).toBe(false);
    expect(reachesTerminal(0)).toBe(true);
  });

  it("keeps pointer movement over a selection away from mouse reporting, but not a drag", () => {
    terminal.selected = true;
    expect(reaches("mousemove", { buttons: 0 })).toBe(false);
    expect(reaches("mousemove", { buttons: 1 })).toBe(true);
  });

  it("offers its own Copy menu for a selection and copies that text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    terminal.selected = true;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { host.querySelector("canvas")!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(writeText).toHaveBeenCalledWith("picked text");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes the menu on Escape without passing the key to the terminal", async () => {
    terminal.selected = true;
    await act(async () => { host.querySelector("canvas")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const canvas = host.querySelector("canvas")!;
    const listener = vi.fn();
    canvas.addEventListener("keydown", listener);
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves the browser menu alone without a selection", () => {
    terminal.selected = false;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    host.querySelector("canvas")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("still reports the mouse when nothing is selected", () => {
    terminal.selected = false;
    expect(reachesTerminal(2)).toBe(true);
    expect(reaches("mousemove", { buttons: 0 })).toBe(true);
  });
});
