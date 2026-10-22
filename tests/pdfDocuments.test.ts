// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getDocument: vi.fn(), tasks: [] as { promise: Promise<object>; destroy: ReturnType<typeof vi.fn> }[] }));
vi.mock("pdfjs-dist", () => ({
  getDocument: state.getDocument, GlobalWorkerOptions: {}, version: "test-version",
  PDFWorker: class { promise = Promise.resolve(); }
}));

beforeEach(() => {
  vi.resetModules(); state.tasks.length = 0;
  state.getDocument.mockReset().mockImplementation(() => {
    const task = { promise: Promise.resolve({}), destroy: vi.fn() };
    state.tasks.push(task); return task;
  });
});

describe("shared PDF document leases", () => {
  it("shares preload and viewer requests without destroying the shared worker/document on ordinary release", async () => {
    const { preloadPdf, acquirePdfDocument } = await import("../src/client/pdfDocuments");
    preloadPdf("/one.pdf", "full");
    const first = acquirePdfDocument("/one.pdf", "full"), second = acquirePdfDocument("/one.pdf", "full");
    await first.promise;
    expect(first.promise).toBe(second.promise); expect(state.getDocument).toHaveBeenCalledOnce();
    first.release(); first.release(); second.release();
    expect(state.tasks[0].destroy).not.toHaveBeenCalled();
  });

  it("keeps an evicted document alive until every viewer lease has released it", async () => {
    const { acquirePdfDocument, evictPdfDocument } = await import("../src/client/pdfDocuments");
    const first = acquirePdfDocument("/one.pdf", "full"), second = acquirePdfDocument("/one.pdf", "full");
    await first.promise;
    evictPdfDocument("/one.pdf", "full");
    first.release(); first.release(); expect(state.tasks[0].destroy).not.toHaveBeenCalled();
    second.release(); second.release(); expect(state.tasks[0].destroy).toHaveBeenCalledOnce();
  });

  it("prunes unused documents above the cache budget without destroying active viewers", async () => {
    const { acquirePdfDocument } = await import("../src/client/pdfDocuments");
    const leases = ["/one.pdf", "/two.pdf", "/three.pdf"].map(url => acquirePdfDocument(url, "full"));
    await Promise.all(leases.map(lease => lease.promise));
    for (const task of state.tasks) expect(task.destroy).not.toHaveBeenCalled();
    leases[0].release(); expect(state.tasks[0].destroy).toHaveBeenCalledOnce();
    expect(state.tasks[1].destroy).not.toHaveBeenCalled(); expect(state.tasks[2].destroy).not.toHaveBeenCalled();
    leases[1].release(); leases[2].release();
  });

  it("separates full and range tasks and allows retry after rejection", async () => {
    const { acquirePdfDocument } = await import("../src/client/pdfDocuments");
    const full = acquirePdfDocument("/one.pdf", "full"), range = acquirePdfDocument("/one.pdf", "range");
    expect(full.promise).not.toBe(range.promise);
    expect(state.getDocument).toHaveBeenNthCalledWith(1, expect.objectContaining({ disableRange: true }));
    expect(state.getDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({ disableRange: false }));
    state.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("Network unavailable")), destroy: vi.fn() }));
    const failed = acquirePdfDocument("/failed.pdf", "full");
    await expect(failed.promise).rejects.toThrow("Network unavailable"); failed.release();
    await acquirePdfDocument("/failed.pdf", "full").promise;
    expect(state.getDocument).toHaveBeenCalledTimes(4);
    full.release(); range.release();
  });
});
