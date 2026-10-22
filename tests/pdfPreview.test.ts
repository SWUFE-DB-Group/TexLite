// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  leases: [] as { url: string; release: ReturnType<typeof vi.fn>; resolve: (value: object) => void; reject: (error: Error) => void }[],
  sessions: [] as { callbacks: Record<string, Function>; options: Record<string, unknown>; show: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setZoom: ReturnType<typeof vi.fn>; showTarget: ReturnType<typeof vi.fn>; location: ReturnType<typeof vi.fn>; fitWidth: ReturnType<typeof vi.fn> }[],
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
  PdfViewerSession: class {
    show = vi.fn(); destroy = vi.fn(); setZoom = vi.fn(); showTarget = vi.fn(); fitWidth = vi.fn();
    location = vi.fn(() => ({ page: 3, x: 10, y: 20 }));
    constructor(_host: unknown, _document: unknown, public callbacks: Record<string, Function>, public options: Record<string, unknown>) {
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.leases.length = state.sessions.length = 0;
  state.evict.mockClear();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); current = props();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("PDFViewer document replacement", () => {
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
    for (const session of state.sessions) expect(session.setZoom).toHaveBeenLastCalledWith(110);
    await act(async () => container.querySelector<HTMLButtonElement>(".pdf-fit-width")!.click());
    for (const session of state.sessions) expect(session.fitWidth).toHaveBeenCalledOnce();
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
