import { DRAWIO_ORIGIN } from "../../shared/drawio";

/** The native JSON export includes lossless XML of the selection, not a
 * manually reconstructed graph. Empty selections must never become full pages. */
export function hasDrawioSelection(value: unknown): boolean {
  const data = value as { pages?: Array<{ cells?: unknown[] }> } | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.pages) || data.pages.length !== 1
    || !Array.isArray(data.pages[0]?.cells)) throw new Error("DRAWIO_INVALID");
  return data.pages[0].cells.length > 0;
}

export function selectedDrawioXml(value: unknown): string | null {
  if (!hasDrawioSelection(value)) return null;
  const data = value as { data?: unknown };
  if (typeof data.data !== "string" || data.data.length > 5 * 1024 * 1024
    || !/^\s*<mxGraphModel(?:\s|>)/.test(data.data) || /<!DOCTYPE/i.test(data.data)) throw new Error("DRAWIO_INVALID");
  return data.data;
}

/** Render a selection in a disposable, noninteractive editor. Loading selection
 * XML into the live editor would replace its document and undo history. */
export function renderDrawioSelection(xml: string, margin: number, lang: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "drawio-export-frame";
    frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
    frame.inert = true;
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    let settled = false, loaded = false;
    const post = (message: object) => frame.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN);
    const finish = (error?: Error, svg?: string) => {
      if (settled) return;
      settled = true; window.clearTimeout(timer);
      window.removeEventListener("message", receive); signal.removeEventListener("abort", abort);
      frame.remove();
      if (error) reject(error); else resolve(svg!);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const receive = (event: MessageEvent) => {
      if (event.origin !== DRAWIO_ORIGIN || event.source !== frame.contentWindow || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (message.event === "configure") post({ action: "configure", config: { suppressNewWindows: true, enableAi: false } });
      else if (message.event === "init") post({ action: "load", xml, autosave: 0, readOnly: true });
      else if (message.event === "load" && !loaded) {
        if (message.error) { finish(new Error("DRAWIO_INVALID")); return; }
        loaded = true;
        post({ action: "export", format: "svg", requestId: 1, allPages: false, border: margin,
          scale: 1, embedImages: true, embedFonts: true, background: "#ffffff", theme: "light" });
      } else if (loaded && message.event === "export" && message.format === "svg"
        && (message.message as { requestId?: unknown } | undefined)?.requestId === 1) {
        if (message.error || typeof message.data !== "string" || message.data.length > 15 * 1024 * 1024) finish(new Error("DRAWIO_INVALID"));
        else finish(undefined, message.data);
      }
    };
    const timer = window.setTimeout(() => finish(new Error("DRAWIO_EXPORT_FAILED")), 30_000);
    window.addEventListener("message", receive); signal.addEventListener("abort", abort, { once: true });
    frame.onerror = () => finish(new Error("DRAWIO_EXPORT_FAILED"));
    frame.src = `${DRAWIO_ORIGIN}/?${new URLSearchParams({ embed: "1", proto: "json", configure: "1", ui: "min",
      noSaveBtn: "1", noExitBtn: "1", stealth: "1", plugins: "0", lang })}`;
    document.body.append(frame);
    if (signal.aborted) abort();
  });
}
