import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Check, LoaderCircle, LockKeyhole, RefreshCw, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, isAbortError } from "../api";
import { errorMessage } from "../errors";
import { ConfirmDialog } from "../Dialog";
import { InfoPopover } from "../InfoPopover";
import { currentTheme } from "../theme";
import { DRAWIO_ORIGIN, drawioPdfPath, type DrawioDocument, type DrawioExportOptions } from "../../shared/drawio";
import { useDrawioLock } from "./useDrawioLock";
import { sameDrawioContent } from "./drawioContent";
import { DrawioExportButton } from "./DrawioExportButton";
import { hasDrawioSelection, renderDrawioSelection, selectedDrawioXml } from "./drawioSelectionExport";

const maxXmlLength = 5 * 1024 * 1024;
const autosaveDelayMs = 1_000;
const saveRequestTimeoutMs = 30_000;

/** Decode only an SVG data URI, never a URL supplied by an embedded page. */
export function decodeDrawioSvg(value: unknown): string {
  if (typeof value !== "string" || value.length > 15 * 1024 * 1024) throw new Error("DRAWIO_INVALID");
  const match = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,(.*)$/is.exec(value);
  if (!match) throw new Error("DRAWIO_INVALID");
  return match[1] ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0)))
    : decodeURIComponent(match[2]);
}

type Request = { id: number; kind: "save" | "pdf" | "close"; timer: number; change: number; lockToken: string;
  options?: DrawioExportOptions; phase?: "selection" | "source"; selectionXml?: string };

export interface DrawioEditorHandle { confirmClose: () => Promise<boolean> }

export default function DrawioEditor({ projectId, path, readOnly, onChanged, ref }: {
  projectId: string; path: string; readOnly: boolean; onChanged: () => void; ref?: Ref<DrawioEditorHandle>;
}) {
  const { t, i18n } = useTranslation();
  const lock = useDrawioLock(projectId, path, readOnly);
  const [approvedToken, setApprovedToken] = useState("");
  const approved = useRef("");
  const canEdit = !readOnly && lock.state.status === "owned" && approvedToken === lock.state.token;
  const frameReadOnly = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const saved = useRef<DrawioDocument | null>(null);
  const currentXml = useRef("");
  const initialized = useRef(false);
  const loadPosted = useRef(false);
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const readyRef = useRef(false);
  const pending = useRef<Request | null>(null);
  const selectionQuery = useRef<{ id: number; finish: (error?: Error, selected?: boolean) => void } | null>(null);
  const sequence = useRef(0);
  const changes = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const closeDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const saveImmediately = useRef(false);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState<Request["kind"] | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [feedback, setFeedback] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [overwrite, setOverwrite] = useState<DrawioExportOptions | null>(null);
  const post = (message: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN);
  const checkSelection = useCallback((signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (!readyRef.current || frameReadOnly.current) return Promise.resolve(false);
    selectionQuery.current?.finish(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const id = ++sequence.current;
      const finish = (error?: Error, selected = false) => {
        if (selectionQuery.current?.id !== id) return;
        selectionQuery.current = null;
        window.clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(selected);
      };
      const abort = () => finish(new DOMException("Aborted", "AbortError"));
      const timer = window.setTimeout(() => finish(new Error("DRAWIO_EXPORT_FAILED")), 10_000);
      selectionQuery.current = { id, finish };
      signal.addEventListener("abort", abort, { once: true });
      // Metadata only: no source save, SVG rendering or host process.
      post({ action: "export", format: "json", requestId: id, selection: true, allPages: false, includeData: false });
      if (signal.aborted) abort();
    });
  }, []);
  const load = () => {
    if (!initialized.current || !saved.current) return;
    const ownership = lock.current.current;
    // Resolve the first lease before loading, rather than bootstrapping a
    // read-only graph only to reload it immediately with editing enabled.
    if (!readOnly && (ownership.status === "connecting" || ownership.status === "owned" && approved.current !== ownership.token)) return;
    // A read-only load may still be in flight when ownership changes. Wait
    // for its acknowledgement before sending the editable replacement.
    if (loadPosted.current && !readyRef.current) return;
    loadPosted.current = true;
    readyRef.current = false; setReady(false);
    frameReadOnly.current = readOnly || lock.current.current.status !== "owned" || approved.current !== lock.current.current.token;
    // TexLite shows the file path above the embed; don't duplicate it in the draw.io menu.
    post({ action: "load", xml: currentXml.current,
      autosave: frameReadOnly.current ? 0 : 1, readOnly: frameReadOnly.current, saveAndExit: "0", noSaveBtn: "1", noExitBtn: "1" });
  };
  const finish = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    if (mounted.current) setBusy(null);
  };
  const settleClose = (confirmed: boolean) => {
    const resolve = closeDecision.current; closeDecision.current = null; resolve?.(confirmed);
    if (mounted.current) setClosing(false);
  };
  const updateDirty = async () => {
    const xml = currentXml.current, document = saved.current, change = changes.current;
    if (!document) return;
    const unchanged = await sameDrawioContent(xml, document.content);
    // XML inflation is asynchronous. An older comparison cannot clear a
    // newer edit or replace the result of a save that finished meanwhile.
    if (!mounted.current || currentXml.current !== xml || saved.current !== document || changes.current !== change) return;
    setDirty(!unchanged);
    if (!unchanged) setFeedback(false);
    return !unchanged;
  };
  const confirmClose = (): Promise<boolean> => {
    if (pending.current?.kind === "pdf" || closeDecision.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      closeDecision.current = resolve;
      setClosing(true);
      if (pending.current) return; // Finish the in-flight save, then flush the latest XML.
      if (saveError || dirty && !canEdit) setDiscard(true);
      else if (readyRef.current && !frameReadOnly.current) start("close");
      else settleClose(true);
    });
  };
  useImperativeHandle(ref, () => ({ confirmClose }));

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    saved.current = null; initialized.current = false; readyRef.current = false; loadPosted.current = false;
    approved.current = ""; setApprovedToken(""); setSourceLoaded(false);
    setReady(false); setLoadingFailed(false); setError("");
    const timeout = window.setTimeout(() => { if (!readyRef.current) setLoadingFailed(true); }, 30_000);
    void api<DrawioDocument>(`/api/projects/${projectId}/drawio?${new URLSearchParams({ path })}`, { signal: abort.signal })
      .then((document) => {
        if (abort.signal.aborted) return;
        saved.current = document; currentXml.current = document.content; setSourceLoaded(true);
      }).catch((error) => { if (!abort.signal.aborted && !isAbortError(error)) { setError(errorMessage(error)); setLoadingFailed(true); } });
    return () => {
      mounted.current = false; abort.abort(); controller.current?.abort();
      controller.current = null; saveImmediately.current = false;
      selectionQuery.current?.finish(new DOMException("Aborted", "AbortError"));
      window.clearTimeout(timeout); finish(); settleClose(false);
    };
    // The parent keys this component by project/path. Retry replaces the iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, retry]);

  useEffect(() => {
    if (lock.state.status !== "owned") { approved.current = ""; setApprovedToken(""); return; }
    if (!sourceLoaded || !saved.current) return;
    const token = lock.state.token, revision = lock.state.revision;
    if (approved.current === token) return;
    const abort = new AbortController();
    const approve = () => { approved.current = token; setApprovedToken(token); };
    if (!revision || revision === saved.current.revision) approve();
    else {
      // A viewer may have been open while the previous owner saved. Refresh
      // that clean viewer, but never replace a disconnected owner's draft.
      void (async () => {
        if (!(await sameDrawioContent(currentXml.current, saved.current!.content))) {
          if (!abort.signal.aborted) setError(t("errors.codes.DRAWIO_CONFLICT"));
          return;
        }
        if (abort.signal.aborted) return;
        const document = await api<DrawioDocument>(`/api/projects/${projectId}/drawio?${new URLSearchParams({ path })}`, { signal: abort.signal });
        if (abort.signal.aborted || lock.current.current.token !== token) return;
        const xml = currentXml.current;
        const clean = await sameDrawioContent(xml, saved.current!.content);
        if (abort.signal.aborted || lock.current.current.token !== token) return;
        if (!clean || currentXml.current !== xml) { setError(t("errors.codes.DRAWIO_CONFLICT")); return; }
        saved.current = document; currentXml.current = document.content; setDirty(false);
        approve();
        if (initialized.current) load();
      })().catch((error) => { if (!abort.signal.aborted && !isAbortError(error)) setError(errorMessage(error)); });
    }
    return () => abort.abort();
  }, [lock.state.status, lock.state.token, lock.state.revision, sourceLoaded, retry]);

  useEffect(() => {
    // Viewers become editable only after ownership is acquired. On lock loss,
    // freeze the existing frame instead of reloading and erasing its draft.
    if (!loadPosted.current || canEdit && readyRef.current && frameReadOnly.current) load();
  }, [canEdit, ready, sourceLoaded, lock.state.status, retry]);

  useEffect(() => {
    if (!dirty && !saveError && busy !== "save" && busy !== "close") return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, saveError, busy]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(false), 2_000);
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
          hideMenuItems: ["exportPdf"],
          passThroughKeys: [{ key: "s", ctrl: true, shift: false, alt: false, command: "save" }],
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
      if (message.event === "autosave" && !frameReadOnly.current && typeof message.xml === "string" && message.xml.length <= maxXmlLength) {
        if (currentXml.current === message.xml) return;
        currentXml.current = message.xml;
        setDirty(true);
        setEditVersion(++changes.current);
        await updateDirty(); return;
      }
      if (message.event === "save" || message.event === "shortcut" && message.command === "save") {
        requestSave(); return;
      }
      const echoed = message.message as { requestId?: unknown } | undefined;
      const query = selectionQuery.current;
      if (query && message.event === "export" && message.format === "json" && echoed?.requestId === query.id) {
        try {
          if (message.error) throw new Error("DRAWIO_INVALID");
          query.finish(undefined, hasDrawioSelection(message.data));
        } catch { query.finish(new Error("DRAWIO_INVALID")); }
        return;
      }
      const request = pending.current;
      if (!request || controller.current || message.event !== "export" || echoed?.requestId !== request.id || !saved.current || readOnly && request.kind !== "close") return;
      if (request.phase === "selection") {
        if (message.format !== "json") return;
        try {
          if (message.error) throw new Error("DRAWIO_INVALID");
          const xml = selectedDrawioXml(message.data);
          if (!xml) { finish(); setError(t("drawio.emptySelection")); return; }
          request.selectionXml = xml; request.phase = "source";
          post({ action: "export", format: "xml", requestId: request.id });
        } catch { finish(); setError(t("errors.codes.DRAWIO_INVALID")); }
        return;
      }
      if ((request.kind === "pdf" && !request.selectionXml ? message.format !== "svg" : message.format !== "xml")) return;
      window.clearTimeout(request.timer);
      const abort = new AbortController(); controller.current = abort;
      let failed = false;
      let savingSource = request.kind !== "pdf";
      try {
        if (message.error || typeof message.xml !== "string" || message.xml.length > maxXmlLength) throw new Error(t("errors.codes.DRAWIO_INVALID"));
        const xml = message.xml;
        if (changes.current === request.change) currentXml.current = xml;
        const base = saved.current;
        const unchanged = await sameDrawioContent(xml, base.content);
        if (abort.signal.aborted || !mounted.current) return;
        if (!unchanged) {
          setDirty(true);
          savingSource = true;
          assertOwner(request);
          const result = await api<{ revision: string }>(`/api/projects/${projectId}/drawio`, {
            method: "PUT", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(saveRequestTimeoutMs)]),
            body: JSON.stringify({ path, content: xml, revision: base.revision, lockToken: request.lockToken })
          });
          if (abort.signal.aborted || !mounted.current) return;
          saved.current = { ...base, content: xml, revision: result.revision };
          setSaveError("");
          onChanged();
        }
        // Do not clear changes made while the HTTP save was in flight.
        const stillDirty = await updateDirty();
        if (abort.signal.aborted || !mounted.current) return;
        if (stillDirty === false) setSaveError("");
        post({ action: "status", message: stillDirty === false ? t("drawio.saved") : "", modified: stillDirty ?? true });
        if (request.kind === "close" && stillDirty === false) settleClose(true);
        if (request.kind === "pdf") {
          savingSource = false;
          assertOwner(request);
          const svgData = request.selectionXml
            ? await renderDrawioSelection(request.selectionXml, request.options!.margin, lang, abort.signal) : message.data;
          if (abort.signal.aborted || !mounted.current) return;
          assertOwner(request);
          const svg = decodeDrawioSvg(svgData);
          const result = await api<{ path: string; pdfRevision: string }>(`/api/projects/${projectId}/drawio/pdf`, {
            method: "POST", signal: abort.signal, body: JSON.stringify({ path, svg, revision: saved.current.revision, pdfRevision: saved.current.pdfRevision, lockToken: request.lockToken })
          });
          if (abort.signal.aborted || !mounted.current) return;
          saved.current.pdfRevision = result.pdfRevision;
          onChanged();
          setFeedback(true);
        }
      } catch (error) {
        failed = true;
        if (!abort.signal.aborted && mounted.current) {
          const message = error instanceof Error && ["DRAWIO_INVALID", "DRAWIO_EXPORT_FAILED"].includes(error.message) ? t(`errors.codes.${error.message}`) : errorMessage(error);
          if (savingSource) setSaveError(message); else setError(message);
        }
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          finishRequest(failed);
        }
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });

  const assertOwner = (request: Request) => {
    if (readOnly || lock.current.current.status !== "owned" || request.lockToken !== lock.current.current.token
      || request.lockToken !== approved.current) throw new Error(t("errors.codes.DRAWIO_LOCK_LOST"));
  };
  const finishRequest = (failed: boolean) => {
    finish();
    const immediate = saveImmediately.current; saveImmediately.current = false;
    if (closeDecision.current) {
      if (failed || !start("close")) setDiscard(true);
    } else if (immediate && !failed) start("save");
  };
  const start = (kind: Request["kind"], options?: DrawioExportOptions) => {
    if (pending.current || !readyRef.current || !saved.current || frameReadOnly.current) return false;
    if (kind !== "close" && (readOnly || closeDecision.current || lock.current.current.status !== "owned" || approved.current !== lock.current.current.token)) return false;
    const id = ++sequence.current;
    setError(""); setFeedback(false); setBusy(kind);
    if (kind === "save") setSaveError("");
    const timer = window.setTimeout(() => {
      if (kind === "pdf") setError(t("errors.codes.DRAWIO_EXPORT_FAILED"));
      else setSaveError(t("drawio.saveTimeout"));
      finishRequest(true);
    }, saveRequestTimeoutMs);
    const selection = kind === "pdf" && options?.scope === "selection";
    pending.current = { id, kind, timer, change: changes.current, lockToken: lock.current.current.token, options,
      phase: selection ? "selection" : "source" };
    post(selection ? { action: "export", format: "json", requestId: id, selection: true, allPages: false, includeData: true, compressed: false }
      : { action: "export", format: kind === "pdf" ? "svg" : "xml", requestId: id,
        allPages: false, embedImages: true, embedFonts: true, border: options?.margin ?? 0, background: "#ffffff", theme: "light" });
    return true;
  };
  const requestSave = () => {
    if (!canEdit || !readyRef.current || closing || overwrite) return;
    if (pending.current) { saveImmediately.current = true; return; }
    start("save");
  };
  useEffect(() => {
    if (!ready || !canEdit || !dirty || busy || closing || overwrite || saveError) return;
    const timer = window.setTimeout(() => start("save"), autosaveDelayMs);
    return () => window.clearTimeout(timer);
    // Restart the timer for each edit, even while the diagram is already dirty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, canEdit, dirty, busy, closing, overwrite, saveError, editVersion]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!canEdit || !ready || closing || overwrite || event.defaultPrevented || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s"
        || document.querySelector('.dialog-content[data-state="open"], [aria-modal="true"]')) return;
      event.preventDefault();
      if (!event.repeat) requestSave();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const lang = useRef(i18n.resolvedLanguage === "zh-Hant" ? "zh-tw" : i18n.resolvedLanguage === "zh" ? "zh" : "en").current;
  const appearance = useRef({ ui: window.innerWidth <= 600 ? "simple" : currentTheme() === "dark" ? "dark" : "kennedy",
    dark: currentTheme() === "dark" ? "1" : "0", sidebar: window.innerWidth > 600 && !readOnly ? "1" : "0" }).current;
  const url = `${DRAWIO_ORIGIN}/?${new URLSearchParams({ embed: "1", proto: "json", configure: "1", spin: "1",
    libraries: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", stealth: "1", plugins: "0", ...appearance, lang })}`;
  const status = readOnly || (!canEdit && lock.state.status !== "connecting") ? "readOnly"
    : lock.state.status === "connecting" ? "connecting" : busy === "save" || busy === "close" ? "saving"
      : saveError ? "saveFailed" : dirty ? "saving" : ready ? "saved" : "loading";

  return <>
    <section className="drawio-editor" aria-label={path}>
      <div className="drawio-toolbar">
        <span className="drawio-file-name"><Workflow size={14} aria-hidden /><span>{path}</span></span>
        {!readOnly && <div className="drawio-actions">
          <DrawioExportButton saving={busy === "pdf"} disabled={!canEdit || !ready || Boolean(busy) || closing} feedback={feedback ? t("drawio.exported") : ""} checkSelection={checkSelection}
            onExport={(options) => { if (saved.current?.pdfRevision) setOverwrite(options); else start("pdf", options); }} />
          {busy === "pdf" && <button type="button" onClick={() => { const active = controller.current; controller.current = null; active?.abort(); finishRequest(false); }}>{t("common.cancel")}</button>}
        </div>}
        <div className="drawio-status-tools">
          <span className={`drawio-status${status === "saved" ? " is-saved" : status === "saveFailed" ? " is-failed" : ""}`} role="status">
            {status === "saved" && <Check size={12} aria-hidden="true" />}{t(`drawio.${status}`)}
          </span>
          <span className="drawio-help"><InfoPopover content={t("drawio.help")} side="bottom" /></span>
        </div>
      </div>
      {(lock.state.status === "busy" || lock.state.status === "lost") && <div className="drawio-lock-notice" role="status"><LockKeyhole size={14} aria-hidden />
        <span>{lock.state.status === "busy" ? t("drawio.lockedBy", { name: lock.state.name }) : t("drawio.lockLost")}</span>
        <button type="button" disabled={Boolean(busy)} onClick={lock.retry}><RefreshCw size={13} aria-hidden />{t("drawio.retryEdit")}</button>
      </div>}
      {(saveError || error) && <div className="error drawio-error" role="alert">
        <span>{saveError || error}</span>
        {saveError && canEdit && <button type="button" disabled={Boolean(busy) || closing} onClick={requestSave}>{t("common.retry")}</button>}
      </div>}
      <div className="drawio-frame-wrap" inert={closing || busy === "pdf" || !canEdit && !frameReadOnly.current}>
        {!ready && <div className="drawio-loading" role="status">{loadingFailed ? <><span>{t("drawio.unavailable")}</span><button onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />{t("common.retry")}</button></> : <><LoaderCircle size={20} className="spin" /><span>{t("drawio.loading")}</span></>}</div>}
        <iframe key={retry} ref={frame} src={url} title={t("drawio.title")} referrerPolicy="no-referrer"
          onError={() => setLoadingFailed(true)}
          sandbox="allow-scripts allow-same-origin allow-modals" />
      </div>
    </section>
    <ConfirmDialog open={discard} title={t("drawio.discard")} description={t("drawio.discardDescription")} confirmLabel={t("drawio.discardAction")} danger
      onCancel={() => { setDiscard(false); settleClose(false); }} onConfirm={() => { setDiscard(false); settleClose(true); }} />
    <ConfirmDialog open={Boolean(overwrite)} title={t("drawio.overwrite")} description={t("drawio.overwriteDescription", { path: drawioPdfPath(path) })} confirmLabel={t("drawio.overwriteAction")}
      onCancel={() => setOverwrite(null)} onConfirm={() => { const options = overwrite!; setOverwrite(null); start("pdf", options); }} />
  </>;
}
