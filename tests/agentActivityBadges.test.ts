// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { useAgentAccess } from "../src/client/agents/useAgentAccess";
import { Dashboard } from "../src/client/pages/Dashboard";
import { WorkspaceTopbar, type WorkspaceTopbarProps } from "../src/client/workspace/WorkspaceTopbar";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import i18n from "../src/client/i18n";
import { defaultTerminalPreferences, saveTerminalPreferences } from "../src/client/terminalPreferences";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import type { Project, SiteConfig, User } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/agents/useAgentAccess", () => ({ useAgentAccess: vi.fn() }));
vi.mock("../src/client/UpdateNotification", () => ({ UpdateNotification: () => null }));

const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "", minPasswordLength: 8,
  maxCitationBibtexBytes: 102400, maxUploadSizeMB: 100, maxCollaborativeFileSizeMB: 10 };
const project: Project = { id: "paper", ownerId: "writer", ownerDisplayName: "Writer", name: "Paper",
  mainFile: "main.tex", lastModifiedBy: "writer", latexmkrc: null, engine: "pdflatex", icon: null,
  chktexEnabled: false, permission: "owner", tags: [], createdAt: "2026-10-26", updatedAt: "2026-10-26" };
const pagination = { page: 1, pageSize: 20, total: 0, totalPages: 0 };
const counts = { all: 0, owned: 0, shared: 0 };
const filters = { ownership: "all", archived: false, search: "", tag: "", sort: "updated" } as const;
const noop = () => {};
const topbarProps: WorkspaceTopbarProps = {
  site, project, activeFile: "main.tex", saveStateLabel: "Saved", editorPreferences: defaultEditorPreferences,
  activeSessions: [], collaborationStatus: "connected", reconnectCollaboration: noop, protocolUpgradeRequired: false,
  showEditor: true, filesCollapsed: false, toggleFilesPanel: noop, workspaceLayout: "editor-pdf", changeWorkspaceLayout: noop,
  onBack: noop, onShare: noop, showCitationLibrary: false, citationLibraryOpen: false, onCitationLibrary: noop,
  onHistory: noop, onGit: noop, canManageGit: true, formatting: false, readOnly: false, collaborationSynced: true,
  onToggleComments: noop, commentsOpen: false, unresolvedCommentCount: 0, onToggleSettings: noop, settingsOpen: false,
  compileBusy: false, sharedCompiling: false, localCompiling: false, cancelling: false, onCompile: noop, onCancelCompile: noop
};
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  saveTerminalPreferences(defaultTerminalPreferences);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset().mockImplementation(async (url) => (url === "/api/tags" ? { tags: [] }
    : { projects: [], pagination, counts }) as never);
  vi.mocked(useAgentAccess).mockReset().mockReturnValue({ visible: true, activeCount: 2 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); localStorage.clear(); vi.unstubAllGlobals();
});

describe("active task entry badges", () => {
  it("omits duplicate homepage hints with visible labels but keeps icon-only hints and other tooltips", async () => {
    let compact = false;
    const listeners = new Set<() => void>();
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.stubGlobal("matchMedia", (query: string) => query === "(max-width: 1250px)" ? {
      get matches() { return compact; },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
    } : originalMatchMedia(query));
    const user: User = { id: "admin", username: "admin", displayName: "Admin", role: "admin",
      disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-26" };
    await act(async () => root.render(createElement(Fragment, null, createElement(Dashboard, { site, user,
      initialData: { projects: [], tags: [], pagination, counts, filters }, onDataChange: noop, onUser: noop, onOpenProject: noop }), createElement(GlobalTooltip))));
    const actions = [...host.querySelectorAll<HTMLButtonElement>(".top-actions > .ghost, .project-catalog-heading .section-actions > button")];
    const buttons = ["metrics.title", "users.manage", "citationLibrary.title", "agents.title",
      "tags.manage", "projects.upload", "projects.new"].map((key) => {
      const label = i18n.t(key);
      const button = actions.find((action) => action.getAttribute("aria-label") === label);
      expect(button, label).toBeDefined();
      return button!;
    });
    const hover = (button: HTMLElement) => act(async () => button.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const leave = (button: HTMLElement) => act(async () => button.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    for (const button of buttons) {
      await hover(button);
      expect(host.querySelector('[role="tooltip"]')).toBeNull();
      expect(button.hasAttribute("title")).toBe(false);
      expect(button.getAttribute("aria-label")).toBeTruthy();
      await leave(button);
    }
    await act(async () => { compact = true; listeners.forEach((notify) => notify()); });
    for (const button of buttons) {
      await hover(button);
      expect(host.querySelector('[role="tooltip"]')?.textContent).toBe(button.getAttribute("aria-label"));
      await leave(button);
    }
    await hover(buttons[0]);
    await act(async () => { compact = false; listeners.forEach((notify) => notify()); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await leave(buttons[0]);
    const gridToggle = host.querySelector<HTMLButtonElement>(".view-toggle button")!;
    await hover(gridToggle);
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe(i18n.t("projects.grid"));
  });

  it.each(["user", "admin"] as const)("shows the signed-in %s's count on the homepage and removes it at zero", async (role) => {
    const user: User = { id: `viewer-${role}`, username: role, displayName: role, role,
      disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-26" };
    const render = () => act(async () => root.render(createElement(Dashboard, { site, user,
      initialData: { projects: [], tags: [], pagination, counts, filters }, onDataChange: noop, onUser: noop, onOpenProject: noop })));
    await render();
    expect(useAgentAccess).toHaveBeenCalledWith(user.id);
    const badge = host.querySelector(".top-actions sup");
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-label")).toBe("Your active tasks: 2");
    expect(badge?.parentElement?.textContent).toContain(i18n.t(role === "admin" ? "agents.title" : "agents.tasks"));
    const entry = badge!.parentElement;
    await act(async () => saveTerminalPreferences({ ...defaultTerminalPreferences, showExecutionReminder: false }));
    expect(host.querySelector(".top-actions sup")).toBeNull();
    expect(entry?.isConnected).toBe(true);
    await act(async () => saveTerminalPreferences(defaultTerminalPreferences));
    expect(host.querySelector(".top-actions sup")?.textContent).toBe("2");
    vi.mocked(useAgentAccess).mockReturnValue({ visible: true, activeCount: 0 });
    await render();
    expect(host.querySelector(".top-actions sup")).toBeNull();
  });

  it("keeps the project's terminal count visible when closed or open and omits zero", async () => {
    const toggle = vi.fn();
    const render = (open: boolean, activeCount: number) => act(async () => root.render(createElement(WorkspaceTopbar,
      { ...topbarProps, agentTerminal: { open, activeCount, toggle } })));
    await render(false, 1);
    const entry = host.querySelector<HTMLButtonElement>('button[aria-label^="Terminal"]')!;
    expect(entry.querySelector("sup")?.textContent).toBe("1");
    await act(async () => saveTerminalPreferences({ ...defaultTerminalPreferences, showExecutionReminder: false }));
    expect(entry.querySelector("sup")).toBeNull();
    expect(entry.getAttribute("aria-label")).toBe("Terminal");
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    await act(async () => saveTerminalPreferences(defaultTerminalPreferences));
    expect(entry.querySelector("sup")?.textContent).toBe("1");
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(entry.getAttribute("aria-label")).toBe("Terminal: Your active task: 1");
    await act(async () => entry.click());
    expect(toggle).toHaveBeenCalledOnce();
    await render(true, 1);
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    expect(entry.querySelector("sup")?.textContent).toBe("1");
    await render(false, 0);
    expect(entry.querySelector("sup")).toBeNull();
    expect(entry.getAttribute("aria-label")).toBe("Terminal");
  });
});

it("shows the shared member count even when nobody is online, updates it and hides zero", async () => {
  const onShare = vi.fn();
  for (const count of [undefined, 0, 3, 1, 0]) {
    await act(async () => root.render(createElement(WorkspaceTopbar,
      { ...topbarProps, onShare, project: { ...project, sharedMemberCount: count } })));
    const button = host.querySelector<HTMLButtonElement>('.share-action')!;
    expect(button.querySelector('sup')?.textContent).toBe(count ? String(count) : undefined);
    expect(button.getAttribute('aria-label')).toBe(count ? `Share (${count})` : 'Share');
  }
  await act(async () => host.querySelector<HTMLButtonElement>('.share-action')!.click());
  expect(onShare).toHaveBeenCalledOnce();
});

it("retains accessible toolbar names and full layout choices when toolbar labels are compacted", async () => {
  const changeWorkspaceLayout = vi.fn();
  const render = (layout: WorkspaceTopbarProps["workspaceLayout"]) => act(async () => root.render(createElement(WorkspaceTopbar, {
    ...topbarProps, workspaceLayout: layout, changeWorkspaceLayout, showCitationLibrary: true,
    agentTerminal: { open: false, activeCount: 2, toggle: noop }
  })));
  await render("editor-pdf");
  const actions = host.querySelectorAll<HTMLButtonElement>(".editor-actions > button, .layout-trigger");
  expect(actions).toHaveLength(10);
  for (const action of actions) expect(action.getAttribute("aria-label")).toBeTruthy();
  const compile = host.querySelector<HTMLButtonElement>("button.compile")!;
  expect(compile.getAttribute("aria-label")).toBe("Compile · pdflatex");
  expect(compile.querySelector(".compile-engine-label")?.textContent).toBe(" · pdflatex");
  expect(compile.querySelector(".workspace-action-label")?.firstChild?.textContent).toBe("Compile");
  const trigger = host.querySelector<HTMLButtonElement>(".layout-trigger")!;
  expect(trigger.querySelector(".lucide-columns-2")).not.toBeNull();
  await act(async () => trigger.click());
  const choices = host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
  expect(choices).toHaveLength(3);
  for (const choice of choices) {
    expect(choice.querySelector("strong")?.textContent).toBeTruthy();
    expect(choice.querySelector("small")?.textContent).toBeTruthy();
    expect(choice.querySelector(".workspace-action-label")).toBeNull();
  }
  await act(async () => choices[2].click());
  expect(changeWorkspaceLayout).toHaveBeenCalledWith("pdf-only");
  expect(host.querySelector('[role="menu"]')).toBeNull();
  await render("pdf-only");
  expect(trigger.querySelector(".lucide-panel-right")).not.toBeNull();
  expect(trigger.getAttribute("aria-label")).toContain(i18n.t("editor.layout.pdf-only.name"));
});
