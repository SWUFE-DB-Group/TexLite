import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { SharedCompileState } from "../collaboration";
import { errorMessage } from "../errors";
import type { Project } from "../types";
import { CompilationResults, type CompileResponse, type LatestCompileResponse } from "./compilationResults";
import type { CompileArtifact } from "./types";

export type { LatestCompileResponse } from "./compilationResults";
type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts";
export type CompileCleanMode = "cache" | "artifacts";

interface UseProjectCompilationOptions {
  projectId: string;
  project: Project | null;
  mainFile: string;
  /** May promote the active source to a root before React commits that change. */
  resolveCompileMainFile?: () => string;
  getCurrentMainFile?: () => string;
  initialLatest?: Promise<LatestCompileResponse> | null;
  collaborationSynced: boolean;
  pdfVisible: boolean;
  sharedState: SharedCompileState | null;
  onSharedState: Dispatch<SetStateAction<SharedCompileState | null>>;
  save: () => Promise<boolean>;
  loadOutline: (signal: AbortSignal, mainFile: string) => Promise<void>;
  onPreviewTab: (tab: PreviewTab) => void;
  onError: (message: string) => void;
  onCompileStart: () => void;
  onCompileSuccess: () => void;
  onPdfChanged: () => void;
}

interface ScopedRequest { owner: CompilationResults; controller: AbortController }
const targetKey = (projectId: string, mainFile: string) => `${projectId}\0${mainFile}`;
const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

function abortRequest(ref: { current: ScopedRequest | null }, owner?: CompilationResults): void {
  if (ref.current && (!owner || ref.current.owner === owner)) {
    ref.current.controller.abort();
    ref.current = null;
  }
}

function isFormTarget(target: EventTarget | null): boolean {
  // CodeMirror is contenteditable: only native form controls/dialogs consume
  // Ctrl/Cmd+S without compiling or opening the browser's Save Page dialog.
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof Element && Boolean(target.closest('[role="dialog"], [role="alertdialog"]')));
}

export function useProjectCompilation(options: UseProjectCompilationOptions) {
  const { projectId, project, mainFile, initialLatest, collaborationSynced, pdfVisible, sharedState } = options;
  const { t } = useTranslation();
  const callbacks = useRef({ ...options, t });
  callbacks.current = { ...options, t };
  const mounted = useRef(false);
  const ownerRef = useRef<CompilationResults | null>(null);
  const previousOwner = ownerRef.current;
  if (!previousOwner || previousOwner.selection.projectId !== projectId || previousOwner.selection.mainFile !== mainFile) {
    ownerRef.current = new CompilationResults({ projectId, mainFile },
      !previousOwner || previousOwner.selection.projectId !== projectId || !previousOwner.selection.mainFile);
  }
  const owner = ownerRef.current!;
  const [snapshot, setSnapshot] = useState(owner.snapshot);
  const [initialLoad, setInitialLoad] = useState<ScopedRequest | null>(null);
  const [sharedLoad, setSharedLoad] = useState<ScopedRequest | null>(null);
  const [artifacts, setArtifacts] = useState<CompileArtifact[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<{ path: string; content: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [cleaningOwner, setCleaningOwner] = useState<CompilationResults | null>(null);
  const [compilingTargets, setCompilingTargets] = useState<ReadonlySet<string>>(() => new Set());
  const [cancellingTargets, setCancellingTargets] = useState<ReadonlySet<string>>(() => new Set());
  const [editorNotice, setEditorNotice] = useState("");
  const latestRequest = useRef<ScopedRequest | null>(null);
  const completedRequest = useRef<ScopedRequest | null>(null);
  const artifactsRequest = useRef<ScopedRequest | null>(null);
  const previewRequest = useRef<ScopedRequest | null>(null);
  const cleanRequest = useRef<ScopedRequest | null>(null);
  const cancelRequests = useRef(new Map<string, ScopedRequest>());
  const compileRequests = useRef(new Map<string, ScopedRequest>());
  const backgroundRequests = useRef(new Set<ScopedRequest>());
  const preload = useRef({ projectId, promise: initialLatest });
  if (preload.current.projectId !== projectId) preload.current = { projectId, promise: initialLatest };
  const paintedPdf = useRef<{ owner: CompilationResults; url: string } | null>(null);
  const pendingArtifacts = useRef<{ owner: CompilationResults; url: string } | null>(null);
  const compileAction = useRef<() => void>(() => undefined);

  const currentMainFile = () => callbacks.current.getCurrentMainFile?.() || ownerRef.current!.selection.mainFile;
  const isCurrent = (scope: CompilationResults, signal?: AbortSignal) => mounted.current && !signal?.aborted
    && ownerRef.current === scope && currentMainFile() === scope.selection.mainFile;
  const key = targetKey(projectId, mainFile);
  const selectionVisible = snapshot.selection === owner.selection;
  const localCompiling = compilingTargets.has(key);
  const cleaning = cleaningOwner === owner;

  const abortReads = (scope: CompilationResults) => {
    for (const ref of [latestRequest, completedRequest, artifactsRequest, previewRequest]) abortRequest(ref, scope);
    for (const request of backgroundRequests.current) {
      if (request.owner === scope) { request.controller.abort(); backgroundRequests.current.delete(request); }
    }
    setInitialLoad((current) => current?.owner === scope ? null : current);
    setSharedLoad((current) => current?.owner === scope ? null : current);
    setArtifactLoading(false);
  };

  const resetPanels = () => {
    pendingArtifacts.current = null;
    paintedPdf.current = null;
    setArtifacts([]); setArtifactPreview(null); setArtifactLoading(false); setEditorNotice("");
    callbacks.current.onPdfChanged();
  };

  const loadArtifacts = async (scope: CompilationResults, supplied?: ScopedRequest) => {
    if (!isCurrent(scope)) return;
    const request = supplied ?? { owner: scope, controller: new AbortController() };
    if (!supplied) { abortRequest(artifactsRequest); artifactsRequest.current = request; }
    const pdfUrl = scope.snapshot.pdf?.url;
    const valid = () => isCurrent(scope, request.controller.signal) && scope.snapshot.pdf?.url === pdfUrl;
    try {
      const result = await api<{ artifacts: CompileArtifact[] }>(
        `/api/projects/${scope.selection.projectId}/compile/artifacts?mainFile=${encodeURIComponent(scope.selection.mainFile)}`,
        { signal: request.controller.signal }
      );
      if (valid()) { setArtifacts(result.artifacts); setArtifactPreview(null); }
    } catch (error) {
      if (!isAbortError(error) && valid()) { setArtifacts([]); setArtifactPreview(null); }
    } finally {
      if (artifactsRequest.current === request) artifactsRequest.current = null;
    }
  };

  const flushArtifactRefresh = () => {
    const pending = pendingArtifacts.current;
    if (!pending) return;
    pendingArtifacts.current = null;
    if (isCurrent(pending.owner) && pending.owner.snapshot.pdf?.url === pending.url) void loadArtifacts(pending.owner);
  };

  const refreshArtifactsAfterPdf = (scope: CompilationResults) => {
    const url = scope.snapshot.pdf?.url;
    if (!url) return;
    pendingArtifacts.current = { owner: scope, url };
    if (!callbacks.current.pdfVisible || (paintedPdf.current?.owner === scope && paintedPdf.current.url === url)) flushArtifactRefresh();
  };

  const pdfDisplayed = (url: string) => {
    if (!isCurrent(owner) || owner.snapshot.pdf?.url !== url) return;
    paintedPdf.current = { owner, url };
    if (pendingArtifacts.current?.owner === owner && pendingArtifacts.current.url === url) flushArtifactRefresh();
  };

  const publish = (scope: CompilationResults, reception: ReturnType<CompilationResults["receiveLocal"]>) => {
    if (!reception || !isCurrent(scope)) return false;
    setSnapshot(reception.snapshot);
    if (reception.pdfChanged) callbacks.current.onPdfChanged();
    if (reception.focusPdf) callbacks.current.onCompileSuccess();
    return true;
  };

  const applyClean = (scope: CompilationResults, mode: CompileCleanMode) => {
    abortReads(scope);
    pendingArtifacts.current = null;
    scope.clean(mode);
    setSnapshot(scope.snapshot);
    if (mode === "artifacts") {
      resetPanels();
      callbacks.current.onPreviewTab("pdf");
    }
    setEditorNotice(callbacks.current.t(mode === "cache" ? "editor.cleanCacheComplete" : "editor.cleanArtifactsComplete"));
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const ref of [latestRequest, completedRequest, artifactsRequest, previewRequest, cleanRequest]) abortRequest(ref);
      for (const request of [...backgroundRequests.current, ...compileRequests.current.values(), ...cancelRequests.current.values()]) request.controller.abort();
      backgroundRequests.current.clear(); compileRequests.current.clear(); cancelRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!pdfVisible) flushArtifactRefresh();
  }, [pdfVisible]);

  useEffect(() => {
    setSnapshot(owner.snapshot);
    resetPanels();
    // A project change retires mutations too; switching roots in the same
    // project can leave an already-started compiler running in the background.
    for (const requests of [compileRequests.current, cancelRequests.current]) {
      for (const [id, request] of requests) {
        if (request.owner.selection.projectId !== projectId) { request.controller.abort(); requests.delete(id); }
      }
    }
    // A settled cancellation may still be waiting for a terminal notification,
    // so retire busy flags independently of the outstanding request maps.
    const projectPrefix = targetKey(projectId, "");
    const retainProjectTargets = (current: ReadonlySet<string>) => {
      const next = new Set([...current].filter((id) => id.startsWith(projectPrefix)));
      return next.size === current.size ? current : next;
    };
    setCompilingTargets(retainProjectTargets);
    setCancellingTargets(retainProjectTargets);
    if (cleanRequest.current?.owner !== owner) abortRequest(cleanRequest);
    if (!mainFile) return;
    if (!owner.restoreRetained) {
      callbacks.current.onPreviewTab("pdf");
      const request = { owner, controller: new AbortController() };
      void callbacks.current.loadOutline(request.controller.signal, mainFile).catch(() => undefined);
      return () => { request.controller.abort(); abortReads(owner); };
    }
    const request = { owner, controller: new AbortController() };
    latestRequest.current = request;
    setInitialLoad(request);
    let backgroundTimer: number | null = null;
    // Route preloads started before this hook have no state baseline. They
    // must not replace an existing notification; a fresh lookup can discover
    // a different run if its starting state has not changed in the meantime.
    let sharedAtStart: SharedCompileState | null | undefined;
    const fetchLatest = () => {
      sharedAtStart = callbacks.current.sharedState;
      return api<LatestCompileResponse>(
        `/api/projects/${projectId}/compile/latest?mainFile=${encodeURIComponent(mainFile)}`, { signal: request.controller.signal }
      );
    };
    // Route preload is consumed once per project, including failed/mismatched
    // preloads. StrictMode can then retry normally rather than reusing one
    // aborted bootstrap forever.
    const preloaded = preload.current.promise;
    preload.current.promise = null;
    const lookup = preloaded ? preloaded.then((value) => {
      if (!isCurrent(owner, request.controller.signal)) return null;
      return value.mainFile === mainFile ? value : fetchLatest();
    }, () => isCurrent(owner, request.controller.signal) ? fetchLatest() : null) : fetchLatest();
    void lookup.then((latest) => {
      if (!latest || !isCurrent(owner, request.controller.signal)) return;
      if (!publish(owner, owner.receiveLatest(latest, "initial"))) return;
      if (latest.latestRun?.requestedBy && (latest.latestRun.status === "queued" || latest.latestRun.status === "running")) {
        const initialState: SharedCompileState = {
          mainFile, runId: latest.latestRun.id, status: latest.latestRun.status,
          requestedBy: latest.latestRun.requestedBy, updatedAt: new Date().toISOString()
        };
        callbacks.current.onSharedState((current) => {
          if (!isCurrent(owner, request.controller.signal)) return current;
          // Bootstrap only fills in state. Preserve notifications received
          // during the lookup, including updates not committed by React yet.
          // For the same run, queued may advance to running, never backwards
          // from running or a terminal state. A different new run is allowed
          // when no notification has superseded this lookup.
          if (current?.mainFile === mainFile && (current !== sharedAtStart
            || (current.runId === initialState.runId && (current.status !== "queued" || initialState.status === "queued")))) return current;
          return initialState;
        });
      }
      if (latest.pdfUrl) callbacks.current.onPreviewTab("pdf");
    }).catch((error) => {
      if (!isAbortError(error) && isCurrent(owner, request.controller.signal)) callbacks.current.onError(errorMessage(error));
    }).finally(() => {
      if (latestRequest.current === request) latestRequest.current = null;
      setInitialLoad((current) => current === request ? null : current);
      if (!isCurrent(owner, request.controller.signal)) return;
      // Keep the bootstrap's deferred work cancellable even after its HTTP
      // response has settled. A compile can start before this timer runs.
      backgroundRequests.current.add(request);
      backgroundTimer = window.setTimeout(() => {
        if (!isCurrent(owner, request.controller.signal)) { backgroundRequests.current.delete(request); return; }
        void Promise.all([
          loadArtifacts(owner, request),
          callbacks.current.loadOutline(request.controller.signal, mainFile).catch(() => undefined)
        ]).finally(() => backgroundRequests.current.delete(request));
      }, 0);
    });
    return () => {
      if (backgroundTimer !== null) window.clearTimeout(backgroundTimer);
      request.controller.abort();
      abortReads(owner);
    };
  }, [owner]);

  useEffect(() => {
    if (!sharedState || sharedState.mainFile !== mainFile || sharedState.status !== "cleaned" || !sharedState.cleanMode) return;
    applyClean(owner, sharedState.cleanMode);
  }, [owner, sharedState?.runId, sharedState?.status, sharedState?.cleanMode, sharedState?.mainFile]);

  useEffect(() => {
    if (sharedState?.mainFile === mainFile && (sharedState.status === "queued" || sharedState.status === "running")) {
      owner.observeRunning();
      return;
    }
    setCancellingTargets((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current); next.delete(key); return next;
    });
  }, [owner, sharedState?.mainFile, sharedState?.status, sharedState?.runId]);

  useEffect(() => {
    if (!sharedState || sharedState.mainFile !== mainFile || (sharedState.status !== "succeeded" && sharedState.status !== "failed")) return;
    // Bootstrap and cleanup defer shared replays. Their state transitions
    // retrigger reconciliation even when the completion event is unchanged.
    if (latestRequest.current?.owner === owner || cleanRequest.current?.owner === owner || cleaning
      || localCompiling || !owner.sharedCompletionAllowed || owner.hasRun(sharedState.runId)) return;
    const request = { owner, controller: new AbortController() };
    abortRequest(completedRequest);
    abortRequest(previewRequest);
    setArtifactLoading(false);
    completedRequest.current = request;
    setSharedLoad(request);
    void api<LatestCompileResponse>(
      `/api/projects/${projectId}/compile/latest?mainFile=${encodeURIComponent(mainFile)}`, { signal: request.controller.signal }
    ).then((latest) => {
      if (!isCurrent(owner, request.controller.signal) || latest.latestRun?.id !== sharedState.runId) return;
      if (!publish(owner, owner.receiveLatest(latest, "shared"))) return;
      if (sharedState.status === "succeeded" && sharedState.stale) setEditorNotice(callbacks.current.t("editor.compileSnapshotStale"));
      if (sharedState.status === "succeeded" && latest.pdfUrl) {
        callbacks.current.onPreviewTab("pdf"); refreshArtifactsAfterPdf(owner);
      } else if (sharedState.status === "failed") {
        callbacks.current.onPreviewTab(latest.latestRun.diagnostics.errors.length ? "errors" : "log");
      }
    }).catch((error) => {
      if (!isAbortError(error) && isCurrent(owner, request.controller.signal)) callbacks.current.onError(errorMessage(error));
    }).finally(() => {
      if (completedRequest.current === request) completedRequest.current = null;
      setSharedLoad((current) => current === request ? null : current);
    });
    return () => { request.controller.abort(); if (completedRequest.current === request) completedRequest.current = null; };
  }, [owner, sharedState?.runId, sharedState?.status, sharedState?.mainFile, sharedState?.stale, localCompiling, initialLoad, cleaning]);

  const compile = async () => {
    if (!project || project.permission === "read" || !collaborationSynced) return;
    const requestedMainFile = callbacks.current.resolveCompileMainFile?.() || currentMainFile();
    const id = targetKey(projectId, requestedMainFile);
    const shared = callbacks.current.sharedState;
    if (!requestedMainFile || compileRequests.current.has(id)
      || (shared?.mainFile === requestedMainFile && (shared.status === "queued" || shared.status === "running"))) return;
    let scope = ownerRef.current!;
    // Adopt a synchronously promoted root so its request and the following
    // React render share the same selection lifetime.
    if (scope.selection.mainFile !== requestedMainFile) {
      abortReads(scope);
      scope = new CompilationResults({ projectId, mainFile: requestedMainFile }, false);
      ownerRef.current = scope;
      resetPanels();
    }
    abortReads(scope);
    setEditorNotice("");
    callbacks.current.onCompileStart();
    callbacks.current.onPreviewTab(scope.snapshot.pdf ? "pdf" : "log");
    const request = { owner: scope, controller: new AbortController() };
    compileRequests.current.set(id, request);
    setCompilingTargets((current) => new Set([...current, id]));
    try {
      if (!(await callbacks.current.save()) || !isCurrent(scope, request.controller.signal)) return;
      // Saving can fail without ever starting a compile. Keep the previous
      // received run (and its replay suppression) until a POST is submitted.
      scope.beginCompile(); setSnapshot(scope.snapshot);
      const result = await api<CompileResponse>(`/api/projects/${projectId}/compile`, {
        method: "POST", signal: request.controller.signal, body: JSON.stringify({ mainFile: requestedMainFile })
      });
      if (!isCurrent(scope, request.controller.signal) || !publish(scope, scope.receiveLocal(result))) return;
      if (result.cancelled) setEditorNotice(callbacks.current.t("compileControls.cancelled"));
      if (result.skipped) setEditorNotice(callbacks.current.t("editor.upToDate"));
      if (result.ok && result.stale) setEditorNotice(callbacks.current.t("editor.compileSnapshotStale"));
      if (result.pdfUrl) { refreshArtifactsAfterPdf(scope); callbacks.current.onPreviewTab("pdf"); }
      else callbacks.current.onPreviewTab(result.diagnostics.errors.length ? "errors" : "log");
    } catch (error) {
      if (!isAbortError(error) && isCurrent(scope, request.controller.signal)) callbacks.current.onError(errorMessage(error));
    } finally {
      if (compileRequests.current.get(id) === request) {
        compileRequests.current.delete(id);
        setCompilingTargets((current) => { const next = new Set(current); next.delete(id); return next; });
        setCancellingTargets((current) => { const next = new Set(current); next.delete(id); return next; });
      }
    }
  };

  const cancelCompile = async () => {
    if (!project || project.permission === "read" || !collaborationSynced || !isCurrent(owner)) return;
    const id = targetKey(projectId, mainFile);
    if (!mainFile || cancelRequests.current.has(id)) return;
    const request = { owner, controller: new AbortController() };
    cancelRequests.current.set(id, request);
    setCancellingTargets((current) => new Set([...current, id]));
    try {
      const result = await api<{ cancelled: boolean }>(`/api/projects/${projectId}/compile/cancel`, {
        method: "POST", signal: request.controller.signal, body: JSON.stringify({ mainFile })
      });
      if (!result.cancelled && isCurrent(owner, request.controller.signal)) {
        setCancellingTargets((current) => { const next = new Set(current); next.delete(id); return next; });
      }
    } catch (error) {
      if (isCurrent(owner, request.controller.signal)) {
        setCancellingTargets((current) => { const next = new Set(current); next.delete(id); return next; });
        if (!isAbortError(error)) callbacks.current.onError(errorMessage(error));
      }
    } finally { if (cancelRequests.current.get(id) === request) cancelRequests.current.delete(id); }
  };

  const cleanCompile = async (mode: CompileCleanMode) => {
    if (!project || project.permission === "read" || !collaborationSynced || !isCurrent(owner)) return;
    if (!mainFile || cleanRequest.current || compileRequests.current.has(key)
      || (sharedState?.mainFile === mainFile && (sharedState.status === "queued" || sharedState.status === "running"))) return;
    const request = { owner, controller: new AbortController() };
    const sharedAtStart = callbacks.current.sharedState;
    cleanRequest.current = request; setCleaningOwner(owner); abortReads(owner);
    try {
      const result = await api<{ ok: boolean; mode: CompileCleanMode; mainFile: string }>(`/api/projects/${projectId}/compile/clean`, {
        method: "POST", signal: request.controller.signal, body: JSON.stringify({ mainFile, mode })
      });
      if (!isCurrent(owner, request.controller.signal) || result.mainFile !== mainFile) return;
      // The HTTP response may arrive after a newer collaboration event.
      // Preserve it so reconciliation can resume when cleaning becomes false.
      if (callbacks.current.sharedState === sharedAtStart) callbacks.current.onSharedState(null);
      applyClean(owner, mode);
    } catch (error) {
      if (!isAbortError(error) && isCurrent(owner, request.controller.signal)) callbacks.current.onError(errorMessage(error));
    } finally {
      if (cleanRequest.current === request) cleanRequest.current = null;
      setCleaningOwner((current) => current === owner ? null : current);
    }
  };

  const viewArtifact = async (artifact: CompileArtifact) => {
    if (!artifact.viewable || !isCurrent(owner)) return;
    abortRequest(previewRequest);
    const request = { owner, controller: new AbortController() };
    const pdfUrl = owner.snapshot.pdf?.url;
    previewRequest.current = request; setArtifactLoading(true);
    try {
      const result = await api<{ path: string; content: string }>(
        `/api/projects/${projectId}/compile/artifacts?mainFile=${encodeURIComponent(mainFile)}&path=${encodeURIComponent(artifact.path)}`,
        { signal: request.controller.signal }
      );
      if (isCurrent(owner, request.controller.signal) && owner.snapshot.pdf?.url === pdfUrl) setArtifactPreview(result);
    } catch (error) {
      if (!isAbortError(error) && isCurrent(owner, request.controller.signal) && owner.snapshot.pdf?.url === pdfUrl) callbacks.current.onError(errorMessage(error));
    } finally {
      if (previewRequest.current === request) { previewRequest.current = null; setArtifactLoading(false); }
    }
  };

  compileAction.current = () => void compile();
  useEffect(() => {
    if (!editorNotice) return;
    const timeout = window.setTimeout(() => setEditorNotice(""), 3_000);
    return () => window.clearTimeout(timeout);
  }, [editorNotice, owner]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (isFormTarget(event.target)) return;
      event.stopPropagation();
      if (!event.repeat) compileAction.current();
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, []);

  const visible = selectionVisible ? snapshot : null;
  return {
    pdfUrl: visible?.pdf?.url ?? "", pdfCompiledAt: visible?.pdf?.compiledAt ?? null,
    pdfSizeBytes: visible?.pdf?.sizeBytes ?? null, pdfLoadingMode: visible?.pdf?.loadingMode ?? "full",
    pdfLoading: Boolean((initialLoad?.owner === owner && !initialLoad.controller.signal.aborted) || (sharedLoad?.owner === owner && !sharedLoad.controller.signal.aborted)),
    compileLog: visible?.run?.log ?? "", compileDiagnostics: visible?.run?.diagnostics ?? null, compileOutcome: visible?.run?.outcome ?? null,
    artifacts: selectionVisible ? artifacts : [], artifactPreview: selectionVisible ? artifactPreview : null,
    artifactLoading: selectionVisible && artifactLoading, editorNotice: selectionVisible ? editorNotice : "",
    localCompiling, cancelling: cancellingTargets.has(key), cleaning,
    pdfDisplayed, compile, cancelCompile, cleanCompile, viewArtifact
  };
}
