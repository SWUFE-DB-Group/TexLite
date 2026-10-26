// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { useAgentAccess } from "../src/client/agents/useAgentAccess";
import { Dashboard } from "../src/client/pages/Dashboard";
import { WorkspaceTopbar, type WorkspaceTopbarProps } from "../src/client/workspace/WorkspaceTopbar";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import i18n from "../src/client/i18n";
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
const noop = () => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset().mockImplementation(async (url) => (url === "/api/tags" ? { tags: [] }
    : { projects: [], pagination }) as never);
  vi.mocked(useAgentAccess).mockReset().mockReturnValue({ visible: true, activeCount: 2 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); localStorage.clear(); vi.unstubAllGlobals();
});

describe("active task entry badges", () => {
  it.each(["user", "admin"] as const)("shows the signed-in %s's count on the homepage and removes it at zero", async (role) => {
    const user: User = { id: `viewer-${role}`, username: role, displayName: role, role,
      disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-26" };
    const render = () => act(async () => root.render(createElement(Dashboard, { site, user,
      initialData: { projects: [], tags: [], pagination }, onDataChange: noop, onUser: noop, onOpenProject: noop })));
    await render();
    expect(useAgentAccess).toHaveBeenCalledWith(user.id);
    const badge = host.querySelector(".top-actions sup");
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-label")).toBe("Your active tasks: 2");
    expect(badge?.parentElement?.textContent).toContain(i18n.t(role === "admin" ? "agents.title" : "agents.tasks"));
    vi.mocked(useAgentAccess).mockReturnValue({ visible: true, activeCount: 0 });
    await render();
    expect(host.querySelector(".top-actions sup")).toBeNull();
  });

  it("keeps the project's terminal count visible when closed or open and omits zero", async () => {
    const toggle = vi.fn();
    const props: WorkspaceTopbarProps = {
      site, project, activeFile: "main.tex", saveStateLabel: "Saved", editorPreferences: defaultEditorPreferences,
      activeSessions: [], collaborationStatus: "connected", reconnectCollaboration: noop, protocolUpgradeRequired: false,
      showEditor: true, filesCollapsed: false, toggleFilesPanel: noop, workspaceLayout: "editor-pdf", changeWorkspaceLayout: noop,
      onBack: noop, onShare: noop, showCitationLibrary: false, citationLibraryOpen: false, onCitationLibrary: noop,
      onHistory: noop, onGit: noop, canManageGit: true, formatting: false, readOnly: false, collaborationSynced: true,
      onToggleComments: noop, commentsOpen: false, unresolvedCommentCount: 0, onToggleSettings: noop, settingsOpen: false,
      compileBusy: false, sharedCompiling: false, localCompiling: false, cancelling: false, onCompile: noop, onCancelCompile: noop
    };
    const render = (open: boolean, activeCount: number) => act(async () => root.render(createElement(WorkspaceTopbar,
      { ...props, agentTerminal: { open, activeCount, toggle } })));
    await render(false, 1);
    const entry = host.querySelector<HTMLButtonElement>('button[aria-label^="Terminal"]')!;
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
