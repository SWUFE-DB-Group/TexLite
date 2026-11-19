import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawioPdfRenderer, browserCandidates, findDrawioBrowser } from "../src/server/drawioPdf";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("puppeteer-core", () => ({ default: { launch } }));
let root: string, binary: string;
const page = {
  setDefaultTimeout: vi.fn(), setJavaScriptEnabled: vi.fn(), setRequestInterception: vi.fn(), on: vi.fn(),
  setContent: vi.fn(), evaluate: vi.fn(), pdf: vi.fn()
};
const browser = { newPage: vi.fn(), close: vi.fn(), process: vi.fn() };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-drawio-browser-")); binary = path.join(root, "browser");
  fs.writeFileSync(binary, "fixture", { mode: 0o700 });
  vi.clearAllMocks();
  launch.mockResolvedValue(browser); browser.newPage.mockResolvedValue(page); browser.close.mockResolvedValue(undefined); browser.process.mockReturnValue(null);
  page.evaluate.mockReset().mockResolvedValueOnce({ width: 100, height: 80 }).mockResolvedValue(undefined);
  page.pdf.mockReset().mockResolvedValue(new Uint8Array(Buffer.from("%PDF-1.4\nfixture")));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

describe("optional host diagram PDF renderer", () => {
  it("prefers Chromium, Chrome, then Edge across standard installs and PATH, and honors an explicit executable", async () => {
    const candidates = browserCandidates("darwin", { PATH: "/usr/bin" });
    expect(candidates.indexOf("/Applications/Chromium.app/Contents/MacOS/Chromium")).toBeLessThan(candidates.indexOf("/usr/bin/google-chrome"));
    expect(candidates.indexOf("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBeLessThan(candidates.indexOf("/usr/bin/msedge"));
    expect(candidates.some((candidate) => /firefox|safari/i.test(candidate))).toBe(false);
    expect(await findDrawioBrowser(binary)).toBe(binary);
    await expect(findDrawioBrowser(path.join(root, "missing"))).rejects.toMatchObject({ statusCode: 503, code: "DRAWIO_BROWSER_UNAVAILABLE" });
  });

  it("uses an isolated headless browser without disabling its sandbox; blocks host/network requests and closes on success", async () => {
    const renderer = new DrawioPdfRenderer();
    const pdf = await renderer.render("<svg/>", binary);
    expect(pdf.toString()).toContain("%PDF-");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: binary, browser: "chrome", headless: true, pipe: true }));
    expect(launch.mock.calls[0][0]).not.toHaveProperty("userDataDir");
    expect(launch.mock.calls[0][0]).not.toHaveProperty("args");
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(page.setContent.mock.calls[0][0]).toContain("default-src 'none'");
    const receive = page.on.mock.calls.find(([event]) => event === "request")![1];
    const abort = vi.fn(), proceed = vi.fn();
    for (const url of ["file:///etc/passwd", "http://127.0.0.1/private", "https://example.test/"]) receive({ url: () => url, abort, continue: proceed });
    expect(abort).toHaveBeenCalledTimes(3); expect(proceed).not.toHaveBeenCalled();
    receive({ url: () => "data:image/png;base64,AA==", abort, continue: proceed }); expect(proceed).toHaveBeenCalledOnce();
    expect(page.pdf).toHaveBeenCalledWith(expect.objectContaining({ width: "100px", height: "80px", printBackground: true, waitForFonts: true }));
    expect(browser.close).toHaveBeenCalledOnce();
    await renderer.close();
  });

  it("does not publish invalid SVG, partial resources, or failed PDFs, and always closes the browser", async () => {
    const renderer = new DrawioPdfRenderer();
    page.evaluate.mockReset().mockResolvedValueOnce(null);
    await expect(renderer.render("<bad/>", binary)).rejects.toMatchObject({ code: "DRAWIO_INVALID" });
    expect(page.pdf).not.toHaveBeenCalled(); expect(browser.close).toHaveBeenCalledOnce();
    page.evaluate.mockReset().mockResolvedValueOnce({ width: 100, height: 80 }).mockResolvedValue(undefined);
    page.pdf.mockResolvedValueOnce(new Uint8Array(Buffer.from("not PDF")));
    await expect(renderer.render("<svg/>", binary)).rejects.toMatchObject({ code: "DRAWIO_EXPORT_FAILED" });
    expect(browser.close).toHaveBeenCalledTimes(2);
    page.evaluate.mockReset().mockResolvedValueOnce({ width: 100, height: 80 }).mockImplementationOnce(async () => {
      const receive = page.on.mock.calls.filter(([event]) => event === "request").at(-1)![1];
      receive({ url: () => "http://127.0.0.1/private", abort: vi.fn(), continue: vi.fn() });
    });
    await expect(renderer.render("<svg/>", binary)).rejects.toMatchObject({ code: "DRAWIO_EXPORT_FAILED" });
    expect(browser.close).toHaveBeenCalledTimes(3);
    await renderer.close();
  });

  it("limits concurrent work, cancels on shutdown, rejects new work, and releases jobs after failure", async () => {
    const renderer = new DrawioPdfRenderer();
    const signals: AbortSignal[] = [];
    launch.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error("Aborted"));
        else signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    });
    const first = renderer.render("<svg/>", binary), second = renderer.render("<svg/>", binary);
    const settled = Promise.allSettled([first, second]);
    await expect(renderer.render("<svg/>", binary)).rejects.toMatchObject({ code: "DRAWIO_EXPORT_BUSY" });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await renderer.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    await expect(renderer.render("<svg/>", binary)).rejects.toMatchObject({ code: "DRAWIO_EXPORT_BUSY" });
  });

  it("does not launch for an already-cancelled request and leaves capacity available", async () => {
    const renderer = new DrawioPdfRenderer();
    const controller = new AbortController(); controller.abort();
    await expect(renderer.render("<svg/>", binary, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(launch).not.toHaveBeenCalled();
    await expect(renderer.render("<svg/>", binary)).resolves.toBeInstanceOf(Buffer);
    await renderer.close();
  });

  it("reports the failing browser stage and original cause without exposing them in the API error", async () => {
    const error = new Error("Print command timed out.");
    page.pdf.mockRejectedValueOnce(error);
    const report = vi.fn();
    const renderer = new DrawioPdfRenderer(report);
    try {
      await expect(renderer.render("<svg/>", binary)).rejects.toMatchObject({ code: "DRAWIO_EXPORT_FAILED", details: {} });
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("PDF printing"), cause: error }));
    } finally { await renderer.close(); }
  });
});
