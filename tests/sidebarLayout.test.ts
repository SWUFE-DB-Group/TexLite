// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarLayout } from "../src/client/workspace/WorkspaceSidebarLayout";
import i18n from "../src/client/i18n";

const observers = new Set<LayoutObserver>();
class LayoutObserver implements ResizeObserver {
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  flush() {
    this.callback([...this.targets].map(target => {
      const size = [{ inlineSize: 260, blockSize: (target as HTMLElement).offsetHeight }];
      return { target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size, contentRect: target.getBoundingClientRect() };
    }), this);
  }
}
function height(element: HTMLElement): number {
  if (!element.isConnected) return 0;
  if (element.hasAttribute("data-separator")) return 6;
  if (!element.hasAttribute("data-panel")) return 800;
  const siblings = [...element.parentElement!.children] as HTMLElement[];
  const panels = siblings.filter(node => node.hasAttribute("data-panel"));
  const available = 800 - siblings.filter(node => node.hasAttribute("data-separator")).length * 6;
  const basis = (node: HTMLElement) => node.style.flexBasis.endsWith("%") ? parseFloat(node.style.flexBasis) / 100 : 0;
  const explicit = panels.reduce((sum, node) => sum + basis(node), 0);
  const grow = panels.reduce((sum, node) => sum + (parseFloat(node.style.flexGrow) || 0), 0);
  return available * (basis(element) || (1 - explicit) * (parseFloat(element.style.flexGrow) || 0) / (grow || 1));
}
function top(element: HTMLElement): number {
  if (!element.hasAttribute("data-panel") && !element.hasAttribute("data-separator")) return 0;
  const siblings = [...element.parentElement!.children];
  return siblings.slice(0, siblings.indexOf(element)).reduce((sum, node) => sum + height(node as HTMLElement), 0);
}
let root: Root, host: HTMLDivElement;
const storageKey = (phone = false) => `react-resizable-panels:texlite-file-outline-layout${phone ? ":phone" : ""}:file-tree:file-outline`;
const files = createElement("button", { type: "button" }, "Files");
const outline = createElement("button", { type: "button" }, "Outline");
const flush = () => act(async () => { for (const observer of [...observers]) observer.flush(); });
async function render(phone = false) {
  await act(async () => root.render(createElement(WorkspaceSidebarLayout, { files, outline, phone })));
  await flush();
}
async function key(value: string) {
  await act(async () => host.querySelector<HTMLElement>('[role="separator"]')!.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  await flush();
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return height(this); });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(260);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return top(this); });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, top(this), 260, height(this)); });
  localStorage.clear(); await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); observers.clear(); localStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("files/outline split", () => {
  it("resizes with the real separator, honors minimum heights and keeps both subtrees mounted", async () => {
    await render();
    const tree = host.querySelector<HTMLElement>("#file-tree")!;
    const outlinePanel = host.querySelector<HTMLElement>("#file-outline")!;
    const buttons = [...host.querySelectorAll("button")];
    expect(host.querySelector('[role="separator"]')?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(host.querySelector('[role="separator"]')?.getAttribute("aria-label")).toBe(i18n.t("editor.resizeFileOutline"));
    const initial = height(tree);
    await key("ArrowUp"); expect(height(tree)).toBeLessThan(initial);
    await key("ArrowDown"); expect(height(tree)).toBeCloseTo(initial);
    await key("Home"); expect(height(tree)).toBeCloseTo(120);
    await key("End"); expect(height(outlinePanel)).toBeCloseTo(100);
    expect([...host.querySelectorAll("button")]).toEqual(buttons);
    expect(localStorage.getItem(storageKey())).not.toBeNull();
  });

  it("restores saved proportions and keeps phone and desktop layouts independent", async () => {
    localStorage.setItem(storageKey(), JSON.stringify({ "file-tree": 70, "file-outline": 30 }));
    await render();
    expect(Number(host.querySelector<HTMLElement>("#file-tree")!.style.flexGrow)).toBeCloseTo(70);
    await act(async () => root.render(null)); await render(true);
    expect(Number(host.querySelector<HTMLElement>("#file-tree")!.style.flexGrow)).toBeCloseTo(60);
    await key("Home");
    expect(localStorage.getItem(storageKey(true))).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(storageKey())!)).toEqual({ "file-tree": 70, "file-outline": 30 });
    await act(async () => root.render(null)); await render();
    expect(Number(host.querySelector<HTMLElement>("#file-tree")!.style.flexGrow)).toBeCloseTo(70);
  });
});
