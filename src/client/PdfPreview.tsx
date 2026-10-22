import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Maximize2, Minus, Plus, RefreshCw } from "lucide-react";
import { acquirePdfDocument, evictPdfDocument, type PdfDocumentLease, type PdfLoadingMode } from "./pdfDocuments";
import { PdfViewerSession, type PdfTarget } from "./pdfViewer";

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
  const [zoom, setZoom] = useState(100);
  const latest = useRef({ url, target, zoom, onViewportLocation, onDoubleClickLocation, onDisplayedUrlChange });
  latest.current = { url, target, zoom, onViewportLocation, onDoubleClickLocation, onDisplayedUrlChange };

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
          setDisplayedUrl(url);
          setLoading(false);
          setError(false);
          latest.current.onDisplayedUrlChange?.(url);
          dispose(previous);
        },
        onError: fail,
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
      }, { zoom: latest.current.zoom, location: displayed.current?.session?.location(), target: latest.current.target });
    }).catch(fail);
    return () => {
      cancelled = true;
      if (pending.current === entry) { pending.current = null; dispose(entry); }
      // Keep the displayed document alive while the next request/render starts.
    };
  }, [url, loadingMode, retry]);

  useEffect(() => {
    displayed.current?.session?.setZoom(zoom);
    pending.current?.session?.setZoom(zoom);
  }, [zoom]);

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
  const changeZoom = (difference: number) => setZoom((value) => Math.max(50, Math.min(200, value + difference)));

  return <div className="pdf-viewer">
    <div className="pdf-toolbar" role="toolbar" aria-label={t("editor.pdfZoomControls")}>
      <button disabled={zoom <= 50} title={t("editor.pdfZoomOut")} aria-label={t("editor.pdfZoomOut")} onClick={() => changeZoom(-10)}><Minus size={14} /></button>
      <span className="pdf-zoom-value" aria-live="polite">{zoom}%</span>
      <button disabled={zoom >= 200} title={t("editor.pdfZoomIn")} aria-label={t("editor.pdfZoomIn")} onClick={() => changeZoom(10)}><Plus size={14} /></button>
      <button className="pdf-fit-width" title={t("editor.pdfFitWidth")} onClick={() => { setZoom(100); displayed.current?.session?.fitWidth(); pending.current?.session?.fitWidth(); }}><Maximize2 size={13} />{t("editor.pdfFitWidth")}</button>
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
