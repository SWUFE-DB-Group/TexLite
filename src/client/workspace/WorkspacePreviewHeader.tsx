import { Download, ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PdfDocumentIcon } from "../PdfDocumentIcon";
import { formatBytes } from "../formatBytes";
import { formatDateTime } from "../dateTime";
import type { PreviewSurface } from "./types";

/** Presentation shared by authenticated workspaces and anonymous readers. */
export function WorkspacePreviewHeader({ mainFile, targetLabel, compiledAt, compiledLabel, sizeBytes, downloadUrl,
  activeSurface, onSelect, diagnosticCount, diagnosticsDisabled = false }: {
  mainFile: string; targetLabel: string; compiledAt: string | null; compiledLabel: string;
  sizeBytes: number | null; downloadUrl: string; activeSurface: PreviewSurface;
  onSelect: (surface: PreviewSurface) => void;
  /** Omit entirely for readers who cannot access compilation output. */
  diagnosticCount?: number;
  diagnosticsDisabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const metaLabel = [sizeBytes == null ? "" : formatBytes(sizeBytes), compiledLabel ? t("editor.pdfUpdatedAt", { time: compiledLabel }) : ""].filter(Boolean).join(" · ");
  return <div className="preview-tabs">
    <div className="preview-tab-list" role="tablist" aria-label={t("editor.outputTabs")}>
      <button role="tab" aria-selected={activeSurface === "pdf"} className={`pdf-tab${activeSurface === "pdf" ? " active" : ""}`} onClick={() => onSelect("pdf")} title={compiledAt ? t("editor.pdfCompiledAtFor", { file: mainFile, time: formatDateTime(compiledAt, i18n.resolvedLanguage) }) : t("editor.currentMainDocument", { path: mainFile })}><PdfDocumentIcon className="pdf-tab-icon" /><span className="pdf-tab-label"><span className="pdf-tab-title">PDF · {targetLabel}</span>{metaLabel && <small>{metaLabel}</small>}</span></button>
      {diagnosticCount !== undefined && <button role="tab" disabled={diagnosticsDisabled} aria-selected={activeSurface === "diagnostics"} className={`diagnostics-tab${activeSurface === "diagnostics" ? " active" : ""}`} onClick={() => onSelect("diagnostics")}><ScrollText size={14} />{t("editor.outputTabs")}<span className="diagnostic-count">{diagnosticCount}</span></button>}
    </div>
    {downloadUrl && <a className="pdf-download-top" href={downloadUrl} download title={t("editor.downloadPdf")} aria-label={t("editor.downloadPdf")}><Download size={15} /><span>{t("editor.downloadPdf")}</span></a>}
  </div>;
}
