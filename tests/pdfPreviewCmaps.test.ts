// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  getDocument,
  GlobalWorkerOptions: {},
  PDFWorker: class { promise = Promise.resolve(); },
  version: "test-version"
}));

describe("PDF preview CMap configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    getDocument.mockReset().mockImplementation(() => ({
      promise: Promise.resolve({ destroy: async () => undefined }),
      destroy: async () => undefined
    }));
  });
  afterEach(() => { document.querySelector('meta[name="texlite-base-path"]')?.remove(); });

  it.each([
    ["/", "full"], ["/tools/texlite", "full"], ["/", "range"], ["/tools/texlite", "range"]
  ] as const)("uses same-origin versioned CMaps below base %s with %s loading", async (base, mode) => {
    const meta = document.createElement("meta");
    meta.name = "texlite-base-path";
    meta.content = base;
    document.head.append(meta);
    const { preloadPdf } = await import("../src/client/pdfDocuments");
    preloadPdf("/example.pdf", mode);
    const prefix = base === "/" ? "" : base;
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      cMapUrl: `${window.location.origin}${prefix}/assets/pdfjs-test-version/cmaps/`,
      cMapPacked: true,
      disableRange: mode === "full"
    }));
  });
});
