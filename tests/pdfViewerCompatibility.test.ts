// @vitest-environment happy-dom
import fs from "node:fs";
import { createRequire } from "node:module";
import type { TextLayerBuilder } from "pdfjs-dist/types/web/text_layer_builder";
import { describe, expect, it, vi } from "vitest";
import { fixPdfjsSelectionLifetime } from "../scripts/pdfjs-viewer";

const source = fs.readFileSync(createRequire(import.meta.url).resolve("pdfjs-dist/web/pdf_viewer.mjs"), "utf8");

/** Exercise the installed library's real text-layer lifecycle without a canvas. */
function textLayerConstructor(source: string): typeof TextLayerBuilder {
  const start = source.indexOf("class TextLayerBuilder {");
  const end = source.indexOf(";// ./web/xfa_layer_builder.js", start);
  if (start < 0 || end < 0) throw new Error("PDF.js text-layer layout changed; update the compatibility test.");
  class TextLayer {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    cancel() {}
    async render() {}
  }
  // Only the canvas/text measurement engine is substituted. All registration,
  // cancellation, selection and pointer handling below comes from PDF.js.
  return new Function("TextLayer", "normalizeUnicode", "removeNullCharacters", "stopEvent",
    `return ${source.slice(start, end)}`)(TextLayer, (text: string) => text,
    (text: string) => text, (event: Event) => event.stopPropagation()) as typeof TextLayerBuilder;
}

describe("PDF.js shared text-selection compatibility", () => {
  it("keeps selection reset working when the first viewer is destroyed while another has rendered text", async () => {
    for (const [input, expectedStuck] of [[source, true], [fixPdfjsSelectionLifetime(source), false]] as const) {
      const Builder = textLayerConstructor(input);
      const firstAbort = new AbortController(), secondAbort = new AbortController();
      const pdfPage = { streamTextContent: () => null } as unknown as TextLayerBuilder["pdfPage"];
      const first = new Builder({ pdfPage, abortSignal: firstAbort.signal });
      const second = new Builder({ pdfPage, abortSignal: secondAbort.signal });
      const options = { viewport: {}, images: null } as unknown as Parameters<TextLayerBuilder["render"]>[0];
      const listeners = vi.spyOn(document, "addEventListener");
      try {
        await first.render(options); await second.render(options);
        const pointerOptions = listeners.mock.calls.find(([name]) => name === "pointerup")?.[2] as AddEventListenerOptions;
        const signal = pointerOptions.signal!;
        // Match the real session's teardown order.
        firstAbort.abort(); first.cancel();
        second.div.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(second.div.classList.contains("selecting")).toBe(true);
        document.dispatchEvent(new Event("pointerup"));
        expect(second.div.classList.contains("selecting")).toBe(expectedStuck);
        if (!expectedStuck) expect(signal.aborted).toBe(false);
        second.cancel();
        expect(signal.aborted).toBe(true);
      } finally {
        first.cancel(); second.cancel(); firstAbort.abort(); secondAbort.abort(); listeners.mockRestore();
      }
    }
  });

  it("fails explicitly when an upgrade changes the upstream code instead of silently dropping the fix", () => {
    expect(() => fixPdfjsSelectionLifetime("unrecognized viewer source")).toThrow("Review the TexLite viewer compatibility fix");
    expect(() => fixPdfjsSelectionLifetime(source + source)).toThrow("Review the TexLite viewer compatibility fix");
  });
});
