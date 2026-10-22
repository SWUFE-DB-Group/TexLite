// The viewer distribution reads the core's pdfjsLib global during evaluation.
import { AnnotationEditorType, AnnotationMode, type PDFDocumentProxy, type PageViewport } from "pdfjs-dist";
import { EventBus, GenericL10n, LinkTarget, PDFLinkService, PDFViewer, RenderingStates } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFViewerOptions } from "pdfjs-dist/types/web/pdf_viewer";
import "pdfjs-dist/web/pdf_viewer.css";

export interface PdfLocation { page: number; x: number; y: number }
export interface PdfTarget extends PdfLocation { nonce: number }

interface PageView {
  div: HTMLDivElement;
  viewport: PageViewport;
  renderingState: number;
  width: number;
  scale: number;
}

interface PdfViewerCallbacks {
  onReady: () => void;
  onError: () => void;
  onLocation: (location: PdfLocation) => void;
  onDoubleClick: (location: PdfLocation) => void;
}

export function isAllowedPdfLink(url: string): boolean {
  return /^(?:https?|mailto|ftp):/i.test(url.trim());
}

/** Retain TexLite's explicit external-protocol allowlist on top of PDF.js. */
class SafePdfLinkService extends PDFLinkService {
  override addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow = false): void {
    if (!isAllowedPdfLink(url)) {
      link.removeAttribute("href");
      link.onclick = () => false;
      return;
    }
    super.addLinkAttributes(link, url, newWindow);
  }
}

/** SyncTeX uses top-left points in the page's unrotated, scale-1 viewport. */
export function pdfPointToSourceLocation(viewport: PageViewport, x: number, y: number): [number, number] {
  const point = viewport.convertToPdfPoint(x, y);
  const [left, top] = viewport.clone({ scale: 1, rotation: 0 }).convertToViewportPoint(point[0], point[1]);
  return [left, top];
}

export function sourceLocationToPdfPoint(viewport: PageViewport, x: number, y: number): [number, number] {
  const [left, bottom] = viewport.clone({ scale: 1, rotation: 0 }).convertToPdfPoint(x, y);
  return [left, bottom];
}

/** One viewer owns its DOM, queue and page cache, but never destroys the document. */
export class PdfViewerSession {
  readonly container: HTMLDivElement;
  private readonly viewer: PDFViewer;
  private readonly linkService: PDFLinkService;
  private readonly events = new EventBus();
  private readonly abort = new AbortController();
  private readonly l10n = new GenericL10n("");
  private readonly document: PDFDocumentProxy;
  private readonly callbacks: PdfViewerCallbacks;
  private resize: ResizeObserver | null = null;
  private frame: number | null = null;
  private zoom = 100;
  private initialized = false;
  private ready = false;
  private destroyed = false;
  private navigation = 0;
  private target: PdfTarget | null = null;
  private marker: HTMLSpanElement | null = null;
  private initialNavigationPending = false;
  private fittedWidth = 0;

  // PDF.js reserves this amount for horizontal margins in page-width mode.
  private static readonly PAGE_WIDTH_PADDING = 40;

  constructor(host: HTMLDivElement, document: PDFDocumentProxy, callbacks: PdfViewerCallbacks,
    options: { zoom: number; location?: PdfLocation | null; target?: PdfTarget | null }) {
    this.document = document;
    this.callbacks = callbacks;
    this.zoom = options.zoom;
    this.target = options.target ?? null;
    this.container = window.document.createElement("div");
    this.container.className = "pdf-document pdf-viewer-pending";
    this.container.tabIndex = 0;
    this.container.setAttribute("aria-hidden", "true");
    const pages = window.document.createElement("div");
    pages.className = "pdfViewer";
    this.container.append(pages);
    host.append(this.container);
    this.linkService = new SafePdfLinkService({
      eventBus: this.events, externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer", ignoreDestinationZoom: true
    });
    // abortSignal is supported by this distribution but missing from its .d.ts.
    const viewerOptions: PDFViewerOptions & { abortSignal: AbortSignal } = {
      container: this.container, viewer: pages, eventBus: this.events, linkService: this.linkService,
      l10n: this.l10n, abortSignal: this.abort.signal,
      annotationMode: AnnotationMode.ENABLE, annotationEditorMode: AnnotationEditorType.DISABLE,
      enableAutoLinking: false, maxCanvasPixels: 4096 * 4096, enableDetailCanvas: true
    };
    try {
      this.viewer = new PDFViewer(viewerOptions);
      this.initialize(options.location);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private initialize(initialLocation?: PdfLocation | null): void {
    this.linkService.setViewer(this.viewer);
    const listen = <T>(name: string, listener: (event: T) => void) =>
      this.events.on(name, listener, { signal: this.abort.signal });
    listen("pagesinit", () => {
      if (this.destroyed) return;
      this.initialized = true;
      this.applyZoom();
      const location = this.target ?? initialLocation;
      if (location) {
        this.initialNavigationPending = true;
        void this.navigate(location, Boolean(this.target)).finally(() => {
          this.initialNavigationPending = false;
          if (!this.destroyed) { this.viewer.update(); this.checkReady(); }
        });
      }
      this.viewer.update();
    });
    listen("pagerendered", (event: { pageNumber: number; error?: unknown; cssTransform?: boolean }) => {
      if (this.destroyed) return;
      if (event.error) { this.callbacks.onError(); return; }
      this.updatePageNumber(event.pageNumber);
      this.updateMarker();
      if (!event.cssTransform) this.checkReady();
      this.scheduleUpdate();
    });
    listen("updateviewarea", () => { this.scheduleUpdate(); });
    listen("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      // Surface range/page-load failures as well as canvas render failures.
      void this.document.getPage(pageNumber).catch(() => {
        if (!this.destroyed) this.callbacks.onError();
      });
    });
    this.container.addEventListener("dblclick", this.doubleClick, { signal: this.abort.signal });
    this.container.addEventListener("wheel", this.wheel, { passive: false, signal: this.abort.signal });
    this.resize = new ResizeObserver(() => this.scheduleUpdate(true));
    this.resize.observe(this.container);
    this.linkService.setDocument(this.document);
    this.viewer.setDocument(this.document);
    // The native viewer catches initialization errors (including first-page
    // setup) internally and rejects pagesPromise instead of emitting an event.
    // Observe failures only: readiness still requires a visible painted page.
    void this.viewer.pagesPromise.catch(() => { if (!this.destroyed) this.callbacks.onError(); });
  }

  show(): void {
    this.container.classList.remove("pdf-viewer-pending");
    this.container.removeAttribute("aria-hidden");
    this.scheduleUpdate();
  }

  setZoom(zoom: number): void {
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    if (this.initialized) this.applyZoom();
  }

  fitWidth(): void {
    this.zoom = 100;
    if (this.initialized) this.applyZoom();
    this.container.scrollLeft = 0;
  }

  showTarget(target: PdfTarget | null): void {
    this.target = target;
    if (!target) { this.navigation += 1; this.marker?.remove(); this.marker = null; return; }
    if (this.initialized) void this.navigate(target, true);
  }

  location(): PdfLocation | null {
    if (!this.initialized || this.destroyed) return null;
    const bounds = this.container.getBoundingClientRect();
    const centerX = bounds.left + this.container.clientWidth / 2;
    const centerY = bounds.top + this.container.clientHeight / 2;
    let page = this.pageView(this.viewer.currentPageNumber);
    // The viewer's bounded cache includes rendered visible pages at low zoom.
    for (const candidate of this.viewer.getCachedPageViews() as Set<PageView>) {
      const rect = candidate.div.getBoundingClientRect();
      if (centerY >= rect.top && centerY <= rect.bottom) { page = candidate; break; }
    }
    if (!page) return null;
    const rect = page.div.getBoundingClientRect();
    const [x, y] = pdfPointToSourceLocation(page.viewport,
      Math.max(0, Math.min(page.viewport.width, centerX - rect.left)),
      Math.max(0, Math.min(page.viewport.height, centerY - rect.top)));
    return { page: Number(page.div.dataset.pageNumber), x, y };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.navigation += 1;
    this.abort.abort();
    this.resize?.disconnect();
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    // null is the upstream reset API; its declaration incorrectly omits null.
    if (this.viewer) (this.viewer.setDocument as (document: PDFDocumentProxy | null) => void)(null);
    this.linkService.setDocument(null);
    void this.l10n.destroy();
    this.container.remove();
  }

  private pageView(pageNumber: number): PageView | null {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.viewer.pagesCount) return null;
    return this.viewer.getPageView(pageNumber - 1) as PageView | null;
  }

  private isVisible(element: HTMLElement): boolean {
    const page = element.getBoundingClientRect(), bounds = this.container.getBoundingClientRect();
    return page.bottom > bounds.top && page.top < bounds.bottom && page.right > bounds.left && page.left < bounds.right;
  }

  private checkReady(): void {
    if (this.ready || this.destroyed || this.initialNavigationPending) return;
    for (const number of [this.viewer.currentPageNumber, this.viewer.currentPageNumber - 1, this.viewer.currentPageNumber + 1]) {
      const page = this.pageView(number);
      if (page?.renderingState === RenderingStates.FINISHED && this.isVisible(page.div)) {
        this.ready = true;
        this.callbacks.onReady();
        return;
      }
    }
  }

  private applyZoom(): void {
    // Preserve TexLite's fit-width-relative percentage, not PDF.js's 96-DPI scale.
    const page = this.pageView(this.viewer.currentPageNumber);
    const width = this.container.clientWidth;
    if (!page || width <= PdfViewerSession.PAGE_WIDTH_PADDING) return;
    const fitScale = (width - PdfViewerSession.PAGE_WIDTH_PADDING) / page.width * page.scale;
    const scale = fitScale * this.zoom / 100;
    this.fittedWidth = width;
    // Assign the final value once. Going through page-width first would cancel
    // and restart painting twice at every non-100% zoom or resize.
    if (Math.abs(this.viewer.currentScale - scale) > 1e-10) this.viewer.currentScale = scale;
    if (this.zoom <= 100) this.container.scrollLeft = 0;
    this.updateMarker();
  }

  private updatePageNumber(pageNumber: number): void {
    const page = this.pageView(pageNumber);
    if (!page || page.div.querySelector(":scope > .pdf-page-number")) return;
    const number = window.document.createElement("span");
    number.className = "pdf-page-number";
    number.textContent = String(pageNumber);
    number.setAttribute("aria-hidden", "true");
    page.div.append(number);
  }

  private resizePending = false;
  private scheduleUpdate(resize = false): void {
    if (this.destroyed) return;
    this.resizePending ||= resize;
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      if (this.destroyed || !this.initialized) return;
      if (this.resizePending) {
        this.resizePending = false;
        if (this.container.clientWidth !== this.fittedWidth) this.applyZoom();
        this.viewer.update();
      }
      const location = this.location();
      if (location) this.callbacks.onLocation(location);
    });
  }

  private async navigate(location: PdfLocation, mark: boolean): Promise<void> {
    const sequence = ++this.navigation;
    const pageNumber = Math.max(1, Math.min(this.document.numPages, location.page));
    try {
      const page = await this.document.getPage(pageNumber);
      if (this.destroyed || sequence !== this.navigation) return;
      const [x, y] = sourceLocationToPdfPoint(page.getViewport({ scale: 1 }), location.x, location.y);
      this.viewer.scrollPageIntoView({ pageNumber, destArray: [null, { name: "XYZ" }, x, y, null],
        ignoreDestinationZoom: true, center: "both" });
      if (mark) this.updateMarker();
      this.viewer.update();
    } catch { if (!this.destroyed && sequence === this.navigation) this.callbacks.onError(); }
  }

  private updateMarker(): void {
    if (!this.target || this.destroyed) return;
    const page = this.pageView(this.target.page);
    if (!page) return;
    const point = sourceLocationToPdfPoint(page.viewport, this.target.x, this.target.y);
    const [x, y] = page.viewport.convertToViewportPoint(...point);
    this.marker ??= window.document.createElement("span");
    this.marker.className = "pdf-sync-marker";
    this.marker.style.left = `${x}px`;
    this.marker.style.top = `${y}px`;
    page.div.append(this.marker);
  }

  private doubleClick = (event: MouseEvent): void => {
    if (!this.ready || !(event.target instanceof Element) || event.target.closest("a, button, input, textarea")) return;
    const element = event.target.closest<HTMLElement>(".page[data-page-number]");
    const pageNumber = Number(element?.dataset.pageNumber);
    const page = this.pageView(pageNumber);
    if (!page || page.renderingState !== RenderingStates.FINISHED || !element || !this.container.contains(element)) return;
    const bounds = element.getBoundingClientRect();
    const [x, y] = pdfPointToSourceLocation(page.viewport, event.clientX - bounds.left, event.clientY - bounds.top);
    this.callbacks.onDoubleClick({ page: pageNumber, x, y });
  };

  private wheel = (event: WheelEvent): void => {
    if (!event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    this.container.scrollLeft += event.deltaY;
    this.scheduleUpdate();
  };
}
