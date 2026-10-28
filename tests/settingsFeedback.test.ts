// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "../src/client/workspace/ProjectSettings";
import { HistoryDialog } from "../src/client/HistoryDialog";
import { TagManagementDialog } from "../src/client/pages/TagManagementDialog";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import { defaultTerminalPreferences, saveTerminalPreferences } from "../src/client/terminalPreferences";
import { api } from "../src/client/api";
import type { HistoryVersion, Project, SiteConfig } from "../src/client/types";

vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en" } }) }));
vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/latexFormatter", () => ({ preloadTexFmt: vi.fn(async () => undefined), reloadTexFmt: vi.fn(async () => undefined) }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? createElement("div", null, children, footer) : null,
  ConfirmDialog: () => null
}));

const project: Project = { id: "paper", ownerId: "owner", lastModifiedBy: null, name: "Paper", mainFile: "main.tex", latexmkrc: null,
  engine: "xelatex", icon: null, chktexEnabled: false, permission: "owner", tags: [], createdAt: "2026-10-26", updatedAt: "2026-10-26" };
const site: SiteConfig = { siteName: "TexLite", adminEmail: "", basePath: "/", minPasswordLength: 8, maxCitationBibtexBytes: 10000,
  maxUploadSizeMB: 50, maxCollaborativeFileSizeMB: 3 };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saveTerminalPreferences(defaultTerminalPreferences);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ available: false, mainFiles: ["main.tex"] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const status = () => host.querySelector(".operation-success")?.textContent;
const saveFeedback = () => host.querySelector(".drawer-settings-save span")?.textContent;
const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
function changeText(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function settings(onEditorPreferences = vi.fn()) {
  const onProject = vi.fn();
  await act(async () => root.render(createElement(ProjectSettings, { project, projectId: project.id, site, files: [], dictionaryWords: [],
    editorPreferences: defaultEditorPreferences, onEditorPreferences, onDictionaryChange: vi.fn(), onProject, onClose: vi.fn(),
    spellCheckCount: null, spellCheckUniqueCount: null, spellCheckIndex: 0, onSpellCheckNavigate: vi.fn() })));
  return { onProject, onEditorPreferences };
}

describe("settings save feedback", () => {
  it("uses a compact shared header label while keeping each tab's bottom save label", async () => {
    await settings();
    for (const [tab, bottomKey] of [["appearance", "saveAppearance"], ["terminal", "saveTerminal"], ["compiler", "saveCompiler"]]) {
      await click(`#settings-tab-${tab}`);
      expect(host.querySelector(".drawer-settings-save")?.textContent).toBe("common.save");
      expect(host.querySelector(`#settings-panel-${tab} .settings-save`)?.textContent).toBe(`projectSettings.${bottomKey}`);
    }
  });
  it.each(["appearance", "terminal"].flatMap((tab) => [".drawer-settings-save", ".settings-save"].map((button) => ({ tab, button }))))(
    "confirms $tab on both save buttons through $button and restores their labels after two seconds", async ({ tab, button }) => {
      await settings();
      await click(`#settings-tab-${tab}`);
      await click(button);
      expect(saveFeedback()).toBe("editor.saved");
      expect(host.querySelector(".settings-save")?.textContent).toBe("editor.saved");
      expect(status()).toBeUndefined();
      await act(async () => vi.advanceTimersByTime(2000));
      expect(saveFeedback()).toBe("common.save");
      expect(host.querySelector(".settings-save")?.textContent).toBe(`projectSettings.${tab === "terminal" ? "saveTerminal" : "saveAppearance"}`);
    }
  );

  it("reports local-storage failures without claiming that terminal preferences were saved", async () => {
    await settings(); await click("#settings-tab-terminal");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    await click(".drawer-settings-save");
    expect(saveFeedback()).toBe("common.save");
    expect(status()).toBeUndefined();
    expect(host.querySelector(".error")?.textContent).toBe("projectSettings.appearanceSaveFailed");
  });

  it("clears stale success when saving editor preferences fails", async () => {
    const save = vi.fn(); await settings(save);
    await click(".drawer-settings-save"); expect(saveFeedback()).toBe("editor.saved");
    save.mockImplementationOnce(() => { throw new Error("Storage disabled"); });
    await click(".drawer-settings-save");
    expect(saveFeedback()).toBe("common.save"); expect(host.querySelector(".error")?.textContent).toBe("projectSettings.appearanceSaveFailed");
  });

  it("confirms compiler settings only after the server accepts them and blocks duplicate saves", async () => {
    const { onProject } = await settings(); await click("#settings-tab-compiler");
    const input = host.querySelector<HTMLInputElement>('#settings-panel-compiler input:not([type="checkbox"])')!;
    await act(async () => changeText(input, "Updated paper"));
    let resolve!: (value: { project: Project }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    await click(".drawer-settings-save");
    expect(saveFeedback()).toBe("common.save"); expect(host.querySelector<HTMLButtonElement>(".drawer-settings-save")!.disabled).toBe(true);
    await click(".drawer-settings-save");
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1);
    await act(async () => resolve({ project: { ...project, name: "Updated paper" } }));
    expect(onProject).toHaveBeenCalledOnce(); expect(saveFeedback()).toBe("editor.saved");
    expect(host.querySelector(".settings-save")?.textContent).toBe("editor.saved");
    expect(status()).toBeUndefined();
  });

  it("distinguishes unchanged settings from an unsuccessful server save", async () => {
    await settings(); await click("#settings-tab-compiler");
    await click(".drawer-settings-save"); expect(saveFeedback()).toBe("common.noChangesToSave");
    expect(status()).toBeUndefined();
    await act(async () => changeText(host.querySelector<HTMLInputElement>('#settings-panel-compiler input:not([type="checkbox"])')!, "Updated"));
    vi.mocked(api).mockRejectedValueOnce(new Error("Server rejected save"));
    await click(".drawer-settings-save");
    expect(saveFeedback()).toBe("common.save"); expect(host.querySelector(".error")).not.toBeNull();
  });

  it("does not show another tab's success, including a compiler response arriving after switching tabs", async () => {
    await settings();
    await click(".drawer-settings-save");
    await click("#settings-tab-terminal");
    expect(saveFeedback()).toBe("common.save");
    expect(host.querySelector(".settings-save")?.textContent).toBe("projectSettings.saveTerminal");
    await click("#settings-tab-compiler");
    await act(async () => changeText(host.querySelector<HTMLInputElement>('#settings-panel-compiler input:not([type="checkbox"])')!, "Updated paper"));
    let resolve!: (value: { project: Project }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    await click(".drawer-settings-save");
    await click("#settings-tab-terminal");
    await act(async () => resolve({ project: { ...project, name: "Updated paper" } }));
    expect(saveFeedback()).toBe("common.save");
    await click("#settings-tab-compiler");
    expect(saveFeedback()).toBe("editor.saved");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(saveFeedback()).toBe("common.save");
    expect(host.querySelector(".settings-save")?.textContent).toBe("projectSettings.saveCompiler");
  });

  it("restarts button feedback for consecutive saves instead of clearing at the first save's deadline", async () => {
    await settings(); await click(".drawer-settings-save");
    await act(async () => vi.advanceTimersByTime(1500));
    await click(".drawer-settings-save");
    await act(async () => vi.advanceTimersByTime(500));
    expect(saveFeedback()).toBe("editor.saved");
    await act(async () => vi.advanceTimersByTime(1500));
    expect(saveFeedback()).toBe("common.save");
  });

  it("confirms a project tag edit inside its management dialog", async () => {
    const tag = { id: "tag", name: "Paper", color: "blue" as const, projectCount: 1 };
    vi.mocked(api).mockResolvedValueOnce({ tags: [tag] });
    await act(async () => root.render(createElement(TagManagementDialog, { open: true, onOpenChange: vi.fn(),
      onTagCreated: vi.fn(), onTagUpdated: vi.fn(), onTagDeleted: vi.fn() })));
    await click('[aria-label="tags.edit"]');
    await act(async () => changeText(host.querySelector<HTMLInputElement>(".tag-management-edit input")!, "Renamed"));
    vi.mocked(api).mockResolvedValueOnce({ tag: { ...tag, name: "Renamed" } });
    await click(".tag-management-edit-actions .save-button");
    expect(status()).toBeUndefined();
    expect(host.querySelector(".tag-management-edit-actions .save-button")?.textContent).toBe("editor.saved");
  });

  it("confirms a saved snapshot name inside the snapshot dialog", async () => {
    const version: HistoryVersion = { id: "v", snapshotHash: "a".repeat(64), reason: "file", label: null,
      createdAt: "2026-10-26T00:00:00Z", author: null, changedPaths: [], fileCount: 0, totalSize: 0 };
    vi.mocked(api).mockResolvedValueOnce({ versions: [version], stats: null, nextCursor: null })
      .mockResolvedValueOnce({ version, files: [], settings: { mainFile: "main.tex", engine: "xelatex", latexmkrc: null } });
    await act(async () => root.render(createElement(HistoryDialog, { open: true, project, onOpenChange: vi.fn(), onBeforeMutation: async () => true })));
    await act(async () => changeText(host.querySelector<HTMLInputElement>(".history-label input")!, "Before review"));
    vi.mocked(api).mockResolvedValueOnce({ version: { ...version, label: "Before review" }, stats: null, retentionScheduled: false });
    await click(".history-label-save");
    expect(status()).toBeUndefined();
    expect(host.querySelector(".history-label-save")?.textContent).toBe("editor.saved");
    expect(host.querySelector(".history-label-save .save-button-confirmation")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.querySelector(".history-label-save")?.textContent).toBe("history.saveLabel");
  });
});
