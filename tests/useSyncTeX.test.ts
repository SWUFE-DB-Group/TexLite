// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { canSyncSourceToPdf, useSyncTeX } from "../src/client/workspace/useSyncTeX";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

type HookOptions = Parameters<typeof useSyncTeX>[0];
let current: ReturnType<typeof useSyncTeX>;
let root: Root | null;
let container: HTMLDivElement;
let options: HookOptions;

function Harness(props: HookOptions) {
  current = useSyncTeX(props);
  return null;
}

async function render(overrides: Partial<HookOptions> = {}) {
  options = { ...options, ...overrides };
  await act(async () => { root!.render(createElement(Harness, options)); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  options = {
    projectId: "paper", mainFile: "main.tex", activeFile: "chapters/绪论.TEX",
    onOpenSourceFile: vi.fn(), onError: vi.fn(), onShowPdf: vi.fn(), onShowEditor: vi.fn()
  };
});

afterEach(async () => {
  await act(async () => { root?.unmount(); root = null; });
  container.remove();
  vi.unstubAllGlobals();
});

describe("source to PDF navigation", () => {
  it("enables the root and child TeX sources, but not non-TeX files or a missing root", () => {
    expect(canSyncSourceToPdf("main.tex", "main.tex")).toBe(true);
    expect(canSyncSourceToPdf("chapters/绪论.TEX", "main.tex")).toBe(true);
    expect(canSyncSourceToPdf("chapters/part.tex", "other-root.tex")).toBe(true);
    expect(canSyncSourceToPdf("refs.bib", "main.tex")).toBe(false);
    expect(canSyncSourceToPdf("", "main.tex")).toBe(false);
    expect(canSyncSourceToPdf("chapters/part.tex", "")).toBe(false);
  });

  it("looks up an included source against the selected root without opening another file", async () => {
    vi.mocked(api).mockResolvedValue({ page: 7, x: 97, y: 367 });
    await render();
    await act(async () => { await current.syncSourceToPdf(options.activeFile, 8, 1); });
    expect(api).toHaveBeenCalledWith(
      `/api/projects/paper/sync/pdf?mainFile=main.tex&path=${encodeURIComponent(options.activeFile)}&line=8&column=1`,
      { signal: expect.any(AbortSignal) }
    );
    expect(current.pdfTarget).toMatchObject({ page: 7, x: 97, y: 367 });
    expect(options.onShowPdf).toHaveBeenCalledOnce();
    expect(options.onOpenSourceFile).not.toHaveBeenCalled();
  });

  it("does not request mappings for non-TeX files", async () => {
    await render({ activeFile: "refs.bib" });
    await current.syncSourceToPdf(options.activeFile, 1, 1);
    expect(api).not.toHaveBeenCalled();
  });

  it("leaves the preview unchanged when a source line has no typeset location", async () => {
    vi.mocked(api).mockResolvedValue(null);
    await render();
    await act(async () => { await current.syncSourceToPdf(options.activeFile, 1, 1); });
    expect(current.pdfTarget).toBeNull();
    expect(options.onShowPdf).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("discards a child-file lookup when the selected root changes", async () => {
    let resolve!: (location: { page: number; x: number; y: number }) => void;
    vi.mocked(api).mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    const pending = current.syncSourceToPdf(options.activeFile, 8, 1);
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    await render({ mainFile: "other-root.tex" });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve({ page: 7, x: 97, y: 367 }); await pending; });
    expect(current.pdfTarget).toBeNull();
    expect(options.onShowPdf).not.toHaveBeenCalled();
  });
});

describe("visible PDF to source navigation", () => {
  it("opens the mapped included source and switches views only after a successful lookup", async () => {
    let resolve!: (location: { path: string; line: number; column: number }) => void;
    vi.mocked(api).mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => { current.setPdfViewport({ page: 7, x: 97, y: 367 }); });
    const pending = current.syncVisiblePdfToSource();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/paper/sync/source?mainFile=main.tex&page=7&x=97&y=367",
      { signal: expect.any(AbortSignal) }
    );
    expect(options.onShowEditor).not.toHaveBeenCalled();
    await act(async () => { resolve({ path: "chapters/method.tex", line: 28, column: 4 }); await pending; });
    expect(options.onShowEditor).toHaveBeenCalledOnce();
    expect(options.onOpenSourceFile).toHaveBeenCalledExactlyOnceWith("chapters/method.tex");
    expect(current.sourceJump).toMatchObject({ path: "chapters/method.tex", line: 28, column: 4 });
  });

  it("does not switch views without a visible position or when the request fails", async () => {
    await render();
    await current.syncVisiblePdfToSource();
    expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockRejectedValue(new Error("No source mapping"));
    await act(async () => { current.setPdfViewport({ page: 1, x: 10, y: 20 }); });
    await act(async () => { await current.syncVisiblePdfToSource(); });
    expect(options.onShowEditor).not.toHaveBeenCalled();
    expect(options.onOpenSourceFile).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledOnce();
  });

  it("discards a reverse lookup when the root changes", async () => {
    let resolve!: (location: { path: string; line: number; column: number }) => void;
    vi.mocked(api).mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => { current.setPdfViewport({ page: 2, x: 15, y: 25 }); });
    const pending = current.syncVisiblePdfToSource();
    await render({ mainFile: "other.tex" });
    await act(async () => { resolve({ path: "chapters/old.tex", line: 8, column: 1 }); await pending; });
    expect(options.onShowEditor).not.toHaveBeenCalled();
    expect(current.sourceJump).toBeNull();
  });
});
