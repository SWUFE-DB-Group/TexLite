// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfoPopover } from "../src/client/InfoPopover";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import { Modal } from "../src/client/Dialog";
import { CompileCleanup } from "../src/client/workspace/CompileOutput";
import i18n from "../src/client/i18n";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  host.remove();
  vi.unstubAllGlobals();
});

describe("clickable help", () => {
  it("only toggles on activation, retaining selectable text despite outside interaction and disabled hover hints", async () => {
    host.dataset.texliteTooltips = "off";
    await act(async () => root.render(createElement(Fragment, null,
      createElement(InfoPopover, { content: "Help text to select and copy." }), createElement(GlobalTooltip))));
    const trigger = host.querySelector<HTMLButtonElement>(".info-popover-trigger")!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      trigger.focus();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("title")).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => trigger.click());
    const content = document.querySelector<HTMLElement>(".info-popover-content")!;
    expect(content.textContent).toBe("Help text to select and copy.");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const range = document.createRange();
    range.selectNodeContents(content.querySelector("p")!);
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe("Help text to select and copy.");
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: content }));
      content.click();
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      document.body.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector(".info-popover-content")).toBe(content);
    await act(async () => trigger.click());
    expect(document.querySelector(".info-popover-content")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps normal hover tooltips unchanged and removes help when its owner unmounts", async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(InfoPopover, { label: "Command help", content: createElement("ul", null,
        createElement("li", null, createElement("code", null, "git status"))) }),
      createElement("button", { "data-tooltip": "Normal hover hint" }, "Action"), createElement(GlobalTooltip))));
    const normal = host.querySelector<HTMLButtonElement>("[data-tooltip]")!;
    await act(async () => normal.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe("Normal hover hint");
    await act(async () => normal.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>(".info-popover-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("Command help");
    await act(async () => trigger.click());
    const content = document.querySelector(".info-popover-content")!;
    expect(content.querySelector("ul > li > code")?.textContent).toBe("git status");
    expect(content.querySelector("p")).toBeNull();
    await act(async () => root.render(null));
    expect(document.querySelector(".info-popover-content")).toBeNull();
  });

  it("keeps cleanup help inside its modal, accessible even when cleanup actions are disabled", async () => {
    await i18n.changeLanguage("en");
    const onOpenChange = vi.fn();
    await act(async () => root.render(createElement(Modal, { open: true, title: "Compilation", description: "Cleanup", onOpenChange,
      children: createElement(CompileCleanup, { mainFile: "main.tex", disabled: true, cleaning: false, onCleanCache: vi.fn(), onCleanArtifacts: vi.fn() }) })));
    const modal = document.querySelector<HTMLElement>(".dialog-content")!;
    expect([...modal.querySelectorAll<HTMLButtonElement>(".compile-clean-operation")].every(button => button.disabled)).toBe(true);
    const triggers = modal.querySelectorAll<HTMLButtonElement>(".compile-clean-help");
    expect(triggers).toHaveLength(2);
    for (const [index, trigger] of triggers.entries()) {
      expect(trigger.disabled).toBe(false);
      await act(async () => trigger.click());
      const help = document.querySelector<HTMLElement>(".info-popover-content")!;
      expect(modal.contains(help)).toBe(true);
      expect(help.textContent).toBe(i18n.t(index === 0 ? "editor.cleanCacheDescription" : "editor.cleanArtifactsDescription"));
      await act(async () => help.click());
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => trigger.click());
      expect(document.querySelector(".info-popover-content")).toBeNull();
    }
  });
});
