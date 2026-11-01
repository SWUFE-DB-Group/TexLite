// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCommentsSlot } from "../src/client/workspace/WorkspaceCommentsSlot";
import i18n from "../src/client/i18n";

let host: HTMLDivElement, root: Root, containerWidth: number, reserve: number;
const observers = new Set<{ notify: () => void }>();
const key = "texlite-comments-width";
function Harness({ open }: { open: boolean }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return createElement("div", { className: "workspace-output-layout" },
    createElement(WorkspaceCommentsSlot, { open, onHost: setTarget }),
    createElement("div", { className: "preview-panel" }, "PDF remains mounted"),
    target && createPortal(createElement("textarea", { defaultValue: "Unsent reply" }), target));
}
const render = (open = true) => act(async () => root.render(createElement(Harness, { open })));
const slot = () => host.querySelector<HTMLDivElement>(".workspace-comments-slot")!;
const width = () => Number.parseFloat(slot().style.getPropertyValue("--workspace-comments-width"));
const observe = () => act(async () => { for (const observer of observers) observer.notify(); });
const pointer = (target: Element, type: string, clientX: number, pointerId = 1, button = 0) => act(async () => {
  target.dispatchEvent(new PointerEvent(type, { pointerId, clientX, button, bubbles: true, cancelable: true }));
});
function handle() {
  const element = host.querySelector<HTMLDivElement>('[role="separator"]')!;
  const captures = new Set<number>();
  Object.assign(element, {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id)
  });
  return element;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  window.localStorage.clear(); containerWidth = 1000; reserve = 320;
  vi.stubGlobal("ResizeObserver", class {
    entry: { notify: () => void };
    constructor(callback: () => void) { this.entry = { notify: callback }; observers.add(this.entry); }
    observe() {}
    disconnect() { observers.delete(this.entry); }
  });
  const rectangle = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-output-layout")) return { width: containerWidth } as DOMRect;
    if (this.classList.contains("workspace-comments-slot")) {
      this.style.setProperty("--comments-preview-reserve", `${reserve}px`);
      const preferred = Number.parseFloat(this.style.getPropertyValue("--workspace-comments-width"));
      return { width: Math.min(containerWidth - reserve, Math.max(280, preferred)) } as DOMRect;
    }
    return rectangle.call(this);
  });
  // Computed styles in happy-dom do not evaluate container queries.
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element.classList.contains("workspace-comments-slot")) (element as HTMLElement).style.setProperty("--comments-preview-reserve", `${reserve}px`);
    return computed.call(window, element, pseudo);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); observers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("resizable comment portal", () => {
  it("drags only the comment width within bounds and saves the completed gesture", async () => {
    await render();
    const divider = handle();
    expect(divider.getAttribute("aria-label")).toBe("Resize comments panel");
    const text = host.querySelector("textarea")!, pdf = host.querySelector(".preview-panel");
    await pointer(divider, "pointerdown", 360);
    await pointer(divider, "pointermove", 540);
    expect(width()).toBe(540); expect(window.localStorage.getItem(key)).toBeNull();
    await pointer(divider, "pointermove", 9999);
    expect(width()).toBe(640);
    await pointer(divider, "pointerup", 9999);
    expect(window.localStorage.getItem(key)).toBe("640");
    expect(slot().hasAttribute("data-resizing")).toBe(false);
    expect(host.querySelector("textarea")).toBe(text); expect(host.querySelector(".preview-panel")).toBe(pdf);
    await observe(); expect(divider.getAttribute("aria-valuenow")).toBe("640");
  });

  it("cancels a gesture without changing saved preferences and ignores unrelated pointer events", async () => {
    window.localStorage.setItem(key, "400"); await render();
    const divider = handle();
    await pointer(divider, "pointerdown", 400, 1, 2);
    expect(slot().hasAttribute("data-resizing")).toBe(false);
    await pointer(divider, "pointerdown", 400);
    await pointer(divider, "pointermove", 550, 2); expect(width()).toBe(400);
    await pointer(divider, "pointermove", 550); expect(width()).toBe(550);
    await pointer(divider, "pointercancel", 550);
    expect(width()).toBe(400); expect(window.localStorage.getItem(key)).toBe("400");
    expect(slot().hasAttribute("data-resizing")).toBe(false);
  });

  it("uses the rendered width after narrowing and keeps the portal, draft and PDF intact", async () => {
    window.localStorage.setItem(key, "600"); await render();
    const target = slot(), text = host.querySelector("textarea")!, pdf = host.querySelector(".preview-panel");
    containerWidth = 500; reserve = 0; await observe();
    const divider = handle(); expect(divider.getAttribute("aria-valuenow")).toBe("500");
    await pointer(divider, "pointerdown", 500); await pointer(divider, "pointermove", 420);
    expect(width()).toBe(420); // No jump back to the saved 600 px preference.
    await pointer(divider, "pointerup", 420);
    await render(false); expect(observers.size).toBe(0); expect(slot().hidden).toBe(true);
    await render(); expect(slot()).toBe(target); expect(width()).toBe(420);
    expect(host.querySelector("textarea")).toBe(text); expect(text.value).toBe("Unsent reply");
    expect(host.querySelector(".preview-panel")).toBe(pdf);
  });

  it("supports keyboard resizing, reserves space for the PDF and resets on double-click", async () => {
    containerWidth = 800; await render(); const divider = handle();
    const press = (key: string, shiftKey = false) => act(async () => { divider.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
    await press("ArrowRight"); expect(width()).toBe(376);
    await press("ArrowLeft", true); expect(width()).toBe(328);
    await press("End"); expect(width()).toBe(480); // 320 px remains for the PDF.
    await press("Home"); expect(width()).toBe(280);
    await act(async () => divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(width()).toBe(360); expect(window.localStorage.getItem(key)).toBe("360");
  });

  it("stops observing and releases pointer capture when closed during a drag", async () => {
    await render(); const divider = handle();
    await pointer(divider, "pointerdown", 360); expect(divider.hasPointerCapture(1)).toBe(true);
    await render(false); expect(divider.hasPointerCapture(1)).toBe(false); expect(observers.size).toBe(0);
    await render(); expect(slot().hasAttribute("data-resizing")).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("continues resizing when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    await render(); expect(width()).toBe(360);
    const divider = handle();
    await pointer(divider, "pointerdown", 360); await pointer(divider, "pointermove", 450); await pointer(divider, "pointerup", 450);
    expect(width()).toBe(450);
  });
});
