import { lazy, Suspense, useRef, useState } from "react";
import { AlertTriangle, Eraser, LoaderCircle, Logs, PackageOpen, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel } from "react-resizable-panels";
import { WorkspaceSyncSeparator } from "./WorkspaceSyncSeparator";
import { WorkspaceCommentsSlot } from "./WorkspaceCommentsSlot";
import { WorkspaceMobileSyncButton } from "./WorkspaceMobileSyncButton";
import type { CompileDiagnostics } from "../compileDiagnostics";
import type { CompileMessages } from "../compileLog";
import type { FileEntry } from "../types";
import type { PdfTarget } from "../PdfPreview";
import { PdfDocumentIcon } from "../PdfDocumentIcon";
import { WorkspacePreviewHeader } from "./WorkspacePreviewHeader";
import { loadPdfPreview } from "../workspacePreload";
import type { CompileCleanMode } from "./useProjectCompilation";
import type { CompileArtifact, DiagnosticTab, PreviewSurface, PreviewTab, WorkspaceLayout } from "./types";
import { CompileArtifacts, CompileCleanup, CompileDiagnosticOutput, CompileOutput } from "./CompileOutput";
import type { MarkdownPreviewHandle } from "./MarkdownPreview";

const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

/** The active Markdown file; `source` is null until that file's text has loaded. */
export interface WorkspaceMarkdownPreview {
  path: string;
  source: string | null;
  reveal: { line: number; nonce: number } | null;
  onOpenPath: (path: string) => void;
  /** Show a line of the Markdown file in the editor. */
  onShowLine: (line: number) => void;
  /** Scroll the preview to the editor's cursor. */
  onShowCursor: () => void;
}

export interface WorkspacePreviewPanelProps {
  mobileSync?: boolean;
  commentsOpen?: boolean;
  onCommentsHost?: (element: HTMLDivElement | null) => void;
  projectId: string;
  activeMainFile: string;
  previewTab: PreviewSurface;
  diagnosticTab: DiagnosticTab;
  pdfUrl: string;
  pdfLoadingMode: "full" | "range";
  pdfLoading: boolean;
  pdfCompiledAt: string | null;
  pdfSizeBytes: number | null;
  pdfCompiledLabel: string;
  pdfTargetLabel: string;
  pdfDownloadUrl: string;
  pdfTarget: PdfTarget | null;
  pdfViewport: { page: number; x: number; y: number } | null;
  activeFile: string;
  compileBusy: boolean;
  compileLog: string;
  compileDiagnostics: CompileDiagnostics | null;
  compileMessages: CompileMessages;
  artifacts: CompileArtifact[];
  artifactPreview: { path: string; content: string } | null;
  artifactLoading: boolean;
  cleaning: boolean;
  readOnly: boolean;
  collaborationSynced: boolean;
  workspaceLayout: WorkspaceLayout;
  showSyncResize: boolean;
  diagnosticCount: number;
  selectPreviewTab: (tab: PreviewTab | PreviewSurface) => void;
  changeWorkspaceLayout: (layout: WorkspaceLayout) => void;
  onSetPdfViewport: (viewport: { page: number; x: number; y: number }) => void;
  onResetPdfViewport: () => void;
  onPdfDisplayed: (url: string) => void;
  syncVisiblePdfToSource: () => Promise<void>;
  syncCurrentSourceToPdf: () => Promise<void>;
  syncPdfToSource: (page: number, x: number, y: number) => Promise<void>;
  canSyncWithPdf: boolean;
  canSyncPdfToSource: boolean;
  files: FileEntry[];
  jumpToSource: (path: string, line: number, column: number) => void;
  onSetCleanMode: (mode: CompileCleanMode | null) => void;
  viewArtifact: (artifact: CompileArtifact) => Promise<void>;
  markdown?: WorkspaceMarkdownPreview | null;
}

export function WorkspacePreviewPanel({
  commentsOpen = false, onCommentsHost, mobileSync = false,
  projectId, activeMainFile, previewTab, diagnosticTab, pdfUrl, pdfLoadingMode, pdfLoading, pdfCompiledAt, pdfSizeBytes,
  pdfCompiledLabel, pdfTargetLabel, pdfDownloadUrl, pdfTarget, pdfViewport, activeFile, compileBusy, compileLog,
  compileDiagnostics, compileMessages, artifacts, artifactPreview, artifactLoading, cleaning, readOnly,
  collaborationSynced, workspaceLayout, showSyncResize, diagnosticCount, selectPreviewTab, changeWorkspaceLayout,
  onSetPdfViewport, onResetPdfViewport, onPdfDisplayed, syncVisiblePdfToSource, syncCurrentSourceToPdf, syncPdfToSource, canSyncWithPdf, canSyncPdfToSource,
  files, jumpToSource, onSetCleanMode, viewArtifact, markdown = null
}: WorkspacePreviewPanelProps) {
  const { t } = useTranslation();
  const [displayedPdfUrl, setDisplayedPdfUrl] = useState("");
  const displayedPdfUrlRef = useRef("");
  const updateDisplayedPdfUrl = (loadedUrl: string) => {
    if (displayedPdfUrlRef.current === loadedUrl) return;
    displayedPdfUrlRef.current = loadedUrl;
    setDisplayedPdfUrl(loadedUrl);
    onResetPdfViewport();
    onPdfDisplayed(loadedUrl);
  };
  const canSyncWithDisplayedPdf = canSyncPdfToSource && Boolean(pdfUrl) && displayedPdfUrl === pdfUrl;
  const markdownRef = useRef<MarkdownPreviewHandle>(null);
  const shownMarkdown = previewTab === "markdown" ? markdown : null;
  const showMarkdownInSource = () => {
    const line = markdownRef.current?.visibleLine();
    if (line && markdown) markdown.onShowLine(line);
    return Promise.resolve();
  };
  return <>
    {showSyncResize && <WorkspaceSyncSeparator showControls={!commentsOpen}>{shownMarkdown
      ? <><button disabled={shownMarkdown.source === null} title={t("editor.markdown.showInSource")} aria-label={t("editor.markdown.showInSource")} onClick={(event) => { event.stopPropagation(); void showMarkdownInSource(); }}><span aria-hidden>←</span></button><button disabled={shownMarkdown.source === null} title={t("editor.markdown.showInPreview")} aria-label={t("editor.markdown.showInPreview")} onClick={(event) => { event.stopPropagation(); shownMarkdown.onShowCursor(); }}><span aria-hidden>→</span></button></>
      : <><button disabled={!pdfUrl || !pdfViewport || !canSyncWithDisplayedPdf} title={!canSyncPdfToSource ? t("editor.syncTexOnlyForMain") : !canSyncWithDisplayedPdf ? t("editor.syncTexWaitingForPdf") : t("editor.showInSource")} aria-label={t("editor.showInSource")} onClick={(event) => { event.stopPropagation(); if (!canSyncWithDisplayedPdf) return; syncVisiblePdfToSource(); }}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl || !canSyncWithPdf} title={!canSyncWithPdf ? t("editor.syncTexOnlyForTex") : t("editor.showInPdf")} aria-label={t("editor.showInPdf")} onClick={(event) => { event.stopPropagation(); if (!activeFile || !pdfUrl || !canSyncWithPdf) return; void syncCurrentSourceToPdf(); }}><span aria-hidden>→</span></button></>}</WorkspaceSyncSeparator>}
    <Panel id="preview" minSize="22%">
      <div className="workspace-preview-region">
      <div className={`workspace-output-layout${commentsOpen ? " has-comments" : ""}`}>
      {mobileSync && !commentsOpen && previewTab === "pdf" && <WorkspaceMobileSyncButton direction="source"
        disabled={!pdfViewport || !canSyncWithDisplayedPdf} onClick={syncVisiblePdfToSource} />}
      {mobileSync && !commentsOpen && shownMarkdown && <WorkspaceMobileSyncButton direction="source" label={t("editor.markdown.showInSource")}
        disabled={shownMarkdown.source === null} onClick={showMarkdownInSource} />}
        <WorkspaceCommentsSlot open={commentsOpen} onHost={onCommentsHost} />
      <section className="preview-panel">
        <WorkspacePreviewHeader mainFile={activeMainFile} targetLabel={pdfTargetLabel} compiledAt={pdfCompiledAt} compiledLabel={pdfCompiledLabel} sizeBytes={pdfSizeBytes}
          downloadUrl={pdfDownloadUrl} activeSurface={previewTab} onSelect={selectPreviewTab} diagnosticCount={diagnosticCount} markdownFile={markdown?.path} />
        {previewTab === "diagnostics" && <div className="preview-subtabs" role="tablist" aria-label={t("editor.outputTabs")}>
          <button role="tab" aria-selected={diagnosticTab === "log"} className={diagnosticTab === "log" ? "active" : ""} onClick={() => selectPreviewTab("log")}><Logs size={13} />{t("editor.log")}</button>
          <button role="tab" aria-selected={diagnosticTab === "warnings"} className={diagnosticTab === "warnings" ? "active" : ""} onClick={() => selectPreviewTab("warnings")}><AlertTriangle size={13} />{t("editor.warnings")}<span>{compileMessages.warnings.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "errors"} className={diagnosticTab === "errors" ? "active" : ""} onClick={() => selectPreviewTab("errors")}><XCircle size={13} />{t("editor.errors")}<span>{compileMessages.errors.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "artifacts"} className={diagnosticTab === "artifacts" ? "active" : ""} onClick={() => selectPreviewTab("artifacts")}><PackageOpen size={13} />{t("editor.artifacts")}<span>{artifacts.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "clean"} className={diagnosticTab === "clean" ? "active" : ""} onClick={() => selectPreviewTab("clean")}><Eraser size={13} />{t("editor.clean")}</button>
        </div>}
        <div className={`preview-content preview-${previewTab} ${previewTab === "diagnostics" ? `preview-${diagnosticTab}` : ""}`}>
          {previewTab === "pdf" && (pdfUrl ? <Suspense fallback={<div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}><PdfPreview url={pdfUrl} loadingMode={pdfLoadingMode} target={pdfTarget} compiling={compileBusy} onDisplayedUrlChange={updateDisplayedPdfUrl} onViewportLocation={(page, x, y) => { if (displayedPdfUrlRef.current === pdfUrl) onSetPdfViewport({ page, x, y }); }} onDoubleClickLocation={(page, x, y) => { if (displayedPdfUrlRef.current !== pdfUrl || !canSyncWithDisplayedPdf) return; onSetPdfViewport({ page, x, y }); void syncPdfToSource(page, x, y); }} /></Suspense>
            : pdfLoading ? <div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>
              : <div className="preview-empty preview-empty-uncompiled" role="status" aria-live="polite">
                <span className="preview-empty-icon" aria-hidden="true">{compileBusy ? <LoaderCircle className="spin" size={26} /> : <PdfDocumentIcon size={32} />}</span>
                <strong>{t(compileBusy ? "editor.compiling" : "editor.previewEmptyTitle")}</strong>
                <p>{t(compileBusy ? "editor.previewCompilingHint" : "editor.previewHint")}</p>
              </div>)}
          {shownMarkdown && (shownMarkdown.source === null
            ? <div className="preview-empty markdown-preview-empty" role="status"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>
            : <Suspense fallback={<div className="preview-empty markdown-preview-empty" role="status"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
              <MarkdownPreview ref={markdownRef} key={shownMarkdown.path} projectId={projectId} path={shownMarkdown.path} source={shownMarkdown.source}
                reveal={shownMarkdown.reveal} onOpenPath={shownMarkdown.onOpenPath} onJumpToLine={shownMarkdown.onShowLine} />
            </Suspense>)}
          {previewTab === "diagnostics" && diagnosticTab === "log" && <CompileOutput lines={compileLog ? compileLog.split("\n") : []} empty={compileBusy ? t("editor.compiling") : t("editor.noLog")} />}
          {previewTab === "diagnostics" && diagnosticTab === "warnings" && (compileDiagnostics ? <CompileDiagnosticOutput tone="warning" diagnostics={compileDiagnostics.warnings} files={files} empty={t("editor.noWarnings")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} /> : <CompileOutput tone="warning" lines={compileMessages.warnings} empty={t("editor.noWarnings")} />)}
          {previewTab === "diagnostics" && diagnosticTab === "errors" && (compileDiagnostics ? <CompileDiagnosticOutput tone="error" diagnostics={compileDiagnostics.errors} files={files} empty={t("editor.noErrors")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} /> : <CompileOutput tone="error" lines={compileMessages.errors} empty={t("editor.noErrors")} />)}
          {previewTab === "diagnostics" && diagnosticTab === "artifacts" && <CompileArtifacts projectId={projectId} mainFile={activeMainFile} artifacts={artifacts} preview={artifactPreview} loading={artifactLoading} onView={(artifact) => void viewArtifact(artifact)} />}
          {previewTab === "diagnostics" && diagnosticTab === "clean" && <CompileCleanup mainFile={activeMainFile} disabled={readOnly || !collaborationSynced || compileBusy} cleaning={cleaning} onCleanCache={() => onSetCleanMode("cache")} onCleanArtifacts={() => onSetCleanMode("artifacts")} />}
        </div>
      </section>
      </div>
      </div>
    </Panel>
  </>;
}
