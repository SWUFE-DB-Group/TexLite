import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePreviewPanel, type WorkspacePreviewPanelProps } from "../src/client/workspace/WorkspacePreviewPanel";
import i18n from "../src/client/i18n";

vi.mock("react-resizable-panels", () => ({ Panel: ({ children }: { children: ReactNode }) => createElement("section", null, children) }));
vi.mock("../src/client/workspacePreload", () => ({ loadPdfPreview: vi.fn() }));
vi.mock("../src/client/workspace/WorkspaceSyncSeparator", () => ({
  WorkspaceSyncSeparator: ({ children, showControls = true }: { children: ReactNode; showControls?: boolean }) =>
    createElement("div", { className: "sync-separator" }, showControls ? children : null)
}));

function render(overrides: Partial<WorkspacePreviewPanelProps> = {}): string {
  const noop = () => {};
  const asyncNoop = async () => {};
  return renderToStaticMarkup(createElement(WorkspacePreviewPanel, {
    projectId: "project", activeMainFile: "main.tex", previewTab: "pdf", diagnosticTab: "log",
    pdfUrl: "", pdfLoadingMode: "full", pdfLoading: false, pdfCompiledAt: null, pdfSizeBytes: null,
    pdfCompiledLabel: "", pdfTargetLabel: "main.tex", pdfDownloadUrl: "", pdfTarget: null, pdfViewport: null,
    activeFile: "main.tex", compileBusy: false, compileLog: "", compileDiagnostics: null,
    compileMessages: { warnings: [], errors: [] }, artifacts: [], artifactPreview: null, artifactLoading: false,
    cleaning: false, readOnly: false, collaborationSynced: true, workspaceLayout: "editor-pdf", showSyncResize: false,
    diagnosticCount: 0, selectPreviewTab: noop, changeWorkspaceLayout: noop, onSetPdfViewport: noop,
    onResetPdfViewport: noop, onPdfDisplayed: noop, syncVisiblePdfToSource: noop, syncCurrentSourceToPdf: asyncNoop,
    syncPdfToSource: asyncNoop, canSyncWithPdf: false, canSyncPdfToSource: false, files: [],
    jumpToSource: noop, onSetCleanMode: noop, viewArtifact: asyncNoop, ...overrides
  }));
}

describe("uncompiled PDF preview", () => {
  it("hides SyncTeX arrows while comments are open without removing the resize separator", () => {
    for (const commentsOpen of [false, true, false]) {
      const html = render({ commentsOpen, showSyncResize: true });
      expect(html).toContain('class="sync-separator"');
      for (const label of [i18n.t("editor.showInSource"), i18n.t("editor.showInPdf")]) {
        expect(html.includes(`aria-label="${label}"`)).toBe(!commentsOpen);
      }
    }
  });
  it("keeps the PDF mounted with a comments slot before it and hides that slot when closed", () => {
    const opened = render({ commentsOpen: true });
    expect(opened).toContain('class="workspace-output-layout has-comments"');
    expect(opened).toContain('class="workspace-comments-slot"');
    expect(opened.indexOf('class="workspace-comments-slot"')).toBeLessThan(opened.indexOf('class="preview-panel"'));
    const closed = render();
    expect(closed).toContain('class="workspace-comments-slot" hidden=""');
    expect(closed).toContain('class="preview-panel"');
  });
  it.each(["en", "zh"])("shows a localized empty state without a download action (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const html = render();
    expect(html).toContain('class="preview-empty preview-empty-uncompiled" role="status"');
    expect(html).toContain(i18n.t("editor.previewEmptyTitle"));
    expect(html).toContain(i18n.t("editor.previewHint"));
    expect(html).not.toContain("pdf-download-top");
    expect(html).not.toMatch(/class="[^"]*\bspin\b/);
  });

  it("shows first-compilation progress instead of prompting another compile", () => {
    const html = render({ compileBusy: true });
    expect(html).toContain(i18n.t("editor.compiling"));
    expect(html).toContain(i18n.t("editor.previewCompilingHint"));
    expect(html).not.toContain(i18n.t("editor.previewEmptyTitle"));
    expect(html).not.toContain(i18n.t("editor.previewHint"));
    expect(html).toMatch(/class="[^"]*\bspin\b/);
  });

  it("does not show the empty state while looking for an existing PDF or viewing diagnostics", () => {
    expect(render({ pdfLoading: true })).not.toContain("preview-empty-uncompiled");
    expect(render({ previewTab: "diagnostics" })).not.toContain("preview-empty-uncompiled");
  });
});
