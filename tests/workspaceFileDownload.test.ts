import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFilePanel, type WorkspaceFilePanelProps } from "../src/client/workspace/WorkspaceFilePanel";
import { createSourceCursorStore } from "../src/client/workspace/sourceCursorStore";
import i18n from "../src/client/i18n";

vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children: ReactNode }) => createElement("section", null, children)
}));

function render(readOnly = false): string {
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
    setMoveDestination: noop, setDeleteEntry: noop, setFileDialogError: noop, setNewFolderName: noop,
    setNewFolderOpen: noop, setNewFilePath: noop, setNewFileOpen: noop, setQuickOpen: noop,
    setFileDragActive: noop, dismissUploadFeedback: noop, setFilesCollapsed: noop, onError: noop,
    uploadFiles: asyncNoop, upload: asyncNoop, openFile: noop, movePathToFolder: asyncNoop,
    onFormatFile: noop, onFormatSelection: noop, jumpToSource: noop, syncSourceToPdf: asyncNoop, onWordCount: noop
  };
  return renderToStaticMarkup(createElement(WorkspaceFilePanel, props));
}

describe("file tree downloads", () => {
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

  it("places file downloads between move and delete without adding a folder download", () => {
    const html = render();
    const rows = [...html.matchAll(/<div class="file-entry(?: [^"]*)?"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain("lucide-download");
    // The configured root cannot be deleted, but can still be downloaded.
    expect(rows[1]).toContain("lucide-download");
    expect(rows[1]).not.toContain("lucide-trash");
    const file = rows[2];
    expect(file.indexOf("lucide-move")).toBeLessThan(file.indexOf("lucide-download"));
    expect(file.indexOf("lucide-download")).toBeLessThan(file.indexOf("lucide-trash"));
    expect(file).toContain(`/api/projects/paper/file/raw?path=${encodeURIComponent("data/论文 & notes.txt")}&amp;download=1`);
    expect(file).toContain('download="论文 &amp; notes.txt"');
    expect(file).toContain('draggable="false"');
  });

  it("keeps single-file downloads available to read-only collaborators", () => {
    const html = render(true);
    expect(html.match(/lucide-download/g)).toHaveLength(2);
    expect(html).not.toContain("lucide-move");
    expect(html).not.toContain("lucide-trash");
  });
});
