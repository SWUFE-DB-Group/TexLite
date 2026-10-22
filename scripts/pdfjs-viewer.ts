import type { Plugin } from "vite";

const selectionSignal = "const signal = globalAbortSignal ? AbortSignal.any([this.#selectionChangeAC.signal, globalAbortSignal]) : this.#selectionChangeAC.signal;";

/** PDF.js 6.2 ties its shared text-selection listeners to the first viewer. */
export function fixPdfjsSelectionLifetime(source: string): string {
  if (source.split(selectionSignal).length !== 2) {
    throw new Error("PDF.js text-selection code changed. Review the TexLite viewer compatibility fix before upgrading PDF.js.");
  }
  // TextLayerBuilder.cancel() unregisters each layer and aborts this controller
  // when the last layer disappears. An individual viewer must not abort it
  // while a replacement viewer still has registered text layers.
  return source.replace(selectionSignal, "const signal = this.#selectionChangeAC.signal;");
}

export function pdfjsViewerCompatibility(): Plugin {
  return {
    name: "texlite-pdfjs-viewer-compatibility",
    enforce: "pre",
    transform(source, id) {
      if (!/[\\/]pdfjs-dist[\\/]web[\\/]pdf_viewer\.mjs(?:\?|$)/.test(id)) return;
      return { code: fixPdfjsSelectionLifetime(source), map: null };
    }
  };
}
