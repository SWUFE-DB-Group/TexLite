// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CitationEntryMenu } from "../src/client/CitationEntryMenu";
import i18n from "../src/client/i18n";

const bibtex = '@article{example,\n  title = {A {Nested} title 中文},\n  author = {Ada and Bob}\n}';
let host: HTMLDivElement, root: Root;
const write = vi.fn(async (_text: string) => {});
const onTags = vi.fn(), onEdit = vi.fn(), onDelete = vi.fn();
let originalCopy: PropertyDescriptor | undefined;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  write.mockReset().mockResolvedValue();
  onTags.mockReset(); onEdit.mockReset(); onDelete.mockReset();
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(write);
  originalCopy = Object.getOwnPropertyDescriptor(document, "execCommand");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalCopy) Object.defineProperty(document, "execCommand", originalCopy);
  else delete (document as { execCommand?: Document["execCommand"] }).execCommand;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(manage = true, value = bibtex) {
  await act(async () => root.render(createElement(CitationEntryMenu, { citationKey: "example", bibtex: value,
    onTags: manage ? onTags : undefined, onEdit: manage ? onEdit : undefined, onDelete: manage ? onDelete : undefined })));
}
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
async function open() {
  await act(async () => host.querySelector('[aria-haspopup="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
}
const copyButton = () => host.querySelector<HTMLButtonElement>(".citation-copy-button")!;
const copy = () => act(async () => copyButton().click());

describe("citation entry actions", () => {
  it("collapses management actions into an accessible portal menu and preserves their callbacks", async () => {
    await render();
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(copyButton().textContent).toBe("Copy BibTeX");
    expect(host.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-label")).toBe("Actions for example");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    for (const [index, callback] of [[0, onTags], [1, onEdit], [2, onDelete]] as const) {
      await open();
      expect(items().map((item) => item.textContent)).toEqual(["Tags", "Edit", "Delete"]);
      expect(host.querySelector('[role="menu"]')).toBeNull(); // Not clipped by the citation list's scroll area.
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
      await act(async () => items()[index].click());
      expect(callback).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
    await open();
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("copies the full BibTeX entry directly and confirms success on the button for two seconds", async () => {
    await render(); vi.useFakeTimers();
    await copy();
    expect(write).toHaveBeenCalledExactlyOnceWith(bibtex);
    expect(copyButton().textContent).toBe("Copied");
    expect(copyButton().querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(copyButton().textContent).toBe("Copy BibTeX");
    expect(onTags).not.toHaveBeenCalled(); expect(onEdit).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
  });

  it("offers only the direct copy button when no management actions are available", async () => {
    await render(false);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
    await copy();
    expect(write).toHaveBeenCalledExactlyOnceWith(bibtex);
  });

  it.each(["absent", "denied"])("uses a selection-based fallback when Clipboard API access is %s", async (mode) => {
    if (mode === "absent") vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as unknown as Clipboard);
    else write.mockRejectedValue(new Error("Not allowed"));
    let selected = "";
    const legacyCopy = vi.fn(() => {
      const input = document.activeElement as HTMLTextAreaElement;
      selected = input.value.slice(input.selectionStart, input.selectionEnd);
      expect(input.closest(".citation-entry-controls")).not.toBeNull();
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: legacyCopy });
    await render(); await copy();
    expect(legacyCopy).toHaveBeenCalledExactlyOnceWith("copy");
    expect(selected).toBe(bibtex);
    expect(copyButton().textContent).toBe("Copied");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports copy failures on the action and allows a retry without claiming success", async () => {
    write.mockRejectedValueOnce(new Error("Permission denied"));
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    await render(); await copy();
    expect(copyButton().textContent).toBe("Copy failed. Try again.");
    expect(document.querySelector("textarea")).toBeNull();
    await copy();
    expect(copyButton().textContent).toBe("Copied");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("blocks duplicate copying and ignores late results when the entry changes", async () => {
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(); await copy();
    expect(copyButton().textContent).toBe("Copying…");
    expect(copyButton().disabled).toBe(true);
    await copy(); expect(write).toHaveBeenCalledOnce();
    await render(true, '@article{example, title={Changed}}');
    await act(async () => finish());
    expect(copyButton().textContent).toBe("Copy BibTeX");
    await copy();
    expect(write).toHaveBeenLastCalledWith('@article{example, title={Changed}}');
  });
});
