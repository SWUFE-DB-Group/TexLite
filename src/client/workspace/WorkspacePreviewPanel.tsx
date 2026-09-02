import { lazy, Suspense } from "react";
import { AlertTriangle, Download, Eraser, FileText, GripVertical, LoaderCircle, PackageOpen, ScrollText, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import type { CompileDiagnostics } from "../compileDiagnostics";
import type { CompileMessages } from "../compileLog";
import type { FileEntry } from "../types";
import type { PdfTarget } from "../PdfPreview";
import i18n from "../i18n";
import { loadPdfPreview } from "../workspacePreload";
import type { CompileCleanMode } from "./useProjectCompilation";
import type { CompileArtifact, DiagnosticTab, PreviewSurface, PreviewTab, WorkspaceLayout } from "./types";
import { CompileArtifacts, CompileCleanup, CompileDiagnosticOutput, CompileOutput } from "./CompileOutput";

const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));

export interface WorkspacePreviewPanelProps {
  projectId: string;
  activeMainFile: string;
  previewTab: PreviewSurface;
  diagnosticTab: DiagnosticTab;
  pdfUrl: string;
  pdfLoadingMode: "full" | "range";
  pdfLoading: boolean;
  pdfCompiledAt: string | null;
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
  onSetNotice: (message: string) => void;
  onSetPdfViewport: (viewport: { page: number; x: number; y: number }) => void;
  syncVisiblePdfToSource: () => void;
  syncCurrentSourceToPdf: () => Promise<void>;
  syncPdfToSource: (page: number, x: number, y: number) => Promise<void>;
  canSyncWithPdf: boolean;
  files: FileEntry[];
  jumpToSource: (path: string, line: number, column: number) => void;
  onSetCleanMode: (mode: CompileCleanMode | null) => void;
  cleanCompile: (mode: CompileCleanMode) => Promise<void>;
  viewArtifact: (artifact: CompileArtifact) => Promise<void>;
}

export function WorkspacePreviewPanel({
  projectId, activeMainFile, previewTab, diagnosticTab, pdfUrl, pdfLoadingMode, pdfLoading, pdfCompiledAt,
  pdfCompiledLabel, pdfTargetLabel, pdfDownloadUrl, pdfTarget, pdfViewport, activeFile, compileBusy, compileLog,
  compileDiagnostics, compileMessages, artifacts, artifactPreview, artifactLoading, cleaning, readOnly,
  collaborationSynced, workspaceLayout, showSyncResize, diagnosticCount, selectPreviewTab, changeWorkspaceLayout,
  onSetNotice, onSetPdfViewport, syncVisiblePdfToSource, syncCurrentSourceToPdf, syncPdfToSource, canSyncWithPdf,
  files, jumpToSource, onSetCleanMode, cleanCompile, viewArtifact
}: WorkspacePreviewPanelProps) {
  const { t } = useTranslation();
  return <>
    {showSyncResize && <PanelResizeHandle className="resize-handle sync-resize-handle"><GripVertical className="resize-grip" size={12} /><span className="sync-direction-buttons" onPointerDown={(event) => event.stopPropagation()}><button disabled={!pdfViewport || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInSource") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInSource")} onClick={() => { if (!canSyncWithPdf) { onSetNotice(t("editor.syncTexOnlyForMain")); return; } syncVisiblePdfToSource(); }}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInPdf") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInPdf")} onClick={() => { if (!canSyncWithPdf) { onSetNotice(t("editor.syncTexOnlyForMain")); return; } void syncCurrentSourceToPdf(); }}><span aria-hidden>→</span></button></span></PanelResizeHandle>}
    <Panel id="preview" order={3} defaultSize={42} minSize={22}>
      <section className="preview-panel">
        <div className="preview-tabs">
          <div className="preview-tab-list" role="tablist" aria-label={t("editor.outputTabs")}>
            <button role="tab" aria-selected={previewTab === "pdf"} className={`pdf-tab${previewTab === "pdf" ? " active" : ""}`} onClick={() => selectPreviewTab("pdf")} title={pdfCompiledAt ? t("editor.pdfCompiledAtFor", { file: activeMainFile, time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) }) : t("editor.currentMainDocument", { path: activeMainFile })}><FileText size={16} /><span className="pdf-tab-label">PDF · {pdfTargetLabel}{pdfCompiledLabel && <small>{pdfCompiledLabel}</small>}</span></button>
            <button role="tab" aria-selected={previewTab === "diagnostics"} className={`diagnostics-tab${previewTab === "diagnostics" ? " active" : ""}`} onClick={() => selectPreviewTab("diagnostics")}><ScrollText size={14} />{t("editor.outputTabs")}<span>{diagnosticCount}</span></button>
          </div>
          {pdfDownloadUrl && <a className="pdf-download-top" href={pdfDownloadUrl} download title={t("editor.downloadPdf")} aria-label={t("editor.downloadPdf")}><Download size={15} /><span>{t("editor.downloadPdf")}</span></a>}
        </div>
        {previewTab === "diagnostics" && <div className="preview-subtabs" role="tablist" aria-label={t("editor.outputTabs")}>
          <button role="tab" aria-selected={diagnosticTab === "log"} className={diagnosticTab === "log" ? "active" : ""} onClick={() => selectPreviewTab("log")}><ScrollText size={13} />{t("editor.log")}</button>
          <button role="tab" aria-selected={diagnosticTab === "warnings"} className={diagnosticTab === "warnings" ? "active" : ""} onClick={() => selectPreviewTab("warnings")}><AlertTriangle size={13} />{t("editor.warnings")}<span>{compileMessages.warnings.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "errors"} className={diagnosticTab === "errors" ? "active" : ""} onClick={() => selectPreviewTab("errors")}><XCircle size={13} />{t("editor.errors")}<span>{compileMessages.errors.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "artifacts"} className={diagnosticTab === "artifacts" ? "active" : ""} onClick={() => selectPreviewTab("artifacts")}><PackageOpen size={13} />{t("editor.artifacts")}<span>{artifacts.length}</span></button>
          <button role="tab" aria-selected={diagnosticTab === "clean"} className={diagnosticTab === "clean" ? "active" : ""} onClick={() => selectPreviewTab("clean")}><Eraser size={13} />{t("editor.clean")}</button>
        </div>}
        <div className={`preview-content preview-${previewTab} ${previewTab === "diagnostics" ? `preview-${diagnosticTab}` : ""}`}>
          {previewTab === "pdf" && (pdfUrl ? <Suspense fallback={<div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}><PdfPreview url={pdfUrl} loadingMode={pdfLoadingMode} target={pdfTarget} compiling={compileBusy} onViewportLocation={(page, x, y) => onSetPdfViewport({ page, x, y })} onDoubleClickLocation={(page, x, y) => { onSetPdfViewport({ page, x, y }); if (!canSyncWithPdf) { onSetNotice(t("editor.syncTexOnlyForMain")); return; } void syncPdfToSource(page, x, y); }} /></Suspense> : pdfLoading ? <div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div> : <div className="preview-empty"><FileText size={28} /><strong>{t("editor.preview")}</strong><span>{t("editor.previewHint")}</span></div>)}
          {previewTab === "diagnostics" && diagnosticTab === "log" && <CompileOutput lines={compileLog ? compileLog.split("\n") : []} empty={compileBusy ? t("editor.compiling") : t("editor.noLog")} />}
          {previewTab === "diagnostics" && diagnosticTab === "warnings" && (compileDiagnostics ? <CompileDiagnosticOutput tone="warning" diagnostics={compileDiagnostics.warnings} files={files} empty={t("editor.noWarnings")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} /> : <CompileOutput tone="warning" lines={compileMessages.warnings} empty={t("editor.noWarnings")} />)}
          {previewTab === "diagnostics" && diagnosticTab === "errors" && (compileDiagnostics ? <CompileDiagnosticOutput tone="error" diagnostics={compileDiagnostics.errors} files={files} empty={t("editor.noErrors")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} /> : <CompileOutput tone="error" lines={compileMessages.errors} empty={t("editor.noErrors")} />)}
          {previewTab === "diagnostics" && diagnosticTab === "artifacts" && <CompileArtifacts projectId={projectId} mainFile={activeMainFile} artifacts={artifacts} preview={artifactPreview} loading={artifactLoading} onView={(artifact) => void viewArtifact(artifact)} />}
          {previewTab === "diagnostics" && diagnosticTab === "clean" && <CompileCleanup mainFile={activeMainFile} disabled={readOnly || !collaborationSynced || compileBusy} cleaning={cleaning} onCleanCache={() => onSetCleanMode("cache")} onCleanArtifacts={() => onSetCleanMode("artifacts")} />}
        </div>
      </section>
    </Panel>
  </>;
}
