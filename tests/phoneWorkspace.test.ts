// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/client/i18n";
import { useWorkspaceLayout } from "../src/client/workspace/useWorkspaceLayout";
import { PHONE_WORKSPACE_QUERY, usePhoneWorkspaceHeight } from "../src/client/workspace/usePhoneWorkspace";
import { WorkspaceTopbarFrame } from "../src/client/workspace/WorkspaceTopbarFrame";
import { WorkspaceLayoutMenu } from "../src/client/workspace/WorkspaceChrome";
import { WorkspaceMobileDrawer } from "../src/client/workspace/WorkspaceMobileDrawer";

let root: Root, host: HTMLDivElement, phone: boolean;
const listeners = new Set<() => void>();
const selected = vi.fn();
const render = (node: React.ReactNode) => act(async () => root.render(node));
const click = (node: HTMLElement) => act(async () => node.click());
const resize = (value: boolean) => act(async () => { phone = value; listeners.forEach((notify) => notify()); });
beforeEach(async () => {
  phone = true; listeners.clear(); selected.mockReset(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ get matches() { return query === PHONE_WORKSPACE_QUERY && phone; },
    media: query, addEventListener: (_type: string, notify: () => void) => { if (query === PHONE_WORKSPACE_QUERY) listeners.add(notify); },
    removeEventListener: (_type: string, notify: () => void) => listeners.delete(notify) }));
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Layout() {
  const { workspaceLayout, setWorkspaceLayout, phone } = useWorkspaceLayout("writer", "paper");
  return createElement("div", { "data-layout": workspaceLayout, "data-phone": phone },
    createElement(WorkspaceLayoutMenu, { value: workspaceLayout, onChange: setWorkspaceLayout }));
}
function Toolbar() {
  const { workspaceLayout, setWorkspaceLayout } = useWorkspaceLayout("writer", "paper");
  return createElement(WorkspaceTopbarFrame, { siteName: "TexLite", projectName: "My paper", subtitle: "main.tex · Saved", onBack() {}, children: [
    createElement("button", { className: "files-action" }, "Files"),
    createElement(WorkspaceLayoutMenu, { value: workspaceLayout, onChange: setWorkspaceLayout, workspacePrimary: true }),
    createElement("button", { className: "comments-action" }, "Comments"),
    createElement("button", { className: "compile" }, "Compile"),
    createElement("button", { onClick: selected }, "Settings"),
    createElement("button", { disabled: true }, "Git")] });
}

describe("phone workspace", () => {
  it("uses full-width source/PDF views and restores desktop preferences independently", async () => {
    localStorage.setItem("texlite.workspaceLayout:writer:paper", "editor-pdf");
    await render(createElement(Layout));
    expect(host.firstElementChild?.getAttribute("data-layout")).toBe("editor-only");
    expect(host.querySelectorAll(".workspace-phone-views button")).toHaveLength(2);
    await click(host.querySelectorAll<HTMLButtonElement>(".workspace-phone-views button")[1]);
    expect(host.firstElementChild?.getAttribute("data-layout")).toBe("pdf-only");
    expect(localStorage.getItem("texlite.workspaceLayout:writer:paper")).toBe("editor-pdf");
    await resize(false);
    expect(host.firstElementChild?.getAttribute("data-layout")).toBe("editor-pdf");
    expect(host.querySelector(".layout-trigger")).not.toBeNull();
    await resize(true);
    expect(host.firstElementChild?.getAttribute("data-layout")).toBe("pdf-only");
  });
  it("keeps primary actions visible and puts secondary actions in an accessible popover", async () => {
    await render(createElement(Toolbar));
    expect(host.querySelector(".editor-actions")?.textContent).toBe("FilesSourcePDFCommentsCompile");
    expect(document.querySelector(".workspace-overflow-menu")).toBeNull();
    await click(host.querySelector<HTMLButtonElement>(".workspace-more-trigger")!);
    const menu = document.querySelector(".workspace-overflow-menu")!;
    expect(menu.textContent).toBe("SettingsGit");
    expect(menu.querySelectorAll<HTMLButtonElement>("button")[1].disabled).toBe(true);
    await click(menu.querySelector<HTMLButtonElement>("button")!);
    expect(selected).toHaveBeenCalledOnce();
    expect(document.querySelector(".workspace-overflow-menu")).toBeNull();
    await resize(false);
    expect(host.querySelector(".workspace-more-trigger")).toBeNull();
    expect(host.querySelector(".editor-actions")?.textContent).toContain("SettingsGit");
  });
  it("opens utilities without occupying a source panel and restores focus when closed", async () => {
    function Drawer() {
      const [open, setOpen] = useState(false);
      return createElement("div", null, createElement("button", { onClick: () => setOpen(true) }, "Files"),
        createElement(WorkspaceMobileDrawer, { files: true, open, title: "Project files", onClose: () => setOpen(false), children:
          createElement("button", { onClick: () => setOpen(false) }, "Close files") }));
    }
    await render(createElement(Drawer));
    const trigger = host.querySelector<HTMLButtonElement>("button")!;
    trigger.focus(); await click(trigger);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Project files");
    expect(document.querySelector(".workspace-mobile-files")).not.toBeNull();
    await click(document.querySelector<HTMLButtonElement>('[role="dialog"] button')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("tracks the keyboard's visual viewport and releases its listener on unmount", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 874 });
    vi.stubGlobal("visualViewport", viewport);
    function Height() { usePhoneWorkspaceHeight(true); return null; }
    await render(createElement(Height));
    expect(document.documentElement.style.getPropertyValue("--workspace-height")).toBe("874px");
    viewport.height = 430; viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--workspace-height")).toBe("430px");
    await render(null);
    expect(document.documentElement.style.getPropertyValue("--workspace-height")).toBe("");
    viewport.height = 600; viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--workspace-height")).toBe("");
  });
});
