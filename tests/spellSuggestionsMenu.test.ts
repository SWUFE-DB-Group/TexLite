// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpellSuggestionsMenu, writingSuggestionPosition } from "../src/client/SpellSuggestionsMenu";
import type { SpellCheckIssue } from "../src/client/spellCheck";
import i18n from "../src/client/i18n";

describe("writing suggestion placement", () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { left: 320, top: 420, bottom: 440 };

  it("places the actual menu just above the affected line, not at the editor's top", () => {
    expect(writingSuggestionPosition(anchor, { width: 250, height: 180 }, viewport))
      .toEqual({ left: 320, top: 234, maxHeight: 406 });
  });

  it("uses the space below a line near the viewport top instead of covering or clipping it", () => {
    expect(writingSuggestionPosition({ left: 320, top: 40, bottom: 60 }, { width: 250, height: 180 }, viewport))
      .toEqual({ left: 320, top: 66, maxHeight: 726 });
  });

  it("keeps the preferred upper placement even when there is more room below", () => {
    expect(writingSuggestionPosition({ left: 320, top: 240, bottom: 260 }, { width: 250, height: 180 }, viewport).top)
      .toBe(54);
  });

  it("clamps horizontal placement at both edges and on narrow screens", () => {
    expect(writingSuggestionPosition({ ...anchor, left: 990 }, { width: 250, height: 180 }, viewport).left).toBe(742);
    expect(writingSuggestionPosition({ ...anchor, left: -10 }, { width: 250, height: 180 }, viewport).left).toBe(8);
    expect(writingSuggestionPosition(anchor, { width: 144, height: 180 }, { width: 160, height: 800 }).left).toBe(8);
  });

  it("constrains long messages/lists to the larger available space without covering the line", () => {
    expect(writingSuggestionPosition(anchor, { width: 250, height: 650 }, viewport))
      .toEqual({ left: 320, top: 8, maxHeight: 406 });
  });
});

describe("writing suggestion popup", () => {
  let root: Root;
  let host: HTMLDivElement;
  const issue: SpellCheckIssue = { from: 0, to: 5, word: "appl", kind: "spelling", message: "Check this spelling.", suggestions: ["apple", "apply"] };
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    await i18n.changeLanguage("en");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 250, 180));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies measured viewport coordinates and renders outside panel clipping", async () => {
    const onReplace = vi.fn();
    await act(async () => root.render(createElement(SpellSuggestionsMenu, {
      issue, anchor: { left: 320, top: 420, bottom: 440 }, readOnly: false, onReplace
    })));
    const menu = document.querySelector<HTMLElement>(".spell-suggestions-menu")!;
    expect(menu.parentElement).toBe(document.body);
    expect(host.querySelector(".spell-suggestions-menu")).toBeNull();
    expect(menu.style.left).toBe("320px");
    expect(menu.style.top).toBe("234px");
    expect(menu.style.maxHeight).toBe("406px");
    expect(menu.style.visibility).toBe("visible");
    await act(async () => menu.querySelector<HTMLButtonElement>("button")!.click());
    expect(onReplace).toHaveBeenCalledWith("apple");
  });

  it("preserves read-only feedback and prevents replacement", async () => {
    const onReplace = vi.fn();
    await act(async () => root.render(createElement(SpellSuggestionsMenu, {
      issue, anchor: { left: 320, top: 40, bottom: 60 }, readOnly: true, onReplace
    })));
    const menu = document.querySelector<HTMLElement>(".spell-suggestions-menu")!;
    expect(menu.style.top).toBe("66px");
    expect(menu.querySelector(".spell-suggestions-readonly")?.textContent).toBe(i18n.t("editor.spellCheckReadOnly"));
    const button = menu.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("keeps no-fix grammar or ChkTeX diagnostics readable", async () => {
    await act(async () => root.render(createElement(SpellSuggestionsMenu, {
      issue: { ...issue, kind: "latex", suggestions: [] }, anchor: { left: 320, top: 420, bottom: 440 }, readOnly: false, onReplace: vi.fn()
    })));
    const menu = document.querySelector<HTMLElement>(".spell-suggestions-menu")!;
    expect(menu.querySelector(".spell-suggestions-message")?.textContent).toBe(issue.message);
    expect(menu.querySelector(".spell-suggestions-empty")?.textContent).toBe(i18n.t("editor.noWritingSuggestions"));
    expect(menu.querySelector("button")).toBeNull();
  });
});
