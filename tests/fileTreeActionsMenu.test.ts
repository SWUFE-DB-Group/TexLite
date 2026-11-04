// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTreeActionsMenu } from "../src/client/workspace/FileTreeActionsMenu";
import { Modal } from "../src/client/Dialog";
import { QuickOpenDialog } from "../src/client/QuickOpenDialog";
import i18n from "../src/client/i18n";

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});
const menu = () => document.querySelector<HTMLElement>(".file-actions-menu");
async function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>(".file-tools-more")!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
}

describe("file tree overflow actions", () => {
  it("shows labelled actions and closes the menu after creating a folder", async () => {
    const onQuickOpen = vi.fn(), onNewFolder = vi.fn(), onProjectSearch = vi.fn();
    await act(async () => root.render(createElement(FileTreeActionsMenu, { onQuickOpen, onNewFolder, onProjectSearch })));
    expect(menu()).toBeNull();
    await openMenu();
    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([i18n.t("navigation.quickOpen"), i18n.t("projectSearch.title"), i18n.t("editor.newFolder")]);
    await act(async () => items[1].click());
    expect(onProjectSearch).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    await openMenu();
    await act(async () => menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')[2].click());
    expect(onNewFolder).toHaveBeenCalledOnce();
    expect(onQuickOpen).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it("keeps quick open usable without exposing a folder mutation to readers", async () => {
    const onQuickOpen = vi.fn(), onProjectSearch = vi.fn();
    await act(async () => root.render(createElement(FileTreeActionsMenu, { onQuickOpen, onProjectSearch })));
    await openMenu();
    const items = menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(items).toHaveLength(2);
    await act(async () => items[0].click());
    expect(onQuickOpen).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("opens quick open from a modal drawer without trapping or stealing the new dialog's focus", async () => {
    function Drawer() {
      const [quickOpen, setQuickOpen] = useState(false);
      return createElement("div", null,
        createElement(Modal, { open: true, title: "Files", onOpenChange() {}, children:
          createElement(FileTreeActionsMenu, { onQuickOpen: () => setQuickOpen(true) }) }),
        createElement(QuickOpenDialog, { open: quickOpen, files: [], onOpenChange: setQuickOpen, onOpenFile() {} }));
    }
    await act(async () => root.render(createElement(Drawer)));
    await openMenu();
    expect(menu()!.closest('[role="dialog"]')?.textContent).toContain("Files");
    await act(async () => menu()!.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const input = document.querySelector<HTMLInputElement>(".quick-open-dialog input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(menu()).toBeNull();
  });
});
