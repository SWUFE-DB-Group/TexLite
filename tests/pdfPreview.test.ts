// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfFitMode, PdfZoomState } from "../src/client/pdfViewer";

const state = vi.hoisted(() => ({
  leases: [] as { url: string; release: ReturnType<typeof vi.fn>; resolve: (value: object) => void; reject: (error: Error) => void }[],
  sessions: [] as { callbacks: Record<string, Function>; options: Record<string, unknown>; show: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setZoom: ReturnType<typeof vi.fn>; showTarget: ReturnType<typeof vi.fn>; location: ReturnType<typeof vi.fn>; zoomState: ReturnType<typeof vi.fn>; pageState: ReturnType<typeof vi.fn>; goToPage: ReturnType<typeof vi.fn> }[],
  evict: vi.fn()
}));
vi.mock("../src/client/pdfDocuments", () => ({
  acquirePdfDocument: (url: string) => {
    let resolve!: (value: object) => void, reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const release = vi.fn();
    state.leases.push({ url, release, resolve, reject });
    return { promise, release };
  },
  evictPdfDocument: state.evict, preloadPdf: vi.fn(), preloadPdfRuntime: vi.fn()
}));
vi.mock("../src/client/pdfViewer", () => ({
  PDF_MIN_ZOOM: 10, PDF_MAX_ZOOM: 200,
  PdfViewerSession: class {
    show = vi.fn(); destroy = vi.fn(); showTarget = vi.fn();
    zoomState = vi.fn<() => PdfZoomState>(() => ({ zoom: 100, fitMode: "width" }));
    setZoom = vi.fn((zoom: number, fitMode: PdfFitMode = null) => {
      const current = this.zoomState();
      if (current.fitMode === fitMode && (fitMode !== null || current.zoom === zoom)) return;
      const next = { zoom: fitMode === "page" ? 60 : zoom, fitMode };
      this.zoomState.mockReturnValue(next);
      if (fitMode === "page") this.callbacks.onZoom(next.zoom, fitMode);
    });
    location = vi.fn(() => ({ page: 3, x: 10, y: 20 }));
    pageState = vi.fn(() => ({ page: 1, totalPages: 10 }));
    goToPage = vi.fn((page: number) => {
      const totalPages = this.pageState().totalPages;
      const next = { page: Math.max(1, Math.min(totalPages, page)), totalPages };
      this.pageState.mockReturnValue(next);
      this.callbacks.onPageChange(next.page, next.totalPages);
    });
    constructor(_host: unknown, _document: unknown, public callbacks: Record<string, Function>, public options: Record<string, unknown>) {
      this.zoomState.mockReturnValue({ zoom: options.fitMode === "page" ? 60 : Number(options.zoom), fitMode: options.fitMode as PdfFitMode });
      state.sessions.push(this);
    }
  }
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PdfPreview } from "../src/client/PdfPreview";
import type { PdfTarget } from "../src/client/pdfViewer";

let root: Root, container: HTMLDivElement;
const props = () => ({ url: "/one.pdf", loadingMode: "full" as const, target: null as PdfTarget | null, onViewportLocation: vi.fn(), onDoubleClickLocation: vi.fn(), onDisplayedUrlChange: vi.fn() });
let current: ReturnType<typeof props>;
async function render(overrides: Partial<typeof current> = {}) {
  current = { ...current, ...overrides };
  await act(async () => { root.render(createElement(PdfPreview, current)); });
}
async function loaded(index: number) { await act(async () => { state.leases[index].resolve({}); }); }
async function painted(index: number) { await act(async () => { state.sessions[index].callbacks.onReady(); }); }
async function pageChanged(index: number, page: number, totalPages: number) {
  await act(async () => {
    state.sessions[index].pageState.mockReturnValue({ page, totalPages });
    state.sessions[index].callbacks.onPageChange(page, totalPages);
  });
}
async function editPage(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(".pdf-page-input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseZoom(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(".pdf-zoom-trigger")!;
  if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('.pdf-zoom-menu [role="menuitemradio"]')].find(element => element.textContent === label)!;
  expect(item).toBeDefined();
  await act(async () => item.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.leases.length = state.sessions.length = 0;
  state.evict.mockClear();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); current = props();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("PDFViewer document replacement", () => {
  it("selects fit modes and numeric zoom presets from a single menu and leaves fit mode on manual zoom", async () => {
    await render(); await loaded(0); await painted(0);
    expect(container.querySelector(".pdf-fit-width")).toBeNull();
    await chooseZoom("75%");
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("75%");
    expect(state.sessions[0].setZoom).toHaveBeenLastCalledWith(75, null);
    expect(document.querySelector(".pdf-zoom-menu")).toBeNull();
    await chooseZoom("editor.pdfFitPage");
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("60%");
    expect(state.sessions[0].setZoom).toHaveBeenLastCalledWith(60, "page");
    await act(async () => container.querySelector<HTMLButtonElement>(".pdf-zoom-trigger")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.querySelector('.pdf-zoom-menu [aria-checked="true"]')?.textContent).toBe("editor.pdfFitPage");
    await chooseZoom("editor.pdfFitWidth");
    expect(state.sessions[0].setZoom).toHaveBeenLastCalledWith(100, "width");
    await chooseZoom("100%");
    expect(state.sessions[0].setZoom).toHaveBeenLastCalledWith(100, null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfZoomIn"]')!.click());
    expect(state.sessions[0].setZoom).toHaveBeenLastCalledWith(110, null);
    await chooseZoom("25%");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfZoomOut"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfZoomOut"]')!.click());
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("10%");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfZoomOut"]')?.disabled).toBe(true);
    await chooseZoom("200%");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfZoomIn"]')?.disabled).toBe(true);
  });

  it("retains fit mode through loading/recompilation and reads the new PDF's fitted percentage only on publication", async () => {
    await render(); await chooseZoom("editor.pdfFitPage"); await loaded(0);
    expect(state.sessions[0].options.fitMode).toBe("page");
    await painted(0);
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("60%");
    await render({ url: "/two.pdf" }); await loaded(1);
    expect(state.sessions[1].options).toMatchObject({ zoom: 60, fitMode: "page" });
    state.sessions[1].zoomState.mockReturnValue({ zoom: 40, fitMode: "page" });
    await act(async () => state.sessions[1].callbacks.onZoom(40, "page"));
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("60%");
    await painted(1);
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("40%");
    await act(async () => state.sessions[0].callbacks.onZoom(100));
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("40%");
    await act(async () => state.sessions[1].callbacks.onZoom(65));
    expect(state.sessions[1].setZoom).toHaveBeenLastCalledWith(65, null);
    expect(state.leases).toHaveLength(2);
  });

  it("publishes page controls only for the displayed PDF, follows scrolls, and disables first/last boundaries", async () => {
    await render();
    const previous = () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfPreviousPage"]')!;
    const next = () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfNextPage"]')!;
    const input = () => container.querySelector<HTMLInputElement>(".pdf-page-input")!;
    expect(previous().disabled).toBe(true); expect(next().disabled).toBe(true); expect(input().disabled).toBe(true);
    await loaded(0); await pageChanged(0, 3, 10);
    expect(input().disabled).toBe(true);
    await painted(0);
    expect(input().value).toBe("3"); expect(container.querySelector(".pdf-page-total")?.textContent).toBe("/ 10");
    await act(async () => previous().click());
    expect(state.sessions[0].goToPage).toHaveBeenLastCalledWith(2); expect(input().value).toBe("2");
    await act(async () => { next().click(); next().click(); });
    expect(state.sessions[0].goToPage).toHaveBeenLastCalledWith(4); expect(input().value).toBe("4");
    await pageChanged(0, 10, 10);
    expect(next().disabled).toBe(true); expect(previous().disabled).toBe(false);
    await pageChanged(0, 1, 1);
    expect(previous().disabled).toBe(true); expect(next().disabled).toBe(true);
    expect(state.leases).toHaveLength(1);
  });

  it("commits page drafts on Enter or blur, preserves them during scrolling, and resets invalid or cancelled input", async () => {
    await render(); await loaded(0); await painted(0);
    const input = container.querySelector<HTMLInputElement>(".pdf-page-input")!;
    const enter = () => act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await editPage("5"); await pageChanged(0, 2, 10);
    expect(input.value).toBe("5");
    await enter(); expect(input.value).toBe("5");
    expect(state.sessions[0].goToPage).toHaveBeenLastCalledWith(5);
    await editPage("999"); await enter(); expect(input.value).toBe("10");
    await editPage("0"); await enter(); expect(input.value).toBe("1");
    state.sessions[0].goToPage.mockClear();
    for (const invalid of ["", "abc", "2.5", "-1"]) {
      await editPage(invalid); await enter(); expect(input.value).toBe("1");
    }
    expect(state.sessions[0].goToPage).not.toHaveBeenCalled();
    await editPage("7");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(input.value).toBe("1"); expect(state.sessions[0].goToPage).not.toHaveBeenCalled();
    await act(async () => input.focus());
    await editPage("6");
    await act(async () => input.blur());
    expect(input.value).toBe("6"); expect(state.sessions[0].goToPage).toHaveBeenCalledExactlyOnceWith(6);
  });

  it("keeps navigation tied to the visible document until replacement and ignores stale page events afterwards", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ url: "/two.pdf" }); await loaded(1);
    await pageChanged(1, 1, 2);
    expect(container.querySelector(".pdf-page-total")?.textContent).toBe("/ 10");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfNextPage"]')!.click());
    expect(state.sessions[0].goToPage).toHaveBeenCalledExactlyOnceWith(2);
    expect(state.sessions[1].goToPage).not.toHaveBeenCalled();
    await pageChanged(1, 2, 2); await painted(1);
    expect(container.querySelector<HTMLInputElement>(".pdf-page-input")?.value).toBe("2");
    expect(container.querySelector(".pdf-page-total")?.textContent).toBe("/ 2");
    await pageChanged(0, 8, 10);
    expect(container.querySelector<HTMLInputElement>(".pdf-page-input")?.value).toBe("2");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfPreviousPage"]')!.click());
    expect(state.sessions[1].goToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not publish a loaded PDF until a visible page has painted", async () => {
    await render(); await loaded(0);
    expect(current.onDisplayedUrlChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("editor.loadingPdf");
    await painted(0);
    expect(state.sessions[0].show).toHaveBeenCalledOnce();
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/one.pdf");
    expect(container.querySelector(".pdf-initial-state")).toBeNull();
  });

  it("keeps the old viewer and lease until the replacement paints, preserving the reading position", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ url: "/two.pdf" });
    expect(state.sessions[0].destroy).not.toHaveBeenCalled();
    expect(state.leases[0].release).not.toHaveBeenCalled();
    expect(container.querySelector(".pdf-loading-overlay")).not.toBeNull();
    await loaded(1);
    expect(state.sessions[1].options.location).toEqual({ page: 3, x: 10, y: 20 });
    expect(state.sessions[0].destroy).not.toHaveBeenCalled();
    await painted(1);
    expect(state.sessions[0].destroy).toHaveBeenCalledOnce();
    expect(state.leases[0].release).toHaveBeenCalledOnce();
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/two.pdf");
  });

  it("preserves the old PDF on download/render failure and supports retry", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ url: "/two.pdf" }); await loaded(1);
    await act(async () => state.sessions[1].callbacks.onError());
    expect(state.sessions[1].destroy).toHaveBeenCalledOnce();
    expect(state.leases[1].release).toHaveBeenCalledOnce();
    expect(state.sessions[0].destroy).not.toHaveBeenCalled();
    expect(container.querySelector(".pdf-load-error-overlay")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".pdf-load-error-overlay button")!.click());
    expect(state.evict).toHaveBeenCalledWith("/two.pdf", "full");
    await loaded(2); await painted(2);
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/two.pdf");
    expect(container.querySelector(".pdf-load-error-overlay")).toBeNull();
  });

  it("replaces the initial loading state with a retry action when viewer initialization fails", async () => {
    await render(); await loaded(0);
    await act(async () => state.sessions[0].callbacks.onError());
    expect(container.querySelector(".pdf-loading")).toBeNull();
    expect(container.textContent).toContain("editor.pdfLoadFailed");
    expect(state.sessions[0].destroy).toHaveBeenCalledOnce();
    expect(state.leases[0].release).toHaveBeenCalledOnce();
    expect(current.onDisplayedUrlChange).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>(".pdf-initial-state button")!.click());
    expect(state.evict).toHaveBeenCalledWith("/one.pdf", "full");
    expect(container.querySelector(".pdf-loading")).not.toBeNull();
    await loaded(1); await painted(1);
    expect(container.querySelector(".pdf-initial-state")).toBeNull();
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/one.pdf");
  });

  it("ignores a stale initialization error after switching to a replacement document", async () => {
    await render(); await loaded(0);
    await render({ url: "/two.pdf" }); await loaded(1); await painted(1);
    await act(async () => state.sessions[0].callbacks.onError());
    expect(container.textContent).not.toContain("editor.pdfLoadFailed");
    expect(container.querySelector(".pdf-loading-overlay")).toBeNull();
    expect(state.sessions[1].destroy).not.toHaveBeenCalled();
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/two.pdf");
  });

  it("ignores stale downloads and render completions after a fast document switch", async () => {
    await render(); await loaded(0);
    await render({ url: "/two.pdf" });
    expect(state.sessions[0].destroy).toHaveBeenCalledOnce();
    await painted(0);
    expect(current.onDisplayedUrlChange).not.toHaveBeenCalled();
    await render({ url: "/three.pdf" }); await loaded(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.leases[1].release).toHaveBeenCalledOnce();
    await loaded(2); await painted(1);
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("/three.pdf");
  });

  it("rejects old-document coordinates while a new PDF is loading", async () => {
    await render(); await loaded(0); await painted(0);
    state.sessions[0].callbacks.onDoubleClick({ page: 1, x: 2, y: 3 });
    expect(current.onDoubleClickLocation).toHaveBeenCalledOnce();
    current.onDoubleClickLocation.mockClear();
    await render({ url: "/two.pdf" });
    state.sessions[0].callbacks.onDoubleClick({ page: 1, x: 2, y: 3 });
    state.sessions[0].callbacks.onLocation({ page: 1, x: 2, y: 3 });
    expect(current.onDoubleClickLocation).not.toHaveBeenCalled();
    expect(current.onViewportLocation).not.toHaveBeenCalled();
  });

  it("does not refetch on translation/callback changes and passes zoom to both viewers", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ onDisplayedUrlChange: vi.fn() });
    expect(state.leases).toHaveLength(1);
    await render({ url: "/two.pdf" }); await loaded(1);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="editor.pdfZoomIn"]')!.click());
    for (const session of state.sessions) expect(session.setZoom).toHaveBeenLastCalledWith(110, null);
    await chooseZoom("editor.pdfFitWidth");
    for (const session of state.sessions) expect(session.setZoom).toHaveBeenLastCalledWith(100, "width");
  });

  it("uses the latest jump target when loading finishes and forwards subsequent target changes", async () => {
    await render();
    const target = { page: 8, x: 20, y: 40, nonce: 1 };
    await render({ target }); await loaded(0);
    expect(state.sessions[0].options.target).toEqual(target);
    await painted(0);
    await render({ target: { ...target, nonce: 2 } });
    expect(state.sessions[0].showTarget).toHaveBeenLastCalledWith({ ...target, nonce: 2 });
    await render({ target: null });
    expect(state.sessions[0].showTarget).toHaveBeenLastCalledWith(null);
    expect(state.leases).toHaveLength(1);
  });

  it("carries pinch zoom from the visible PDF into its pending replacement without refetching or accepting stale zoom", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ url: "/two.pdf" });
    await act(async () => state.sessions[0].callbacks.onZoom(123.4));
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("123%");
    await loaded(1);
    expect(state.sessions[1].options.zoom).toBe(123.4);
    await act(async () => state.sessions[1].callbacks.onZoom(180));
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("123%");
    await act(async () => state.sessions[0].callbacks.onZoom(145));
    expect(state.sessions[1].setZoom).toHaveBeenLastCalledWith(145, null);
    await painted(1);
    await act(async () => state.sessions[0].callbacks.onZoom(70));
    expect(container.querySelector(".pdf-zoom-value")?.textContent).toBe("145%");
    expect(state.leases).toHaveLength(2);
  });

  it("releases pending/displayed resources on unmount and ignores late responses", async () => {
    await render(); await loaded(0); await painted(0);
    await render({ url: "/two.pdf" });
    await act(async () => root.unmount());
    expect(state.sessions[0].destroy).toHaveBeenCalledOnce();
    for (const lease of state.leases) expect(lease.release).toHaveBeenCalledOnce();
    expect(current.onDisplayedUrlChange).toHaveBeenLastCalledWith("");
    await loaded(1);
    expect(state.sessions).toHaveLength(1);
  });

  it("keeps only the surviving StrictMode request alive", async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(PdfPreview, current))));
    expect(state.leases).toHaveLength(2);
    expect(state.leases[0].release).toHaveBeenCalledOnce();
    await loaded(0); expect(state.sessions).toHaveLength(0);
    await loaded(1); await painted(0);
    expect(state.sessions).toHaveLength(1);
    expect(state.leases[1].release).not.toHaveBeenCalled();
  });
});
