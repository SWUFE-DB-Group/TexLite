import fs from "node:fs";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import { launchOwnedDrawioBrowser } from "./drawioOwnedBrowser.js";
import { HttpError, httpError } from "./http.js";

/** Only Chromium-family browsers share this export backend. No browser is downloaded. */
export function browserCandidates(platform = process.platform, env = process.env): string[] {
  const names = platform === "win32" ? ["chromium.exe", "chrome.exe", "msedge.exe"]
    : ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome", "microsoft-edge-stable", "microsoft-edge", "msedge"];
  const directories = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates = names.flatMap((name) => directories.map((directory) => path.join(directory, name)));
  if (platform === "darwin") candidates.push(
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  if (platform === "win32") {
    for (const directory of [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter((value): value is string => Boolean(value))) {
      candidates.push(path.join(directory, "Chromium", "Application", "chrome.exe"),
        path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  // Keep the requested preference across standard install locations and PATH.
  const rank = (candidate: string) => /chromium/i.test(candidate) ? 0 : /(?:msedge|microsoft.edge)/i.test(candidate) ? 2 : 1;
  return [...new Set(candidates)].sort((left, right) => rank(left) - rank(right));
}

export async function findDrawioBrowser(configured?: string): Promise<string> {
  for (const candidate of configured ? [configured] : browserCandidates()) {
    try {
      await fs.promises.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.promises.stat(candidate)).isFile()) return candidate;
    } catch { /* Missing candidates are optional; launch failures are reported separately. */ }
  }
  throw httpError(503, "DRAWIO_BROWSER_UNAVAILABLE");
}

async function closeBrowser(browser: Browser): Promise<void> {
  const timer = setTimeout(() => { browser.process()?.kill("SIGKILL"); }, 2_000);
  timer.unref();
  try { await browser.close(); } catch { browser.process()?.kill("SIGKILL"); }
  finally { clearTimeout(timer); }
}

/** Per-app lifecycle: bounded host work, cancellation, and server-shutdown cleanup. */
export class DrawioPdfRenderer {
  private readonly jobs = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private detectedBrowser?: { configured: string | undefined; path: string };

  constructor(private readonly reportError?: (error: unknown) => void) {}

  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.jobs) job.abort();
    await Promise.allSettled([...this.pending]);
  }

  render(svg: string, browserPath?: string, signal?: AbortSignal): Promise<Buffer> {
    if (this.closing || this.jobs.size >= 2) return Promise.reject(httpError(503, "DRAWIO_EXPORT_BUSY"));
    const controller = new AbortController();
    this.jobs.add(controller);
    const job = this.renderDocument(svg, browserPath, AbortSignal.any([
      controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])
    ])).finally(() => { this.jobs.delete(controller); this.pending.delete(job); });
    this.pending.add(job);
    return job;
  }

  private async renderDocument(svg: string, configured: string | undefined, signal: AbortSignal): Promise<Buffer> {
    let close: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      const executablePath = this.detectedBrowser && this.detectedBrowser.configured === configured
        ? this.detectedBrowser.path : await findDrawioBrowser(configured);
      this.detectedBrowser = { configured, path: executablePath };
      const { default: puppeteer } = await import("puppeteer-core");
      signal.throwIfAborted();
      let browser: Browser;
      if (process.platform === "win32") {
        ({ browser, close } = await launchOwnedDrawioBrowser(puppeteer, executablePath, signal));
      } else {
        browser = await puppeteer.launch({ executablePath, browser: "chrome", headless: true, pipe: true,
          timeout: 10_000, signal, handleSIGINT: false, handleSIGHUP: false, handleSIGTERM: false });
        close = () => closeBrowser(browser);
      }
      signal.throwIfAborted();
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      // SVG/foreignObject is untrusted. Never run its scripts or allow access
      // to host files, loopback services, or remote resources during export.
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      let blockedResource = false;
      page.on("request", (request) => {
        if (request.url().startsWith("data:")) void request.continue();
        else { blockedResource = true; void request.abort(); }
      });
      await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:white}svg{display:block}*{box-sizing:border-box}</style></head><body></body></html>`);
      const size = await page.evaluate((source) => {
        const documentSvg = new DOMParser().parseFromString(source, "image/svg+xml");
        const svg = documentSvg.documentElement;
        if (documentSvg.querySelector("parsererror") || svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg") return null;
        const node = document.importNode(svg, true) as unknown as SVGSVGElement;
        // Scripts are disabled/CSP-blocked; also remove active containers and
        // navigation so exported PDFs do not inherit executable attachments.
        node.querySelectorAll("script,iframe,object,embed,base,link").forEach((element) => element.remove());
        node.querySelectorAll("a").forEach((link) => { link.removeAttribute("href"); link.removeAttributeNS("http://www.w3.org/1999/xlink", "href"); });
        document.body.append(node);
        const box = node.viewBox.baseVal;
        const width = node.width.baseVal.value || box.width;
        const height = node.height.baseVal.value || box.height;
        if (![width, height].every((value) => Number.isFinite(value) && value >= 1 && value <= 14_000)
          || width * height > 50_000_000) return null;
        node.setAttribute("width", String(width)); node.setAttribute("height", String(height));
        return { width, height };
      }, svg);
      if (!size) throw httpError(400, "DRAWIO_INVALID");
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, async (image) => { if (!image.complete) await image.decode(); }));
        // Draw.io also uses SVG <image>, which is not in document.images.
        await Promise.all(Array.from(document.querySelectorAll("svg image"), async (image) => {
          const href = image.getAttribute("href") ?? image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (!href) return;
          if (!href.startsWith("data:image/")) throw new Error("External image");
          const probe = new Image(); probe.src = href; await probe.decode();
        }));
      });
      if (blockedResource) throw httpError(422, "DRAWIO_EXPORT_FAILED");
      signal.throwIfAborted();
      const bytes = Buffer.from(await page.pdf({ width: `${size.width}px`, height: `${size.height}px`,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true, displayHeaderFooter: false,
        waitForFonts: true, timeout: 10_000 }));
      if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw httpError(422, "DRAWIO_EXPORT_FAILED");
      return bytes;
    } catch (error) {
      this.detectedBrowser = undefined; // Retry detection after installation/removal or a failed launch.
      if (error instanceof AggregateError || (!signal.aborted && !(error instanceof HttpError))) this.reportError?.(error);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (error instanceof HttpError) throw error;
      throw httpError(422, "DRAWIO_EXPORT_FAILED");
    } finally {
      if (close) {
        try { await close(); }
        catch (error) {
          this.reportError?.(error);
          if (!signal.aborted) throw httpError(422, "DRAWIO_EXPORT_FAILED");
        }
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    }
  }
}
