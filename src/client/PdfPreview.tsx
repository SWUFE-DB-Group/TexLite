import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, LoaderCircle, Minus, Plus, RefreshCw } from "lucide-react";
import { acquirePdfDocument, evictPdfDocument, type PdfDocumentLease, type PdfLoadingMode } from "./pdfDocuments";
import { PDF_MIN_ZOOM, PDF_MAX_ZOOM, PdfViewerSession, type PdfFitMode, type PdfTarget, type PdfZoomState } from "./pdfViewer";
import { PdfZoomMenu } from "./PdfZoomMenu";

export { preloadPdf, preloadPdfRuntime, type PdfLoadingMode } from "./pdfDocuments";
export type { PdfTarget } from "./pdfViewer";

interface PreviewDocument {
  url: string;
  lease: PdfDocumentLease;
  session: PdfViewerSession | null;
}

function dispose(document: PreviewDocument | null): void {
  if (!document) return;
  document.session?.destroy();
  document.lease.release();
}

export function PdfPreview({ url, loadingMode, target, compiling = false, onViewportLocation, onDoubleClickLocation, onDisplayedUrlChange }: {
  url: string;
  loadingMode: PdfLoadingMode;
  target: PdfTarget | null;
  compiling?: boolean;
  onViewportLocation: (page: number, x: number, y: number) => void;
  onDoubleClickLocation?: (page: number, x: number, y: number) => void;
  onDisplayedUrlChange?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const displayed = useRef<PreviewDocument | null>(null);
  const pending = useRef<PreviewDocument | null>(null);
  const [displayedUrl, setDisplayedUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [scale, setScale] = useState<PdfZoomState>({ zoom: 100, fitMode: "width" });
  const { zoom, fitMode } = scale;
  const [pagination, setPagination] = useState({ page: 0, totalPages: 0 });
  const [pageInput, setPageInput] = useState<string | null>(null);
  const latest = useRef({ url, target, scale, onViewportLocation, onDoubleClickLocation, onDisplayedUrlChange });
  latest.current = { url, target, scale, onViewportLocation, onDoubleClickLocation, onDisplayedUrlChange };

  useEffect(() => {
    let cancelled = false;
    const entry: PreviewDocument = { url, lease: acquirePdfDocument(url, loadingMode), session: null };
    pending.current = entry;
    setError(false);
    setLoading(true);
    const fail = () => {
      if (cancelled || (pending.current !== entry && displayed.current !== entry)) return;
      if (pending.current === entry) { pending.current = null; dispose(entry); }
      setError(true);
      setLoading(false);
    };
    void entry.lease.promise.then((document) => {
      if (cancelled || pending.current !== entry || !host.current) return;
      entry.session = new PdfViewerSession(host.current, document, {
        onReady: () => {
          if (cancelled || pending.current !== entry) return;
          const previous = displayed.current;
          pending.current = null;
          displayed.current = entry;
          entry.session?.show();
          if (entry.session) {
            setPagination(entry.session.pageState());
            latest.current.scale = entry.session.zoomState();
            setScale(latest.current.scale);
          }
          setPageInput(null);
          setDisplayedUrl(url);
          setLoading(false);
          setError(false);
          latest.current.onDisplayedUrlChange?.(url);
          dispose(previous);
        },
        onError: fail,
        onPageChange: (page, totalPages) => {
          if (displayed.current === entry) setPagination({ page, totalPages });
        },
        onZoom: (value, mode = null) => {
          // The old PDF remains interactive while its replacement paints.
          // Carry its zoom forward without accepting stale SyncTeX positions.
          if (displayed.current !== entry) return;
          const nextScale = { zoom: value, fitMode: mode };
          latest.current.scale = nextScale;
          setScale((current) => current.zoom === value && current.fitMode === mode ? current : nextScale);
        },
        onLocation: ({ page, x, y }) => {
          if (displayed.current === entry && latest.current.url === entry.url) {
            latest.current.onViewportLocation(page, x, y);
          }
        },
        onDoubleClick: ({ page, x, y }) => {
          if (displayed.current === entry && latest.current.url === entry.url) {
            latest.current.onDoubleClickLocation?.(page, x, y);
          }
        }
      }, { ...latest.current.scale, location: displayed.current?.session?.location(), target: latest.current.target });
    }).catch(fail);
    return () => {
      cancelled = true;
      if (pending.current === entry) { pending.current = null; dispose(entry); }
      // Keep the displayed document alive while the next request/render starts.
    };
  }, [url, loadingMode, retry]);

  useEffect(() => {
    displayed.current?.session?.setZoom(zoom, fitMode);
    pending.current?.session?.setZoom(zoom, fitMode);
  }, [zoom, fitMode]);

  useEffect(() => {
    if (displayed.current?.url === url) displayed.current.session?.showTarget(target);
    if (pending.current?.url === url) pending.current.session?.showTarget(target);
  }, [url, target?.nonce]);

  useEffect(() => () => {
    dispose(pending.current);
    dispose(displayed.current);
    pending.current = displayed.current = null;
    latest.current.onDisplayedUrlChange?.("");
  }, []);

  const retryDocument = () => {
    evictPdfDocument(url, loadingMode);
    setRetry((value) => value + 1);
  };
  const selectZoom = (value: number, mode: PdfFitMode) => {
    latest.current.scale = { zoom: value, fitMode: mode };
    setScale(latest.current.scale);
  };
  const changeZoom = (difference: number) => selectZoom(Math.max(Math.min(PDF_MIN_ZOOM, zoom), Math.min(PDF_MAX_ZOOM, zoom + difference)), null);
  const changePage = (difference: number) => {
    const session = displayed.current?.session;
    if (!session) return;
    setPageInput(null);
    session.goToPage(session.pageState().page + difference);
  };
  const commitPage = () => {
    if (pageInput !== null && /^\d+$/.test(pageInput.trim())) displayed.current?.session?.goToPage(Number(pageInput.trim()));
    setPageInput(null);
  };

  return <div className="pdf-viewer">
    <div className="pdf-toolbar" role="toolbar" aria-label={t("editor.pdfControls")}>
      <div className="pdf-page-controls">
        <button type="button" disabled={pagination.page <= 1} title={t("editor.pdfPreviousPage")} aria-label={t("editor.pdfPreviousPage")} onClick={() => changePage(-1)}><ChevronUp size={14} /></button>
        <button type="button" disabled={!pagination.totalPages || pagination.page >= pagination.totalPages} title={t("editor.pdfNextPage")} aria-label={t("editor.pdfNextPage")} onClick={() => changePage(1)}><ChevronDown size={14} /></button>
        <input className="pdf-page-input" type="text" inputMode="numeric" aria-label={t("editor.pdfPageNumber")} placeholder="—" disabled={!pagination.totalPages}
          style={{ width: `${Math.max(2, String(pagination.totalPages).length) + 1}ch` }}
          value={pageInput ?? (pagination.totalPages ? String(pagination.page) : "")}
          onChange={(event) => setPageInput(event.target.value)} onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commitPage(); }
            else if (event.key === "Escape") { event.preventDefault(); setPageInput(null); }
          }} />
        <span className="pdf-page-total">/ {pagination.totalPages || "—"}</span>
      </div>
      <div className="pdf-zoom-controls">
        <button disabled={zoom <= PDF_MIN_ZOOM} title={t("editor.pdfZoomOut")} aria-label={t("editor.pdfZoomOut")} onClick={() => changeZoom(-10)}><Minus size={14} /></button>
        <PdfZoomMenu zoom={zoom} fitMode={fitMode} onChange={selectZoom} />
        <button disabled={zoom >= PDF_MAX_ZOOM} title={t("editor.pdfZoomIn")} aria-label={t("editor.pdfZoomIn")} onClick={() => changeZoom(10)}><Plus size={14} /></button>
      </div>
    </div>
    {compiling && <div className="pdf-compiling-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} /><span>{t("editor.compiling")}</span></div>}
    {loading && displayedUrl && !compiling && <div className="pdf-loading-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} /><span>{t("editor.loadingPdf")}</span></div>}
    {error && displayedUrl && <div className="pdf-load-error-overlay" role="status" aria-live="polite"><span>{t("editor.pdfLoadFailed")}</span><button type="button" onClick={retryDocument}><RefreshCw size={13} />{t("common.retry")}</button></div>}
    <div className="pdf-stage" ref={host} />
    {!displayedUrl && <div className="pdf-initial-state">
      {error ? <div className="preview-empty"><strong>{t("editor.pdfLoadFailed")}</strong><button type="button" onClick={retryDocument}><RefreshCw size={14} />{t("common.retry")}</button></div> :
        <div className="pdf-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}
    </div>}
  </div>;
}
