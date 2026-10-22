// @vitest-environment happy-dom
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ viewers: [] as any[], failConstructor: false, observers: [] as { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[], frames: new Map<number, FrameRequestCallback>() }));
vi.mock("pdfjs-dist", () => ({ AnnotationMode: { ENABLE: 1 }, AnnotationEditorType: { DISABLE: -1 } }));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  RenderingStates: { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 },
  LinkTarget: { BLANK: 2 },
  EventBus: class {
    listeners = new Map<string, Set<Function>>();
    on(name: string, callback: Function, options: { signal?: AbortSignal } = {}) {
      const callbacks = this.listeners.get(name) ?? new Set(); callbacks.add(callback); this.listeners.set(name, callbacks);
      options.signal?.addEventListener("abort", () => callbacks.delete(callback), { once: true });
    }
    dispatch(name: string, event: object) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
  },
  GenericL10n: class { destroy = vi.fn(); },
  PDFLinkService: class {
    constructor(public options: object) {}
    setViewer = vi.fn(); setDocument = vi.fn();
    addLinkAttributes(link: HTMLAnchorElement, url: string) { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
  },
  PDFViewer: class {
    currentPageNumber = 1; pagesCount = 2;
    private scale = 1;
    scaleChanges: number[] = [];
    get currentScale() { return this.scale; }
    set currentScale(value: number) { this.scale = value; this.scaleChanges.push(value); }
    set currentScaleValue(value: string) {
      if (value === "page-width") this.currentScale = (this.options.container.clientWidth - 40) / 560;
    }
    update = vi.fn(); pages: any[] = [];
    setDocument = vi.fn((document: unknown) => { if (!document) this.options.viewer.replaceChildren(); });
    scrollPageIntoView = vi.fn((options: { pageNumber: number }) => { this.currentPageNumber = options.pageNumber; });
    getPageView(index: number) { return this.pages[index]; }
    getCachedPageViews() { return new Set(this.pages); }
    constructor(public options: any) {
      if (state.failConstructor) throw new Error("Cannot initialize viewer");
      state.viewers.push(this);
      for (let page = 1; page <= 2; page++) {
        const div = document.createElement("div"); div.className = "page"; div.dataset.pageNumber = String(page);
        div.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 } as DOMRect);
        options.viewer.append(div);
        const owner = this;
        this.pages.push({ div, viewport: viewport(2), renderingState: 0,
          get width() { return 560 * owner.currentScale; }, get scale() { return owner.currentScale; } });
      }
    }
  }
}));

// A real affine viewport model: native PDF origin is bottom-left; source origin top-left.
function viewport(scale = 1, rotation = 0): PageViewport {
  const toView = (x: number, y: number) => {
    const left = x - 10, top = 820 - y;
    if (rotation === 90) return [(800 - top) * scale, left * scale];
    if (rotation === 180) return [(600 - left) * scale, (800 - top) * scale];
    if (rotation === 270) return [top * scale, (600 - left) * scale];
    return [left * scale, top * scale];
  };
  const toPdf = (x: number, y: number) => {
    x /= scale; y /= scale;
    if (rotation === 90) return [y + 10, x + 20];
    if (rotation === 180) return [610 - x, y + 20];
    if (rotation === 270) return [610 - y, 820 - x];
    return [x + 10, 820 - y];
  };
  return { width: (rotation % 180 ? 800 : 600) * scale, height: (rotation % 180 ? 600 : 800) * scale,
    clone: (options: { scale: number; rotation: number }) => viewport(options.scale, options.rotation),
    convertToViewportPoint: toView, convertToPdfPoint: toPdf } as unknown as PageViewport;
}

import { isAllowedPdfLink, pdfPointToSourceLocation, PdfViewerSession, sourceLocationToPdfPoint } from "../src/client/pdfViewer";

let host: HTMLDivElement, session: PdfViewerSession | null;
const makeCallbacks = () => ({ onReady: vi.fn<() => void>(), onError: vi.fn<() => void>(),
  onLocation: vi.fn<(location: { page: number; x: number; y: number }) => void>(),
  onDoubleClick: vi.fn<(location: { page: number; x: number; y: number }) => void>() });
let callbacks: ReturnType<typeof makeCallbacks>;
let pdf: PDFDocumentProxy;
const viewer = () => state.viewers.at(-1)!;
const emit = (name: string, event = {}) => viewer().options.eventBus.dispatch(name, event);
function flushFrames() {
  const frames = [...state.frames.values()]; state.frames.clear();
  for (const callback of frames) callback(0);
}
function create(options: { zoom: number; target?: { page: number; x: number; y: number; nonce: number } } = { zoom: 100 }) {
  session = new PdfViewerSession(host, pdf, callbacks, options);
  session.container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 700, width: 600, height: 700 } as DOMRect);
  Object.defineProperty(session.container, "clientWidth", { value: 600, configurable: true });
  Object.defineProperty(session.container, "clientHeight", { value: 700 });
  return session;
}

beforeEach(() => {
  state.viewers.length = state.observers.length = 0; state.frames.clear(); state.failConstructor = false;
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(public callback: () => void) { state.observers.push(this); }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = Math.random(); state.frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => state.frames.delete(id));
  callbacks = makeCallbacks();
  pdf = { numPages: 2, getPage: vi.fn(async () => ({ getViewport: () => viewport() })), cleanup: vi.fn() } as unknown as PDFDocumentProxy;
  host = document.createElement("div"); document.body.append(host); session = null;
});
afterEach(() => { session?.destroy(); host.remove(); vi.unstubAllGlobals(); });

describe("PDFViewer adapter", () => {
  it.each([0, 90, 180, 270])("converts source/PDF coordinates at rotation %i, including scale and page-box offsets", (rotation) => {
    const view = viewport(2.5, rotation);
    const point = sourceLocationToPdfPoint(view, 120, 250);
    expect(point).toEqual([130, 570]);
    const screen = view.convertToViewportPoint(...point);
    expect(pdfPointToSourceLocation(view, screen[0], screen[1])).toEqual([120, 250]);
  });

  it("uses the built-in viewer queue/cache, keeps annotations read-only and retains safe external links", () => {
    create();
    expect(viewer().options.renderingQueue).toBeUndefined();
    expect(viewer().options).toMatchObject({ annotationMode: 1, annotationEditorMode: -1, enableAutoLinking: false, maxCanvasPixels: 4096 ** 2 });
    const anchor = document.createElement("a");
    viewer().options.linkService.addLinkAttributes(anchor, "https://example.com/");
    expect(anchor.target).toBe("_blank"); expect(anchor.rel).toContain("noopener");
    viewer().options.linkService.addLinkAttributes(anchor, "javascript:alert(1)");
    expect(anchor.hasAttribute("href")).toBe(false);
  });

  it("waits for a visible, successfully painted page before publishing", () => {
    create(); emit("pagesinit"); emit("pagerendered", { pageNumber: 1 });
    expect(callbacks.onReady).not.toHaveBeenCalled();
    viewer().pages[0].renderingState = 3;
    emit("pagerendered", { pageNumber: 1, cssTransform: true });
    expect(callbacks.onReady).not.toHaveBeenCalled();
    emit("pagerendered", { pageNumber: 1 }); emit("pagerendered", { pageNumber: 1 });
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    session!.show(); expect(session!.container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("coalesces resize/scroll work per frame and restores fit-width-relative zoom", () => {
    create({ zoom: 150 }); emit("pagesinit");
    expect(viewer().currentScale).toBe(1.5);
    emit("updateviewarea"); emit("updateviewarea");
    expect(state.frames.size).toBe(1);
    flushFrames(); expect(callbacks.onLocation).toHaveBeenCalledOnce();
    viewer().currentScale = 1; session!.fitWidth();
    expect(viewer().currentScale).toBe(1); expect(session!.container.scrollLeft).toBe(0);
  });

  it("applies a single final scale per zoom and ignores height-only resize for scaling", () => {
    create({ zoom: 150 }); emit("pagesinit");
    expect(viewer().scaleChanges).toEqual([1.5]);
    viewer().scaleChanges.length = 0;
    state.observers[0].callback(); flushFrames();
    expect(viewer().scaleChanges).toEqual([]);
    expect(viewer().update).toHaveBeenCalled();
    Object.defineProperty(session!.container, "clientWidth", { value: 880, configurable: true });
    state.observers[0].callback(); state.observers[0].callback(); flushFrames();
    expect(viewer().scaleChanges).toEqual([2.25]);
    viewer().scaleChanges.length = 0;
    session!.setZoom(110);
    expect(viewer().scaleChanges).toEqual([1.65]);
    session!.fitWidth();
    expect(viewer().scaleChanges).toHaveLength(2);
    expect(viewer().scaleChanges[1]).toBeCloseTo(1.5);
  });

  it("restores one independent page number after a page is reset or redrawn", () => {
    create(); emit("pagesinit");
    const page = viewer().pages[0].div;
    emit("pagerendered", { pageNumber: 1 }); emit("pagerendered", { pageNumber: 1 });
    expect(page.querySelectorAll(".pdf-page-number")).toHaveLength(1);
    expect(page.querySelector(".pdf-page-number")?.textContent).toBe("1");
    expect(page.querySelector(".pdf-page-number")?.getAttribute("aria-hidden")).toBe("true");
    page.replaceChildren(); emit("pagerendered", { pageNumber: 1 });
    expect(page.querySelectorAll(".pdf-page-number")).toHaveLength(1);
  });

  it("navigates to a pending target, marks it and ignores stale jumps after clearing the target", async () => {
    create({ zoom: 100, target: { page: 2, x: 80, y: 150, nonce: 1 } });
    emit("pagesinit");
    await Promise.resolve(); await Promise.resolve();
    expect(viewer().scrollPageIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ pageNumber: 2, destArray: [null, { name: "XYZ" }, 90, 670, null], ignoreDestinationZoom: true }));
    expect(session!.container.querySelector(".pdf-sync-marker")?.parentElement?.dataset.pageNumber).toBe("2");
    viewer().scrollPageIntoView.mockClear();
    session!.showTarget({ page: 1, x: 1, y: 2, nonce: 2 }); session!.showTarget(null);
    await Promise.resolve();
    expect(viewer().scrollPageIntoView).not.toHaveBeenCalled();
    expect(session!.container.querySelector(".pdf-sync-marker")).toBeNull();
  });

  it("handles double-clicks in rendered pages but not on links or unrendered pages", () => {
    create(); emit("pagesinit"); viewer().pages[0].renderingState = 3; emit("pagerendered", { pageNumber: 1 });
    const page = viewer().pages[0].div;
    page.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 100, clientY: 200 }));
    expect(callbacks.onDoubleClick).toHaveBeenCalledWith({ page: 1, x: 50, y: 100 });
    const link = document.createElement("a"); page.append(link);
    link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    viewer().pages[1].div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(callbacks.onDoubleClick).toHaveBeenCalledOnce();
  });

  it("aborts observers/listeners and resets the viewer without destroying the shared document", () => {
    create(); emit("pagesinit"); emit("updateviewarea");
    session!.destroy(); session!.destroy();
    expect(viewer().options.abortSignal.aborted).toBe(true);
    expect(state.observers[0].disconnect).toHaveBeenCalledOnce();
    expect(viewer().setDocument).toHaveBeenLastCalledWith(null);
    expect(pdf.cleanup).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0); expect(state.frames.size).toBe(0);
    emit("pagerendered", { pageNumber: 1 }); expect(callbacks.onReady).not.toHaveBeenCalled();
  });

  it("cleans its temporary container when viewer construction fails", () => {
    state.failConstructor = true;
    expect(() => create()).toThrow("Cannot initialize viewer");
    expect(host.children).toHaveLength(0);
  });

  it("reports page fetch and render failures without exposing raw PDF errors", async () => {
    create(); emit("pagesinit");
    vi.mocked(pdf.getPage).mockRejectedValueOnce(new Error("HTTP range failed"));
    emit("pagechanging", { pageNumber: 2 }); await Promise.resolve();
    expect(callbacks.onError).toHaveBeenCalledWith();
    emit("pagerendered", { pageNumber: 1, error: new Error("Canvas unavailable") });
    expect(callbacks.onError).toHaveBeenCalledTimes(2);
    expect(callbacks.onReady).not.toHaveBeenCalled();
  });

  it.each(["https://example.com", "http://example.com", "mailto:a@example.com", "ftp://example.com"])("allows the external protocol in %s", (url) => expect(isAllowedPdfLink(url)).toBe(true));
  it.each(["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//example.com", "#anchor"])("rejects %s as an external URL", (url) => expect(isAllowedPdfLink(url)).toBe(false));
});
