import { resolveDrawioEditorUrl } from "./drawioEmbed";

let editor: Promise<typeof import("./DrawioEditor")> | null = null;

/** Share the optional chunk between intent preloading and React.lazy. */
export function loadDrawioEditor(): Promise<typeof import("./DrawioEditor")> {
  editor ??= import("./DrawioEditor").catch((error: unknown) => {
    editor = null;
    throw error;
  });
  return editor;
}

/** Warm resources on intent only; never create a frame, connection or lease. */
export function prepareDrawioEditor(editorUrl?: string): void {
  const url = resolveDrawioEditorUrl(editorUrl);
  if (!url) return;
  if (!Array.from(document.head.querySelectorAll('link[rel="preconnect"]')).some((link) => link.getAttribute("href") === url.origin)) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = url.origin;
    document.head.append(link);
  }
  // A speculative failure must not become an unhandled rejection or prevent
  // the user's subsequent attempt from loading the editor normally.
  void loadDrawioEditor().catch(() => {});
}
