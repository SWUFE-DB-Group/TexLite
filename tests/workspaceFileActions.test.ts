// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilePanel, type WorkspaceFilePanelProps } from "../src/client/workspace/WorkspaceFilePanel";
import { createSourceCursorStore } from "../src/client/workspace/sourceCursorStore";
import i18n from "../src/client/i18n";

vi.mock("react-resizable-panels", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-resizable-panels")>(),
  Group: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Separator: () => null,
  Panel: ({ children }: { children: ReactNode }) => createElement("section", null, children)
}));

const copyPath = vi.fn(async () => {});
const setDeleteEntry = vi.fn();

function panelProps(readOnly: boolean): WorkspaceFilePanelProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  const props: WorkspaceFilePanelProps = {
    project: { id: "paper", ownerId: "owner", name: "Paper", mainFile: "main.tex", lastModifiedBy: null,
      latexmkrc: null, engine: "pdflatex", icon: null, chktexEnabled: false, permission: readOnly ? "read" : "owner",
      tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    filesPanel: { current: null }, visibleEntries: [
      { path: "data", type: "directory" }, { path: "main.tex", type: "file" }, { path: "data/论文 & notes.txt", type: "file" }
    ], activeFile: "main.tex", activeMainFile: "main.tex", selectedFile: "main.tex", selectedFolder: null,
    expandedFolders: new Set(["data"]), fileDragActive: false, uploadingFiles: false, uploadFeedback: null,
    readOnly, formatting: false, canFormat: false, activeFormatLease: false, collaborationSynced: true,
    editorFontSize: 14, outline: [], sourceCursorStore: createSourceCursorStore(), wordCountBusy: false,
    hasSelection: false, hasFormatSelection: false, uploadInput: { current: null },
    setSelectedFolder: noop, setExpandedFolders: noop, setMoveEntry: noop, setMoveName: noop,
    setMoveDestination: noop, setDeleteEntry, setFileDialogError: noop, setNewFolderName: noop,
    setNewFolderOpen: noop, setNewFilePath: noop, setNewFileOpen: noop, tikzGalleryEnabled: true, setTikzGalleryOpen: noop, setQuickOpen: noop,
    setFileDragActive: noop, dismissUploadFeedback: noop, setFilesCollapsed: noop, onError: noop,
    uploadFiles: asyncNoop, refreshFiles: noop, upload: asyncNoop, openFile: noop, movePathToFolder: asyncNoop, copyPath,
    onFormatFile: noop, onFormatSelection: noop, jumpToSource: noop, syncSourceToPdf: asyncNoop, onWordCount: noop
  };
  return props;
}

function render(readOnly = false): string {
  return renderToStaticMarkup(createElement(WorkspaceFilePanel, panelProps(readOnly)));
}

async function openMenu(readOnly: boolean, fileName: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(WorkspaceFilePanel, panelProps(readOnly))));
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t("editor.fileActions", { name: fileName })}"]`)!;
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return items;
}
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  copyPath.mockClear();
  setDeleteEntry.mockClear();
  vi.unstubAllGlobals();
});

describe("file tree row actions", () => {
  it("lets file and folder move tooltips follow the workspace preference", () => {
    const moveButtons = [...render().matchAll(/<button\b[^>]*>.*?<\/button>/g)]
      .map(([button]) => button).filter((button) => button.includes("lucide-move"));
    expect(moveButtons).toHaveLength(3);
    for (const button of moveButtons) {
      expect(button).not.toContain("data-texlite-tooltip-always");
      expect(button).toContain(`title="${i18n.t("editor.move")}"`);
      expect(button).toContain(`aria-label="${i18n.t("editor.move")}"`);
    }
  });

  it("keeps move on the row and puts download, copy and delete in each file's menu", async () => {
    const rows = [...render().matchAll(/<div class="file-entry(?: [^"]*)?"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]);
    expect(rows).toHaveLength(3);
    // Folders keep their own move and delete buttons and have no menu.
    expect(rows[0]).not.toContain("lucide-ellipsis");
    for (const row of rows.slice(1)) {
      expect(row.indexOf("lucide-move")).toBeLessThan(row.indexOf("lucide-ellipsis"));
      expect(row).not.toContain("lucide-download");
      expect(row).not.toContain("lucide-trash");
    }
    const items = await openMenu(false, "论文 & notes.txt");
    expect(items.map((item) => item.textContent)).toEqual([i18n.t("editor.downloadResource"), i18n.t("editor.copyFile"), i18n.t("editor.deleteFile")]);
    const download = items[0] as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(`/api/projects/paper/file/raw?path=${encodeURIComponent("data/论文 & notes.txt")}&download=1`);
    expect(download.getAttribute("download")).toBe("论文 & notes.txt");
    await act(async () => items[1].click());
    expect(copyPath).toHaveBeenCalledExactlyOnceWith({ path: "data/论文 & notes.txt", type: "file" });
    const again = await openMenu(false, "论文 & notes.txt");
    await act(async () => again.at(-1)!.click());
    expect(setDeleteEntry).toHaveBeenCalledExactlyOnceWith({ path: "data/论文 & notes.txt", type: "file" });
  });

  it("offers the main document no delete and read-only members only a download", async () => {
    expect((await openMenu(false, "main.tex")).map((item) => item.textContent)).toEqual([i18n.t("editor.downloadResource"), i18n.t("editor.copyFile")]);
    await cleanups.pop()!();
    const html = render(true);
    expect(html).not.toContain("lucide-move");
    expect(html).not.toContain("lucide-trash");
    expect((await openMenu(true, "main.tex")).map((item) => item.textContent)).toEqual([i18n.t("editor.downloadResource")]);
  });
});
