// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMobileSyncButton } from "../src/client/workspace/WorkspaceMobileSyncButton";
import { WorkspacePreviewPanel, type WorkspacePreviewPanelProps } from "../src/client/workspace/WorkspacePreviewPanel";
import { WorkspaceEditorPanel, type WorkspaceEditorPanelProps } from "../src/client/workspace/WorkspaceEditorPanel";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import i18n from "../src/client/i18n";

vi.mock("react-resizable-panels", () => ({ Panel: ({ children }: { children: ReactNode }) => createElement("section", null, children) }));
vi.mock("../src/client/workspace/EditorTerminalLayout", () => ({ EditorTerminalLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/client/LatexEditor", () => ({ LatexEditor: () => createElement("div", null, "Source") }));
const pdf = vi.hoisted(() => ({ props: null as { onDisplayedUrlChange: (url: string) => void } | null }));
vi.mock("../src/client/workspacePreload", () => ({ loadPdfPreview: async () => ({ PdfPreview: (props: typeof pdf.props) => { pdf.props = props; return createElement("div", null, "PDF"); } }) }));

let root: Root, host: HTMLDivElement;
const noop = () => {};
const done = async () => {};
const render = (node: ReactNode) => act(async () => { root.render(node); });
const button = () => host.querySelector<HTMLButtonElement>(".workspace-mobile-sync");
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); pdf.props = null;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function preview(overrides: Partial<WorkspacePreviewPanelProps> = {}) {
  return createElement(WorkspacePreviewPanel, {
    projectId: "paper", activeMainFile: "main.tex", previewTab: "pdf", diagnosticTab: "log", pdfUrl: "/paper.pdf",
    pdfLoadingMode: "full", pdfLoading: false, pdfCompiledAt: null, pdfSizeBytes: null, pdfCompiledLabel: "", pdfTargetLabel: "main.tex",
    pdfDownloadUrl: "", pdfTarget: null, pdfViewport: { page: 2, x: 10, y: 20 }, activeFile: "part.tex", compileBusy: false,
    compileLog: "", compileDiagnostics: null, compileMessages: { warnings: [], errors: [] }, artifacts: [], artifactPreview: null,
    artifactLoading: false, cleaning: false, readOnly: false, collaborationSynced: true, workspaceLayout: "pdf-only",
    showSyncResize: false, diagnosticCount: 0, selectPreviewTab: noop, changeWorkspaceLayout: noop,
    onSetPdfViewport: noop, onResetPdfViewport: noop, onPdfDisplayed: noop, syncVisiblePdfToSource: done,
    syncCurrentSourceToPdf: done, syncPdfToSource: done, canSyncWithPdf: true, canSyncPdfToSource: true,
    files: [], jumpToSource: noop, onSetCleanMode: noop, viewArtifact: done, ...overrides
  });
}

describe("phone SyncTeX controls", () => {
  it("prevents repeat requests while a lookup is in flight and restores the button afterwards", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(createElement(WorkspaceMobileSyncButton, { direction: "pdf", disabled: false, onClick: run }));
    expect(button()?.getAttribute("aria-label")).toBe(i18n.t("editor.showInPdf"));
    expect(button()?.querySelector(".lucide-arrow-right")).not.toBeNull();
    await act(async () => button()!.click());
    expect(button()?.disabled).toBe(true);
    expect(button()?.getAttribute("aria-busy")).toBe("true");
    await act(async () => button()!.click());
    expect(run).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(button()?.disabled).toBe(false);
    await render(createElement(WorkspaceMobileSyncButton, { direction: "pdf", disabled: true, onClick: run }));
    await act(async () => button()!.click());
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows only the right arrow in source when phone controls are requested", async () => {
    const run = vi.fn(done);
    // Unrelated editor dependencies are stubbed; the real panel owns the button.
    const props: WorkspaceEditorPanelProps = { activeFile: "main.tex", loadedFile: "main.tex", content: "Source",
      project: { id: "paper", name: "Paper", ownerId: "owner", mainFile: "main.tex", lastModifiedBy: null,
        latexmkrc: null, engine: "pdflatex", icon: null, chktexEnabled: false, permission: "owner", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      editorPreferences: defaultEditorPreferences, openTabs: [], comments: [], focusComment: null,
      readOnly: false, completionIndex: null, nativeSpellCheck: false, spellCheckIssues: [], spellCheckJump: null, sourceJump: null,
      collaborativeText: null, collaborationAwareness: {} as WorkspaceEditorPanelProps["collaborationAwareness"],
      editorNotice: "", activateTab: noop, closeTab: noop, handleTabKeyDown: noop, updateEditorContent: noop, setSelection: noop,
      onAddComment: noop, onSelectionHistory: noop, onCommentClick: noop, onSpellCheckReplace: noop, onReferenceNavigate: noop, onCursor: noop,
      mobileSync: { disabled: false, onClick: run } };
    await render(createElement(WorkspaceEditorPanel, props));
    expect(host.querySelectorAll(".workspace-mobile-sync")).toHaveLength(1);
    expect(button()?.querySelector(".lucide-arrow-right")).not.toBeNull();
    expect(button()?.querySelector(".lucide-arrow-left")).toBeNull();
    await act(async () => button()!.click());
    expect(run).toHaveBeenCalledOnce();
    await render(createElement(WorkspaceEditorPanel, { ...props, mobileSync: undefined }));
    expect(button()).toBeNull();
  });

  it("enables only the left arrow after the current PDF paints, never for a stale replacement", async () => {
    const run = vi.fn(done);
    await render(preview({ mobileSync: true, syncVisiblePdfToSource: run }));
    expect(button()?.getAttribute("aria-label")).toBe(i18n.t("editor.showInSource"));
    expect(button()?.querySelector(".lucide-arrow-left")).not.toBeNull();
    expect(button()?.disabled).toBe(true);
    await act(async () => { pdf.props!.onDisplayedUrlChange("/paper.pdf"); });
    expect(button()?.disabled).toBe(false);
    await act(async () => button()!.click());
    expect(run).toHaveBeenCalledOnce();
    await render(preview({ mobileSync: true, pdfUrl: "/new.pdf", syncVisiblePdfToSource: run }));
    expect(button()?.disabled).toBe(true);
    await act(async () => button()!.click());
    expect(run).toHaveBeenCalledOnce();
    await act(async () => { pdf.props!.onDisplayedUrlChange("/new.pdf"); });
    expect(button()?.disabled).toBe(false);
    await render(preview({ mobileSync: true, pdfUrl: "/new.pdf", pdfViewport: null }));
    expect(button()?.disabled).toBe(true);
  });

  it("hides the PDF-side phone arrow on desktop, in diagnostics and while reading comments", async () => {
    for (const props of [{ mobileSync: false }, { mobileSync: true, commentsOpen: true }, { mobileSync: true, previewTab: "diagnostics" as const }]) {
      await render(preview(props));
      expect(button()).toBeNull();
    }
  });
});
