import { useEffect, useState } from "react";
import { AlertTriangle, CaseSensitive, Check, Info, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PdfFontsResponse } from "../../shared/pdfFonts";
import { api, ApiError, isAbortError } from "../api";
import { errorMessage } from "../errors";
import { InfoPopover } from "../InfoPopover";

export function PdfFontsPanel({ projectId, mainFile, pdfUrl }: { projectId: string; mainFile: string; pdfUrl: string }) {
  const { t } = useTranslation();
  const runId = pdfUrl ? new URL(pdfUrl, "https://texlite.invalid/").searchParams.get("run") : null;
  const [result, setResult] = useState<PdfFontsResponse | null>(null);
  const [failure, setFailure] = useState<{ message: string; unavailable: boolean } | null>(null);
  const [loading, setLoading] = useState(Boolean(runId));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setLoading(true); setFailure(null); setResult(null);
    const params = new URLSearchParams({ mainFile, run: runId });
    void api<PdfFontsResponse>(`/api/projects/${projectId}/compile/fonts?${params}`, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setResult(response); })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error)) setFailure({ message: errorMessage(error),
          unavailable: error instanceof ApiError && error.code === "PDF_FONTS_UNAVAILABLE" });
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, mainFile, runId, retry]);
  const type3 = result?.fonts.filter((font) => font.type === "Type 3").length ?? 0;
  const notEmbedded = result?.fonts.filter((font) => !font.embedded).length ?? 0;
  const flag = (value: boolean, warning = false) => <span className={`pdf-font-flag${warning ? " warning" : ""}`}>
    {value ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}{t(value ? "editor.pdfFonts.yes" : "editor.pdfFonts.no")}
  </span>;
  return <div className="pdf-fonts-panel">
    <header className="pdf-fonts-heading"><div><CaseSensitive size={17} aria-hidden /><strong>{t("editor.pdfFonts.title")}</strong>
      <InfoPopover label={t("editor.pdfFonts.helpLabel")} content={<ul className="pdf-fonts-help">
        <li><strong>TrueType / CID TrueType</strong> — {t("editor.pdfFonts.helpTrueType")}</li>
        <li><strong>Type 1 / Type 1C / CID Type 0C</strong> — {t("editor.pdfFonts.helpType1")}</li>
        <li><strong>CID</strong> — {t("editor.pdfFonts.helpCid")}</li>
        <li><strong>Type 3</strong> — {t("editor.pdfFonts.helpType3")}</li>
        <li>{t("editor.pdfFonts.helpEmbedded")}</li>
        <li>{t("editor.pdfFonts.helpUnicode")}</li>
      </ul>} />
    </div>{runId && <button className="pdf-fonts-refresh" disabled={loading} onClick={() => setRetry((value) => value + 1)}>
      <RefreshCw size={13} aria-hidden />{t(result ? "editor.pdfFonts.refresh" : "common.retry")}</button>}</header>
    <p className="pdf-fonts-source">{mainFile.replace(/\.tex$/i, ".pdf")}</p>
    {!runId ? <div className="pdf-fonts-state"><CaseSensitive size={25} aria-hidden /><p>{t("editor.pdfFonts.noPdf")}</p></div>
      : loading ? <div className="pdf-fonts-state" role="status"><LoaderCircle className="spin" size={23} aria-hidden /><p>{t("editor.pdfFonts.loading")}</p></div>
        : failure ? <div className="pdf-fonts-state" role={failure.unavailable ? "status" : "alert"}>
          {failure.unavailable ? <Info size={23} aria-hidden /> : <AlertTriangle size={23} aria-hidden />}<p>{failure.message}</p>
        </div> : result && <>
          <div className="pdf-fonts-summary"><span>{t("editor.pdfFonts.count", { count: result.fonts.length })}</span>
            {type3 > 0 && <span className="pdf-fonts-warning"><AlertTriangle size={12} aria-hidden />{t("editor.pdfFonts.type3Count", { count: type3 })}</span>}
            {notEmbedded > 0 && <span className="pdf-fonts-warning">{t("editor.pdfFonts.notEmbeddedCount", { count: notEmbedded })}</span>}
          </div>
          {result.hasWarnings && <p className="pdf-fonts-warning pdf-fonts-notice" role="status"><AlertTriangle size={14} aria-hidden />{t("editor.pdfFonts.partial")}</p>}
          {!result.fonts.length ? <div className="pdf-fonts-state"><CaseSensitive size={25} aria-hidden /><p>{t("editor.pdfFonts.noFonts")}</p></div>
            : <div className="pdf-fonts-table-scroll" tabIndex={0} role="region" aria-label={t("editor.pdfFonts.title")}><table className="pdf-fonts-table">
              <thead><tr>{["name", "type", "encoding", "embedded", "subset", "unicode"].map((column) => <th key={column} scope="col">{t(`editor.pdfFonts.${column}`)}</th>)}</tr></thead>
              <tbody>{result.fonts.map((font, index) => <tr key={index}>
                <td className="pdf-font-name">{font.name}</td><td><span className={font.type === "Type 3" ? "pdf-fonts-warning" : ""}>{font.type}</span></td>
                <td>{font.encoding}</td><td>{flag(font.embedded, !font.embedded)}</td><td>{flag(font.subset)}</td><td>{flag(font.unicode)}</td>
              </tr>)}</tbody>
            </table></div>}
        </>}
  </div>;
}
