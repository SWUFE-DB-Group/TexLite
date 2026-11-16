import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { FileDown, LoaderCircle, RefreshCw, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, isAbortError } from "../api";
import { errorMessage } from "../errors";
import { ConfirmDialog } from "../Dialog";
import { SaveButton } from "../SaveButton";
import { InfoPopover } from "../InfoPopover";
import { currentTheme } from "../theme";
import { drawioPdfPath, type DrawioDocument } from "../../shared/drawio";

export const DRAWIO_ORIGIN = "https://embed.diagrams.net";
const maxXmlLength = 5 * 1024 * 1024;

/** Decode only an SVG data URI, never a URL supplied by an embedded page. */
export function decodeDrawioSvg(value: unknown): string {
  if (typeof value !== "string" || value.length > 15 * 1024 * 1024) throw new Error("DRAWIO_INVALID");
  const match = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,(.*)$/is.exec(value);
  if (!match) throw new Error("DRAWIO_INVALID");
  return match[1] ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0)))
    : decodeURIComponent(match[2]);
}

type Request = { id: number; kind: "save" | "pdf" | "close"; timer: number; change: number };

export interface DrawioEditorHandle { confirmClose: () => Promise<boolean> }

export default function DrawioEditor({ projectId, path, readOnly, onClose, onChanged, ref }: {
  projectId: string; path: string; readOnly: boolean; onClose: () => void; onChanged: () => void; ref?: Ref<DrawioEditorHandle>;
}) {
  const { t, i18n } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const saved = useRef<DrawioDocument | null>(null);
  const currentXml = useRef("");
  const initialized = useRef(false);
  const readyRef = useRef(false);
  const pending = useRef<Request | null>(null);
  const sequence = useRef(0);
  const changes = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const closeDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Request["kind"] | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<"save" | "pdf" | null>(null);
  const [discard, setDiscard] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const post = (message: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN);
  const load = () => {
    if (initialized.current && saved.current) post({ action: "load", xml: saved.current.content, title: path,
      autosave: readOnly ? 0 : 1, readOnly, saveAndExit: "0", noSaveBtn: "1", noExitBtn: "1" });
  };
  const finish = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    if (mounted.current) setBusy(null);
  };
  const settleClose = (confirmed: boolean) => {
    const resolve = closeDecision.current; closeDecision.current = null; resolve?.(confirmed);
  };
  const confirmClose = (): Promise<boolean> => {
    if (pending.current || closeDecision.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      closeDecision.current = resolve;
      if (dirty) setDiscard(true);
      else if (ready && !readOnly) start("close"); // Include edits not yet reported by the iframe's autosave debounce.
      else settleClose(true);
    });
  };
  useImperativeHandle(ref, () => ({ confirmClose }));

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    saved.current = null; initialized.current = false; readyRef.current = false;
    setReady(false); setLoadingFailed(false); setError("");
    const timeout = window.setTimeout(() => { if (!readyRef.current) setLoadingFailed(true); }, 30_000);
    void api<DrawioDocument>(`/api/projects/${projectId}/drawio?${new URLSearchParams({ path })}`, { signal: abort.signal })
      .then((document) => {
        if (abort.signal.aborted) return;
        saved.current = document; currentXml.current = document.content; load();
      }).catch((error) => { if (!abort.signal.aborted && !isAbortError(error)) { setError(errorMessage(error)); setLoadingFailed(true); } });
    return () => {
      mounted.current = false; abort.abort(); controller.current?.abort();
      window.clearTimeout(timeout); finish(); settleClose(false);
    };
    // The parent keys this component by project/path. Retry replaces the iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, retry]);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.origin !== DRAWIO_ORIGIN || event.source !== frame.current?.contentWindow || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (message.event === "configure") {
        post({ action: "configure", config: { suppressNewWindows: true, enableAi: false, settingsName: "texlite", autosaveDelay: 100,
          defaultVertexStyle: { html: "0", fontFamily: "Arial" },
          defaultEdgeStyle: { html: "0", fontFamily: "Arial", edgeStyle: "orthogonalEdgeStyle", rounded: "0", jettySize: "auto", orthogonalLoop: "1", defaultLabelBackgroundColor: "page" },
          defaultTextStyle: "text;html=0;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;rounded=0;" } });
        return;
      }
      if (message.event === "init") { initialized.current = true; load(); return; }
      if (message.event === "load") {
        if (message.error) { setError(t("errors.codes.DRAWIO_INVALID")); return; }
        readyRef.current = true; setReady(true); setLoadingFailed(false); return;
      }
      if (message.event === "autosave" && !readOnly && typeof message.xml === "string" && message.xml.length <= maxXmlLength) {
        changes.current += 1;
        currentXml.current = message.xml;
        setDirty(message.xml !== saved.current?.content); setFeedback(null); return;
      }
      if (message.event === "save" && !readOnly && !pending.current) { start("save"); return; }
      const request = pending.current;
      const echoed = message.message as { requestId?: unknown } | undefined;
      if (!request || controller.current || message.event !== "export" || echoed?.requestId !== request.id || !saved.current || readOnly) return;
      if ((request.kind === "pdf" ? message.format !== "svg" : message.format !== "xml")) return;
      window.clearTimeout(request.timer);
      const abort = new AbortController(); controller.current = abort;
      try {
        if (message.error || typeof message.xml !== "string" || message.xml.length > maxXmlLength) throw new Error(t("errors.codes.DRAWIO_INVALID"));
        const xml = message.xml;
        if (changes.current === request.change) currentXml.current = xml;
        if (request.kind === "close") {
          if (xml !== saved.current.content || currentXml.current !== saved.current.content) { setDirty(true); setDiscard(true); }
          else settleClose(true);
          return;
        }
        const result = await api<{ revision: string }>(`/api/projects/${projectId}/drawio`, {
          method: "PUT", signal: abort.signal, body: JSON.stringify({ path, content: xml, revision: saved.current.revision })
        });
        if (abort.signal.aborted || !mounted.current) return;
        saved.current = { ...saved.current, content: xml, revision: result.revision };
        // Do not clear changes made while the HTTP save was in flight.
        setDirty(currentXml.current !== xml);
        onChanged();
        post({ action: "status", message: t("drawio.saved"), modified: currentXml.current !== xml });
        if (request.kind === "pdf") {
          const svg = decodeDrawioSvg(message.data);
          const result = await api<{ path: string; pdfRevision: string }>(`/api/projects/${projectId}/drawio/pdf`, {
            method: "POST", signal: abort.signal, body: JSON.stringify({ path, svg, revision: saved.current.revision, pdfRevision: saved.current.pdfRevision })
          });
          if (abort.signal.aborted || !mounted.current) return;
          saved.current.pdfRevision = result.pdfRevision;
          onChanged();
        }
        setFeedback(request.kind);
      } catch (error) {
        if (request.kind === "close") settleClose(false);
        if (!abort.signal.aborted && mounted.current) setError(error instanceof Error && error.message === "DRAWIO_INVALID" ? t("errors.codes.DRAWIO_INVALID") : errorMessage(error));
      } finally { if (controller.current === abort) { controller.current = null; finish(); } }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });

  const start = (kind: Request["kind"]) => {
    if (pending.current || !ready || !saved.current || readOnly) return;
    const id = ++sequence.current;
    setError(""); setFeedback(null); setBusy(kind);
    const timer = window.setTimeout(() => { finish(); settleClose(false); setError(t("errors.codes.DRAWIO_EXPORT_FAILED")); }, 30_000);
    pending.current = { id, kind, timer, change: changes.current };
    post({ action: "export", format: kind === "pdf" ? "svg" : "xml", requestId: id,
      currentPage: true, embedImages: true, embedFonts: true, border: 4, background: "#ffffff", theme: "light" });
  };
  const lang = useRef(i18n.resolvedLanguage === "zh-Hant" ? "zh-tw" : i18n.resolvedLanguage === "zh" ? "zh" : "en").current;
  const appearance = useRef({ ui: window.innerWidth <= 600 ? "simple" : currentTheme() === "dark" ? "dark" : "kennedy",
    dark: currentTheme() === "dark" ? "1" : "0", sidebar: window.innerWidth > 600 && !readOnly ? "1" : "0" }).current;
  const url = `${DRAWIO_ORIGIN}/?${new URLSearchParams({ embed: "1", proto: "json", configure: "1", spin: "1",
    libraries: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", stealth: "1", plugins: "0", ...appearance, lang })}`;

  return <>
    <section className="drawio-editor" aria-label={path}>
      <div className="drawio-toolbar">
        <span className="drawio-file-name"><Workflow size={14} aria-hidden /><span>{path}</span></span>
        <span className="drawio-status" role="status">{readOnly ? t("drawio.readOnly") : dirty ? t("drawio.dirty") : ready ? t("drawio.saved") : t("drawio.loading")}</span>
        <InfoPopover content={t("drawio.help")} />
        {!readOnly && <div className="drawio-actions">
          <SaveButton saving={busy === "save"} disabled={!ready || !dirty || Boolean(busy)} feedback={feedback === "save" ? t("drawio.saved") : ""} onClick={() => start("save")}>{t("common.save")}</SaveButton>
          <SaveButton saving={busy === "pdf"} disabled={!ready || Boolean(busy)} icon={<FileDown size={14} aria-hidden />} feedback={feedback === "pdf" ? t("drawio.exported") : ""}
            onClick={() => { if (saved.current?.pdfRevision) setOverwrite(true); else start("pdf"); }}>{t("drawio.export")}</SaveButton>
          {busy && <button type="button" onClick={() => { const active = controller.current; controller.current = null; active?.abort(); finish(); settleClose(false); }}>{t("common.cancel")}</button>}
        </div>}
        <button type="button" className="drawio-close" aria-label={t("common.close")} title={t("common.close")} onClick={() => { void confirmClose().then((confirmed) => { if (confirmed) onClose(); }); }}><X size={14} aria-hidden /></button>
      </div>
      {error && <p className="error drawio-error" role="alert">{error}</p>}
      <div className="drawio-frame-wrap">
        {!ready && <div className="drawio-loading" role="status">{loadingFailed ? <><span>{t("drawio.unavailable")}</span><button onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />{t("common.retry")}</button></> : <><LoaderCircle size={20} className="spin" /><span>{t("drawio.loading")}</span></>}</div>}
        <iframe key={retry} ref={frame} src={url} title={t("drawio.title")} referrerPolicy="no-referrer"
          onError={() => setLoadingFailed(true)}
          sandbox="allow-scripts allow-same-origin allow-modals" />
      </div>
    </section>
    <ConfirmDialog open={discard} title={t("drawio.discard")} description={t("drawio.discardDescription")} confirmLabel={t("drawio.discardAction")} danger
      onCancel={() => { setDiscard(false); settleClose(false); }} onConfirm={() => { setDiscard(false); settleClose(true); }} />
    <ConfirmDialog open={overwrite} title={t("drawio.overwrite")} description={t("drawio.overwriteDescription", { path: drawioPdfPath(path) })} confirmLabel={t("drawio.overwriteAction")}
      onCancel={() => setOverwrite(false)} onConfirm={() => { setOverwrite(false); start("pdf"); }} />
  </>;
}
