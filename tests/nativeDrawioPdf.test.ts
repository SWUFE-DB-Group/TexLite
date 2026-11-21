import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDrawioBrowser } from "../src/server/drawioBrowser.js";
import { DrawioPdfRenderer } from "../src/server/drawioPdf.js";
import { launchOwnedDrawioBrowser } from "../src/server/drawioOwnedBrowser.js";
import { inspectPdfFonts } from "../src/server/pdfFonts.js";

describe.runIf(process.env.TEXLITE_TEST_NATIVE_HOST_TOOLS === "1")("native draw.io PDF export", () => {
  it("exports a diagram with the host browser and reads its fonts with Poppler", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "TexLite PDF 图表 "));
    const renderer = new DrawioPdfRenderer((error) => console.error(error));
    try {
      const pdf = await renderer.render('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><text x="3" y="20" font-family="Arial">TexLite</text></svg>');
      const file = path.join(directory, "diagram.pdf");
      await fs.writeFile(file, pdf);
      const result = await inspectPdfFonts(file);
      expect(result.fonts).toEqual(expect.arrayContaining([expect.objectContaining({ embedded: true })]));
    } finally {
      await renderer.close();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 50_000);

  // Windows already uses this transport in the export above. Verify it
  // against Linux Chrome as well, without changing the POSIX export path.
  it.runIf(process.platform === "linux")("talks to native Chrome over the managed DevTools pipe", async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const { browser, close } = await launchOwnedDrawioBrowser(
      puppeteer, await findDrawioBrowser(), AbortSignal.timeout(15_000)
    );
    try {
      const page = await browser.newPage();
      await page.setContent("<html><body>TexLite</body></html>");
      expect(Buffer.from(await page.pdf()).subarray(0, 5).toString()).toBe("%PDF-");
    } finally { await close(); }
  }, 35_000);
});
