import { DRAWIO_ORIGIN } from "../../shared/drawio";

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
export function prepareDrawioEditor(): void {
  if (!document.head.querySelector(`link[rel="preconnect"][href="${DRAWIO_ORIGIN}"]`)) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = DRAWIO_ORIGIN;
    document.head.append(link);
  }
  // A speculative failure must not become an unhandled rejection or prevent
  // the user's subsequent attempt from loading the editor normally.
  void loadDrawioEditor().catch(() => {});
}
