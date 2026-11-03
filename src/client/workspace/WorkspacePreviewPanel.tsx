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

const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));

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
}

export function WorkspacePreviewPanel({
  commentsOpen = false, onCommentsHost, mobileSync = false,
  projectId, activeMainFile, previewTab, diagnosticTab, pdfUrl, pdfLoadingMode, pdfLoading, pdfCompiledAt, pdfSizeBytes,
  pdfCompiledLabel, pdfTargetLabel, pdfDownloadUrl, pdfTarget, pdfViewport, activeFile, compileBusy, compileLog,
  compileDiagnostics, compileMessages, artifacts, artifactPreview, artifactLoading, cleaning, readOnly,
  collaborationSynced, workspaceLayout, showSyncResize, diagnosticCount, selectPreviewTab, changeWorkspaceLayout,
  onSetPdfViewport, onResetPdfViewport, onPdfDisplayed, syncVisiblePdfToSource, syncCurrentSourceToPdf, syncPdfToSource, canSyncWithPdf, canSyncPdfToSource,
  files, jumpToSource, onSetCleanMode, viewArtifact
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
  return <>
    {showSyncResize && <WorkspaceSyncSeparator showControls={!commentsOpen}><button disabled={!pdfUrl || !pdfViewport || !canSyncWithDisplayedPdf} title={!canSyncPdfToSource ? t("editor.syncTexOnlyForMain") : !canSyncWithDisplayedPdf ? t("editor.syncTexWaitingForPdf") : t("editor.showInSource")} aria-label={t("editor.showInSource")} onClick={(event) => { event.stopPropagation(); if (!canSyncWithDisplayedPdf) return; syncVisiblePdfToSource(); }}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl || !canSyncWithPdf} title={!canSyncWithPdf ? t("editor.syncTexOnlyForTex") : t("editor.showInPdf")} aria-label={t("editor.showInPdf")} onClick={(event) => { event.stopPropagation(); if (!activeFile || !pdfUrl || !canSyncWithPdf) return; void syncCurrentSourceToPdf(); }}><span aria-hidden>→</span></button></WorkspaceSyncSeparator>}
    <Panel id="preview" minSize="22%">
      <div className="workspace-preview-region">
      <div className={`workspace-output-layout${commentsOpen ? " has-comments" : ""}`}>
      {mobileSync && !commentsOpen && previewTab === "pdf" && <WorkspaceMobileSyncButton direction="source"
        disabled={!pdfViewport || !canSyncWithDisplayedPdf} onClick={syncVisiblePdfToSource} />}
        <WorkspaceCommentsSlot open={commentsOpen} onHost={onCommentsHost} />
      <section className="preview-panel">
        <WorkspacePreviewHeader mainFile={activeMainFile} targetLabel={pdfTargetLabel} compiledAt={pdfCompiledAt} compiledLabel={pdfCompiledLabel} sizeBytes={pdfSizeBytes}
          downloadUrl={pdfDownloadUrl} activeSurface={previewTab} onSelect={selectPreviewTab} diagnosticCount={diagnosticCount} />
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
