// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../src/shared/agentProtocol";

const terminal = vi.hoisted(() => ({ selected: false }));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {}; cols = 80; rows = 24;
    loadAddon() {}
    open(parent: HTMLElement) { parent.append(document.createElement("canvas")); }
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
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
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; close() {} send() {} });
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
