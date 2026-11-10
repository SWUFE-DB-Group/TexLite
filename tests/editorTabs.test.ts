// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "../src/client/workspace/EditorTabs";
import { clampTabDrag, moveTab, tabDropIndex, tabShift } from "../src/client/workspace/editorTabOrder";
import i18n from "../src/client/i18n";

const slots = [{ left: 0, width: 100 }, { left: 103, width: 40 }, { left: 146, width: 200 }];

describe("editor tab order", () => {
  it("moves a tab to its new index and leaves other input alone", () => {
    const tabs = ["a", "b", "c", "d"];
    expect(moveTab(tabs, "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTab(tabs, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTab(tabs, "b", 1)).toBe(tabs);
    expect(moveTab(tabs, "missing", 1)).toBe(tabs);
  });

  it("passes a neighbor only when the leading edge reaches its middle", () => {
    expect(tabDropIndex(slots, 0, 22)).toBe(0);
    expect(tabDropIndex(slots, 0, 24)).toBe(1);
    expect(tabDropIndex(slots, 0, 147)).toBe(2);
    expect(tabDropIndex(slots, 2, -22)).toBe(2);
    expect(tabDropIndex(slots, 2, -24)).toBe(1);
    expect(tabDropIndex(slots, 2, -97)).toBe(0);
  });

  it("keeps the dragged tab inside the strip", () => {
    expect(clampTabDrag(slots, 0, -50)).toBe(0);
    expect(clampTabDrag(slots, 0, 999)).toBe(246);
    expect(clampTabDrag(slots, 2, -999)).toBe(-146);
  });

  it("opens room equal to the dragged tab and the gap", () => {
    expect(tabShift(slots, 0, 2, 1)).toBe(-103);
    expect(tabShift(slots, 0, 2, 2)).toBe(-103);
    expect(tabShift(slots, 2, 1, 1)).toBe(203);
    expect(tabShift(slots, 2, 1, 0)).toBe(0);
  });
});

describe("dragging editor tabs", () => {
  let host: HTMLElement;
  let root: Root;
  const activateTab = vi.fn();
  const closeTab = vi.fn();
  const reorderTab = vi.fn();
  const tabs = ["a.tex", "b.tex", "c.tex"];
  const render = (openTabs = tabs) => act(async () => root.render(createElement(EditorTabs, {
    openTabs, activeFile: "a.tex", projectMainFile: "a.tex", activateTab, closeTab, reorderTab, handleTabKeyDown: () => {}
  })));
  const item = (index: number) => host.querySelectorAll<HTMLElement>(".editor-tab-item")[index];
  const strip = () => host.querySelector<HTMLElement>(".editor-tabs-scroll")!;
  const pointer = (target: Element, type: string, clientX: number, init: PointerEventInit = {}) => act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", clientX, ...init }));
  });
  const tabButton = (index: number) => item(index).querySelector<HTMLButtonElement>(".editor-tab")!;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("en");
    for (const mock of [activateTab, closeTab, reorderTab]) mock.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = this.classList.contains("editor-tab-item") ? Array.from(this.parentElement!.children).indexOf(this) : -1;
      return (index < 0 ? { left: 0, right: 300, width: 300 } : { left: index * 100, right: index * 100 + 100, width: 100 }) as DOMRect;
    });
    Object.assign(HTMLElement.prototype, { setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("follows the pointer, makes room, and commits only on release", async () => {
    await pointer(tabButton(1), "pointerdown", 150);
    await pointer(strip(), "pointermove", 215);
    expect(item(1).classList.contains("dragging")).toBe(true);
    expect(item(1).style.transform).toBe("translateX(65px)");
    expect(item(2).style.transform).toBe("translateX(-100px)");
    expect(item(0).style.transform).toBe("");
    expect(reorderTab).not.toHaveBeenCalled();
    await pointer(strip(), "pointerup", 215);
    expect(reorderTab).toHaveBeenCalledExactlyOnceWith("b.tex", 2);
    expect(activateTab).toHaveBeenCalledExactlyOnceWith("b.tex");
    expect(item(1).style.transform).toBe("");
  });

  it("does not treat the click that ends a drag as a click on a tab", async () => {
    await pointer(tabButton(1), "pointerdown", 150);
    await pointer(strip(), "pointermove", 215);
    await pointer(strip(), "pointerup", 215);
    activateTab.mockClear();
    await act(async () => tabButton(2).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(activateTab).not.toHaveBeenCalled();
    await pointer(tabButton(2), "pointerdown", 250);
    await pointer(tabButton(2), "pointerup", 250);
    await act(async () => tabButton(2).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(activateTab).toHaveBeenCalledExactlyOnceWith("c.tex");
  });

  it("leaves a press without movement as an ordinary click", async () => {
    await pointer(tabButton(1), "pointerdown", 150);
    await pointer(strip(), "pointermove", 152);
    expect(strip().classList.contains("reordering")).toBe(false);
    await pointer(strip(), "pointerup", 152);
    expect(reorderTab).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it("makes no change when the tab is dropped where it started", async () => {
    await pointer(tabButton(0), "pointerdown", 50);
    await pointer(strip(), "pointermove", 70);
    await pointer(strip(), "pointermove", 50);
    await pointer(strip(), "pointerup", 50);
    expect(reorderTab).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    await pointer(tabButton(1), "pointerdown", 150);
    await pointer(strip(), "pointermove", 215);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(strip().classList.contains("reordering")).toBe(false);
    await pointer(strip(), "pointerup", 215);
    expect(reorderTab).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  it("cancels when the open tabs change during a drag", async () => {
    await pointer(tabButton(1), "pointerdown", 150);
    await pointer(strip(), "pointermove", 215);
    await render(["a.tex", "b.tex"]);
    expect(strip().classList.contains("reordering")).toBe(false);
    await pointer(strip(), "pointerup", 215);
    expect(reorderTab).not.toHaveBeenCalled();
  });

  it("does not start a drag from a close button, a finger, or a lone tab", async () => {
    await pointer(item(1).querySelector(".editor-tab-close")!, "pointerdown", 190);
    await pointer(strip(), "pointermove", 250);
    expect(strip().classList.contains("reordering")).toBe(false);
    await pointer(tabButton(1), "pointerdown", 150, { pointerType: "touch" });
    await pointer(strip(), "pointermove", 250, { pointerType: "touch" });
    expect(strip().classList.contains("reordering")).toBe(false);
    await render(["a.tex"]);
    await pointer(tabButton(0), "pointerdown", 50);
    await pointer(strip(), "pointermove", 90);
    expect(strip().classList.contains("reordering")).toBe(false);
  });
});
