import { useEffect, useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, PDFWorker, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { Download, LoaderCircle, Maximize2, Minus, Plus } from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
const sharedPdfWorker = new PDFWorker();

export interface PdfTarget {
  page: number;
  x: number;
  y: number;
  nonce: number;
}

export function PdfPreview({ url, target, compiling = false, onViewportLocation }: {
  url: string;
  target: PdfTarget | null;
  compiling?: boolean;
  onViewportLocation: (page: number, x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState("");

  const reportViewport = () => {
    const viewer = root.current;
    if (!viewer) return;
    const viewerBounds = viewer.getBoundingClientRect();
    const centerX = viewerBounds.left + viewerBounds.width / 2;
    const centerY = viewerBounds.top + viewerBounds.height / 2;
    const pages = [...viewer.querySelectorAll<HTMLElement>(".pdf-page")];
    const page = pages.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return centerY >= bounds.top && centerY <= bounds.bottom;
    }) ?? pages.reduce<HTMLElement | null>((closest, candidate) => {
      if (!closest) return candidate;
      const distance = Math.abs(candidate.getBoundingClientRect().top - centerY);
      const closestDistance = Math.abs(closest.getBoundingClientRect().top - centerY);
      return distance < closestDistance ? candidate : closest;
    }, null);
    if (!page) return;
    const bounds = page.getBoundingClientRect();
    const scale = Number(page.dataset.scale) || 1;
    const pageNumber = Number(page.dataset.page);
    const x = Math.max(0, Math.min(bounds.width, centerX - bounds.left)) / scale;
    const y = Math.max(0, Math.min(bounds.height, centerY - bounds.top)) / scale;
    if (pageNumber) onViewportLocation(pageNumber, x, y);
  };

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDocument(null); setError("");
    const task = getDocument({ url, worker: sharedPdfWorker });
    void task.promise.then((loaded) => {
      if (!cancelled) setDocument(loaded);
    }).catch(() => { if (!cancelled) setError(t("editor.pdfLoadFailed")); });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (zoom > 100 || !root.current) return;
    // Returning from a magnified view leaves the old, wide canvas mounted
    // while PDF.js renders the fitted page. Reset the horizontal origin now so
    // that the fitted result can never reopen with its left side off-screen.
    root.current.scrollLeft = 0;
  }, [zoom, width, document]);

  const changeZoom = (difference: number) => setZoom((current) => Math.min(200, Math.max(50, current + difference)));
  const fitWidth = () => {
    if (root.current) root.current.scrollLeft = 0;
    setZoom(100);
  };
  const scrollHorizontally = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY;
    reportViewport();
  };
  const downloadUrl = `${url}${url.includes("?") ? "&" : "?"}download=1`;

  return <div className="pdf-viewer">
    <div className="pdf-toolbar" role="toolbar" aria-label={t("editor.pdfZoomControls")}>
      <a className="pdf-download" href={downloadUrl} download title={t("editor.downloadPdf")} aria-label={t("editor.downloadPdf")}><Download size={14} /></a>
      <button disabled={zoom <= 50} title={t("editor.pdfZoomOut")} aria-label={t("editor.pdfZoomOut")} onClick={() => changeZoom(-10)}><Minus size={14} /></button>
      <span className="pdf-zoom-value" aria-live="polite">{zoom}%</span>
      <button disabled={zoom >= 200} title={t("editor.pdfZoomIn")} aria-label={t("editor.pdfZoomIn")} onClick={() => changeZoom(10)}><Plus size={14} /></button>
      <button className="pdf-fit-width" title={t("editor.pdfFitWidth")} onClick={fitWidth}><Maximize2 size={13} />{t("editor.pdfFitWidth")}</button>
    </div>
    {compiling && <div className="pdf-compiling-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={20} /><span>{t("editor.compiling")}</span></div>}
    <div className="pdf-document" ref={root} onScroll={reportViewport} onWheel={scrollHorizontally}>
      <div className="pdf-pages" style={{ width: `${Math.max(1, width - 28) * Math.max(1, zoom / 100)}px` }}>
        {error && <div className="preview-empty"><strong>{error}</strong></div>}
        {document && width > 0 && Array.from({ length: document.numPages }, (_item, index) =>
          <PdfPage key={index + 1} document={document} pageNumber={index + 1} availableWidth={width - 28} zoom={zoom / 100}
            target={target?.page === index + 1 ? target : null} onReady={reportViewport} />)}
      </div>
    </div>
  </div>;
}

function PdfPage({ document, pageNumber, availableWidth, zoom, target, onReady }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  availableWidth: number;
  zoom: number;
  target: PdfTarget | null;
  onReady: () => void;
}) {
  const figure = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [shouldRender, setShouldRender] = useState(pageNumber === 1);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const element = figure.current;
    if (!element || shouldRender) return;
    if (!("IntersectionObserver" in window)) {
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldRender(true);
      observer.disconnect();
    }, { rootMargin: "900px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldRender]);

  useEffect(() => {
    if (target) setShouldRender(true);
  }, [target?.nonce]);

  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setRendered(false);
    void document.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const fitScale = availableWidth / base.width;
      const nextScale = Math.min(3.3, Math.max(0.175, fitScale * zoom));
      const viewport = page.getViewport({ scale: nextScale });
      setScale(nextScale);
      setSize({ width: viewport.width, height: viewport.height });
      if (!canvas.current) return;
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      const renderViewport = page.getViewport({ scale: nextScale * outputScale });
      canvas.current.width = Math.floor(renderViewport.width);
      canvas.current.height = Math.floor(renderViewport.height);
      renderTask = page.render({ canvas: canvas.current, viewport: renderViewport });
      return renderTask.promise.then(() => {
        if (cancelled) return;
        setRendered(true);
        window.requestAnimationFrame(onReady);
      });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, availableWidth, zoom, shouldRender]);

  useEffect(() => {
    if (!target || !marker.current) return;
    marker.current.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, [target?.nonce, scale]);

  const estimatedWidth = Math.max(1, availableWidth * zoom);
  const estimatedHeight = estimatedWidth * (792 / 612);
  return <figure ref={figure} className={`pdf-page${rendered ? " rendered" : " loading"}`} data-page={pageNumber} data-scale={scale} style={{ width: `${size.width || estimatedWidth}px`, minHeight: `${size.height || estimatedHeight}px` }}>
    <canvas ref={canvas} style={{ width: `${size.width || estimatedWidth}px`, height: `${size.height || estimatedHeight}px` }} />
    {target && <span ref={marker} className="pdf-sync-marker" style={{ left: target.x * scale, top: target.y * scale }} />}
    <figcaption>{pageNumber}</figcaption>
  </figure>;
}
