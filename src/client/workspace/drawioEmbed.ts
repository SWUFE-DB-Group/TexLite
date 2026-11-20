import { DEFAULT_DRAWIO_EDITOR_URL, parseDrawioEditorUrl } from "../../shared/drawio";

// Both iframe entry points may need a cold download of the editor's assets.
export const drawioFrameLoadTimeoutMs = 30_000;

/** draw.io needs allow-scripts and allow-same-origin. Never embed it on TexLite's own origin. */
export function resolveDrawioEditorUrl(value = DEFAULT_DRAWIO_EDITOR_URL): URL | null {
  const url = parseDrawioEditorUrl(value);
  return !url || url.origin === window.location.origin
    || (window.location.protocol === "https:" && url.protocol !== "https:") ? null : url;
}

export function drawioEmbedUrl(editorUrl: URL, options: Record<string, string>): string {
  const url = new URL(editorUrl);
  url.search = new URLSearchParams({ embed: "1", proto: "json", configure: "1",
    noSaveBtn: "1", noExitBtn: "1", stealth: "1", plugins: "0", ...options }).toString();
  return url.href;
}
