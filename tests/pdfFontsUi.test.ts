// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfFontsPanel } from "../src/client/workspace/PdfFontsPanel";
import { api, ApiError } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { PdfFont, PdfFontsResponse } from "../src/shared/pdfFonts";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
const run = "01234567-0123-4123-8123-0123456789ab";
const font: PdfFont = { name: "ABC+Example", type: "CID TrueType", encoding: "Identity-H", embedded: true, subset: true, unicode: false };
const response = (fonts = [font], mainFile = "main.tex", runId = run): PdfFontsResponse => ({ mainFile, runId, fonts, hasWarnings: false });
let root: Root, host: HTMLDivElement;
const render = (mainFile = "main.tex", runId = run, projectId = "project") => act(async () => root.render(createElement(PdfFontsPanel, {
  key: `${projectId}:${mainFile}:${runId}`, projectId, mainFile,
  pdfUrl: runId ? `/api/projects/${projectId}/pdf?mainFile=${encodeURIComponent(mainFile)}&run=${runId}` : ""
})));
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  vi.mocked(api).mockReset().mockResolvedValue(response());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("PDF font diagnostics UI", () => {
  it("does not request analysis without a PDF", async () => {
    await render("main.tex", "");
    expect(api).not.toHaveBeenCalled();
    expect(host.textContent).toContain(i18n.t("editor.pdfFonts.noPdf"));
  });

  it("shows font facts, flags actionable findings and keeps the help open until toggled again", async () => {
    vi.mocked(api).mockResolvedValue(response([
      { ...font, name: "<b>CJK font</b>" },
      { ...font, name: "Bitmap", type: "Type 3" },
      { ...font, name: "Helvetica", type: "Type 1", embedded: false }
    ]));
    await render();
    expect(String(vi.mocked(api).mock.calls[0][0])).toBe(`/api/projects/project/compile/fonts?mainFile=main.tex&run=${run}`);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(host.querySelector("tbody b")).toBeNull();
    expect(host.textContent).toContain("<b>CJK font</b>");
    expect(host.textContent).toContain(i18n.t("editor.pdfFonts.type3Count", { count: 1 }));
    expect(host.textContent).toContain(i18n.t("editor.pdfFonts.notEmbeddedCount", { count: 1 }));
    const help = host.querySelector<HTMLButtonElement>(".info-popover-trigger")!;
    await act(async () => help.click());
    expect(document.querySelector(".info-popover-content")?.textContent).toContain(i18n.t("editor.pdfFonts.helpUnicode"));
    await act(async () => help.dispatchEvent(new Event("pointerout", { bubbles: true })));
    expect(document.querySelector(".info-popover-content")).not.toBeNull();
    await act(async () => help.click());
    expect(document.querySelector(".info-popover-content")).toBeNull();
  });

  it("shows missing-tool feedback, permits retry, and does not call a font-free PDF a passed check", async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(i18n.t("errors.codes.PDF_FONTS_UNAVAILABLE"), 503, "PDF_FONTS_UNAVAILABLE"));
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("pdffonts");
    expect(host.querySelector("table")).toBeNull();
    vi.mocked(api).mockResolvedValue({ ...response([]), hasWarnings: true });
    await act(async () => host.querySelector<HTMLButtonElement>(".pdf-fonts-refresh")!.click());
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(i18n.t("editor.pdfFonts.noFonts"));
    expect(host.textContent).toContain(i18n.t("editor.pdfFonts.partial"));
  });

  it("aborts a previous PDF's request and rejects late results after project, root or run changes", async () => {
    const pending: Array<{ resolve: (value: PdfFontsResponse) => void; signal: AbortSignal }> = [];
    vi.mocked(api).mockImplementation((_url, options) => new Promise((resolve) => pending.push({ resolve: resolve as (value: PdfFontsResponse) => void, signal: options!.signal! })));
    await render();
    await render("sub/main.tex");
    expect(pending[0].signal.aborted).toBe(true);
    await render("sub/main.tex", "new-run", "other-project");
    expect(pending[1].signal.aborted).toBe(true);
    await act(async () => pending[2].resolve(response([{ ...font, name: "Current" }], "sub/main.tex", "new-run")));
    await act(async () => { pending[0].resolve(response([{ ...font, name: "Obsolete" }])); pending[1].resolve(response([{ ...font, name: "Old root" }])); });
    expect(host.textContent).toContain("Current");
    expect(host.textContent).not.toMatch(/Obsolete|Old root/);
    await act(async () => root.render(null));
    expect(pending[2].signal.aborted).toBe(true);
  });

  it("reuses diagnostics for source PDFs and cancels inspection when closed", async () => {
    let finish!: (value: PdfFontsResponse) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const filePath = "figures/字体 & figure.PDF";
    await act(async () => root.render(createElement(PdfFontsPanel, { projectId: "project", filePath })));
    expect(vi.mocked(api).mock.calls[0][0]).toBe(`/api/projects/project/file/fonts?path=${encodeURIComponent(filePath).replaceAll("%20", "+")}`);
    expect(host.textContent).toContain(filePath);
    const signal = vi.mocked(api).mock.calls[0][1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(response([{ ...font, name: "Late result" }])));
    expect(host.textContent).not.toContain("Late result");
  });
});
