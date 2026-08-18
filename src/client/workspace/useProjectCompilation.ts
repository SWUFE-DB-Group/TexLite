import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { CompileDiagnostics } from "../compileDiagnostics";
import type { SharedCompileState } from "../collaboration";
import { errorMessage } from "../errors";
import type { Project } from "../types";
import type { CompileArtifact } from "./types";

type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts";
export type CompileCleanMode = "cache" | "artifacts";

interface LatestRun {
  id: string;
  status: string;
  log: string;
  diagnostics: CompileDiagnostics;
  requestedBy?: { id: string; username: string; name: string } | null;
}

interface LatestCompileResponse {
  mainFile: string;
  latestRun: LatestRun | null;
  pdfUrl: string | null;
  pdfCompiledAt: string | null;
}

interface UseProjectCompilationOptions {
  projectId: string;
  project: Project | null;
  mainFile: string;
  collaborationSynced: boolean;
  sharedState: SharedCompileState | null;
  onSharedState: (state: SharedCompileState | null) => void;
  save: () => Promise<boolean>;
  loadOutline: (signal: AbortSignal, mainFile: string) => Promise<void>;
  onPreviewTab: (tab: PreviewTab) => void;
  onError: (message: string) => void;
  onCompileStart: () => void;
  onCompileSuccess: () => void;
  onPdfChanged: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function prefetchPdf(url: string): void {
  // Warm the browser's HTTP cache while the project metadata and collaboration
  // room are still loading. The versioned run query makes this safe: a new
  // successful compile produces a different URL.
  void fetch(url, { credentials: "same-origin", cache: "force-cache" })
    .then((response) => response.ok ? response.arrayBuffer() : undefined)
    .catch(() => undefined);
}

export function useProjectCompilation({
  projectId, project, mainFile, collaborationSynced, sharedState, onSharedState, save,
  loadOutline, onPreviewTab, onError, onCompileStart, onCompileSuccess, onPdfChanged
}: UseProjectCompilationOptions) {
  const { t } = useTranslation();
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfCompiledAt, setPdfCompiledAt] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState("");
  const [compileDiagnostics, setCompileDiagnostics] = useState<CompileDiagnostics | null>(null);
  const [compileOutcome, setCompileOutcome] = useState<"succeeded" | "failed" | null>(null);
  const [artifacts, setArtifacts] = useState<CompileArtifact[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<{ path: string; content: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [compilingMainFiles, setCompilingMainFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [editorNotice, setEditorNotice] = useState("");
  const mainFileRef = useRef(mainFile);
  const pdfMainFileRef = useRef("");
  const latestRequest = useRef<AbortController | null>(null);
  const artifactsRequest = useRef<AbortController | null>(null);
  const compileRequests = useRef(new Map<string, AbortController>());
  const focusedCompileRun = useRef<string | null>(null);
  const compileAction = useRef<() => void>(() => undefined);
  const callbacks = useRef({ onSharedState, save, loadOutline, onPreviewTab, onError, onCompileStart, onCompileSuccess, onPdfChanged });
  mainFileRef.current = mainFile;
  callbacks.current = { onSharedState, save, loadOutline, onPreviewTab, onError, onCompileStart, onCompileSuccess, onPdfChanged };

  const focusPdfAfterCompile = (runId: string) => {
    if (focusedCompileRun.current === runId) return;
    focusedCompileRun.current = runId;
    callbacks.current.onCompileSuccess();
  };

  const loadArtifacts = async (requestedMainFile: string, signal?: AbortSignal) => {
    if (!signal) {
      artifactsRequest.current?.abort();
      artifactsRequest.current = new AbortController();
      signal = artifactsRequest.current.signal;
    }
    try {
      const query = requestedMainFile ? `?mainFile=${encodeURIComponent(requestedMainFile)}` : "";
      const result = await api<{ artifacts: CompileArtifact[] }>(
        `/api/projects/${projectId}/compile/artifacts${query}`,
        { signal }
      );
      if (mainFileRef.current === requestedMainFile) {
        setArtifacts(result.artifacts);
        setArtifactPreview(null);
      }
    } catch (error) {
      if (!isAbortError(error) && mainFileRef.current === requestedMainFile) {
        setArtifacts([]);
        setArtifactPreview(null);
      }
    } finally {
      if (artifactsRequest.current?.signal === signal) artifactsRequest.current = null;
    }
  };

  useEffect(() => {
    latestRequest.current?.abort();
    const controller = new AbortController();
    latestRequest.current = controller;
    setPdfLoading(true);
    setCompileLog("");
    setCompileDiagnostics(null);
    setCompileOutcome(null);
    const retainPrefetchedPdf = Boolean(pdfUrl && mainFile && pdfMainFileRef.current === mainFile);
    if (!retainPrefetchedPdf) {
      setPdfUrl("");
      setPdfCompiledAt(null);
    }
    setArtifacts([]);
    setArtifactPreview(null);
    callbacks.current.onPdfChanged();
    const query = mainFile ? `?mainFile=${encodeURIComponent(mainFile)}` : "";
    // The retained PDF is the critical path when reopening a project. Do not
    // make it wait for the outline or the (potentially large) artifact scan.
    // The background requests are started after the PDF URL is published and
    // then run in parallel with PDF.js network loading and rendering.
    const latestRequestPromise = api<LatestCompileResponse>(
      `/api/projects/${projectId}/compile/latest${query}`,
      { signal: controller.signal }
    );
    let backgroundStarted = false;
    const startBackgroundLoads = () => {
      if (backgroundStarted || controller.signal.aborted || !mainFile) return;
      backgroundStarted = true;
      // Start these only after the latest PDF URL has been published to React.
      // They then run in parallel with PDF.js network loading and rendering.
      void loadArtifacts(mainFile, controller.signal);
      void callbacks.current.loadOutline(controller.signal, mainFile).catch(() => undefined);
    };
    void latestRequestPromise.then((latest) => {
      if (controller.signal.aborted || (mainFile && latest.mainFile !== mainFileRef.current)) return;
      setCompileLog(latest.latestRun?.log ?? "");
      setCompileDiagnostics(latest.latestRun?.diagnostics ?? null);
      setCompileOutcome(latest.latestRun?.status === "succeeded" || latest.latestRun?.status === "failed"
        ? latest.latestRun.status
        : null);
      if (mainFile && latest.latestRun?.requestedBy && (latest.latestRun.status === "queued" || latest.latestRun.status === "running")) {
        callbacks.current.onSharedState({
          mainFile,
          runId: latest.latestRun.id,
          status: latest.latestRun.status,
          requestedBy: latest.latestRun.requestedBy,
          updatedAt: new Date().toISOString()
        });
      }
      if (latest.pdfUrl) {
        pdfMainFileRef.current = latest.mainFile;
        setPdfUrl(latest.pdfUrl);
        setPdfCompiledAt(latest.pdfCompiledAt);
        callbacks.current.onPreviewTab("pdf");
        if (!project) prefetchPdf(latest.pdfUrl);
      }
    }).catch((error) => {
      if (!isAbortError(error) && mainFileRef.current === mainFile) callbacks.current.onError(errorMessage(error));
    }).finally(() => {
      if (latestRequest.current === controller) latestRequest.current = null;
      if (!controller.signal.aborted) setPdfLoading(false);
      // Give React one turn to mount PdfPreview and start its PDF request
      // before the background scans begin.
      window.setTimeout(startBackgroundLoads, 0);
    });
    return () => controller.abort();
  }, [project?.id, projectId, mainFile]);

  useEffect(() => {
    if (!sharedState || sharedState.mainFile !== mainFile || sharedState.status !== "cleaned" || !sharedState.cleanMode) return;
    latestRequest.current?.abort();
    artifactsRequest.current?.abort();
    if (sharedState.cleanMode === "artifacts") {
      setCompileLog("");
      setCompileDiagnostics(null);
      setCompileOutcome(null);
      setPdfUrl("");
      setPdfCompiledAt(null);
      setArtifacts([]);
      setArtifactPreview(null);
      callbacks.current.onPdfChanged();
      callbacks.current.onPreviewTab("pdf");
      setEditorNotice(t("editor.cleanArtifactsComplete"));
    } else {
      setEditorNotice(t("editor.cleanCacheComplete"));
    }
  }, [sharedState?.runId, sharedState?.status, sharedState?.cleanMode, sharedState?.mainFile, mainFile, t]);

  useEffect(() => {
    if (!sharedState || sharedState.mainFile !== mainFile
      || (sharedState.status !== "succeeded" && sharedState.status !== "failed")) return;
    let cancelled = false;
    latestRequest.current?.abort();
    const controller = new AbortController();
    latestRequest.current = controller;
    setPdfLoading(true);
    void api<LatestCompileResponse>(
      `/api/projects/${projectId}/compile/latest?mainFile=${encodeURIComponent(mainFile)}`,
      { signal: controller.signal }
    ).then((latest) => {
      if (cancelled || latest.mainFile !== mainFileRef.current || latest.latestRun?.id !== sharedState.runId) return;
      setCompileLog(latest.latestRun.log);
      setCompileDiagnostics(latest.latestRun.diagnostics);
      setCompileOutcome(sharedState.status === "succeeded" ? "succeeded" : "failed");
      if (sharedState.status === "succeeded" && latest.pdfUrl) {
        callbacks.current.onPdfChanged();
        setPdfUrl(latest.pdfUrl);
        setPdfCompiledAt(latest.pdfCompiledAt);
        callbacks.current.onPreviewTab("pdf");
        focusPdfAfterCompile(sharedState.runId);
        void loadArtifacts(mainFile);
      } else if (sharedState.status === "failed") {
        callbacks.current.onPreviewTab(latest.latestRun.diagnostics.errors.length ? "errors" : "log");
      }
    }).catch((error) => {
      if (!isAbortError(error) && !cancelled) callbacks.current.onError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setPdfLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (latestRequest.current === controller) latestRequest.current = null;
    };
  }, [sharedState?.runId, sharedState?.status, sharedState?.mainFile, mainFile, projectId]);

  const compile = async () => {
    if (!project || !mainFile || project.permission === "read" || !collaborationSynced
      || compileRequests.current.has(mainFile)
      || (sharedState?.mainFile === mainFile && (sharedState.status === "queued" || sharedState.status === "running"))) return;
    const requestedMainFile = mainFile;
    setCompilingMainFiles((current) => new Set([...current, requestedMainFile]));
    callbacks.current.onCompileStart();
    setEditorNotice("");
    setCompileLog("");
    setCompileDiagnostics(null);
    setCompileOutcome(null);
    callbacks.current.onPreviewTab(pdfUrl ? "pdf" : "log");
    const controller = new AbortController();
    compileRequests.current.set(requestedMainFile, controller);
    try {
      if (!(await callbacks.current.save())) return;
      const result = await api<{ runId: string; mainFile: string; ok: boolean; skipped?: boolean; log: string; diagnostics: CompileDiagnostics; pdfUrl: string | null; pdfCompiledAt: string | null }>(
        `/api/projects/${projectId}/compile`,
        { method: "POST", signal: controller.signal, body: JSON.stringify({ mainFile: requestedMainFile }) }
      );
      if (result.mainFile !== mainFileRef.current) return;
      setCompileLog(result.log);
      setCompileDiagnostics(result.diagnostics);
      setCompileOutcome(result.ok ? "succeeded" : "failed");
      if (result.skipped) setEditorNotice(t("editor.upToDate"));
      if (result.pdfUrl) {
        callbacks.current.onPdfChanged();
        setPdfUrl(result.pdfUrl);
        setPdfCompiledAt(result.pdfCompiledAt);
        callbacks.current.onPreviewTab("pdf");
        if (result.ok) {
          // A skipped request reuses the published run id and is not
          // broadcast as a new shared compile state, so it must always move
          // the local PDF to the current source cursor.
          if (result.skipped) callbacks.current.onCompileSuccess();
          else focusPdfAfterCompile(result.runId);
        }
      } else {
        callbacks.current.onPreviewTab(result.diagnostics.errors.length ? "errors" : "log");
      }
    } catch (error) {
      if (!isAbortError(error) && mainFileRef.current === requestedMainFile) callbacks.current.onError(errorMessage(error));
    } finally {
      if (compileRequests.current.get(requestedMainFile) === controller) {
        compileRequests.current.delete(requestedMainFile);
        setCompilingMainFiles((current) => {
          const next = new Set(current);
          next.delete(requestedMainFile);
          return next;
        });
      }
    }
  };

  const cleanCompile = async (mode: CompileCleanMode): Promise<void> => {
    if (!project || !mainFile || project.permission === "read" || !collaborationSynced || cleaning
      || compileRequests.current.has(mainFile)
      || (sharedState?.mainFile === mainFile && (sharedState.status === "queued" || sharedState.status === "running"))) return;
    const requestedMainFile = mainFile;
    setCleaning(true);
    latestRequest.current?.abort();
    artifactsRequest.current?.abort();
    try {
      const result = await api<{ ok: boolean; mode: CompileCleanMode; mainFile: string; retainedPdf: boolean }>(
        `/api/projects/${projectId}/compile/clean`,
        { method: "POST", body: JSON.stringify({ mainFile: requestedMainFile, mode }) }
      );
      if (result.mainFile !== mainFileRef.current) return;
      callbacks.current.onSharedState(null);
      if (mode === "artifacts") {
        setCompileLog("");
        setCompileDiagnostics(null);
        setCompileOutcome(null);
        setPdfUrl("");
        setPdfCompiledAt(null);
        setArtifacts([]);
        setArtifactPreview(null);
        callbacks.current.onPdfChanged();
      }
      setEditorNotice(mode === "cache" ? t("editor.cleanCacheComplete") : t("editor.cleanArtifactsComplete"));
    } catch (error) {
      if (!isAbortError(error) && mainFileRef.current === requestedMainFile) callbacks.current.onError(errorMessage(error));
    } finally {
      setCleaning(false);
    }
  };

  compileAction.current = () => void compile();

  useEffect(() => {
    if (!editorNotice) return;
    const timeout = window.setTimeout(() => setEditorNotice(""), 3_000);
    return () => window.clearTimeout(timeout);
  }, [editorNotice]);

  useEffect(() => {
    const handleCompileShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) compileAction.current();
    };
    window.addEventListener("keydown", handleCompileShortcut, true);
    return () => window.removeEventListener("keydown", handleCompileShortcut, true);
  }, []);

  useEffect(() => () => {
    latestRequest.current?.abort();
    artifactsRequest.current?.abort();
    for (const request of compileRequests.current.values()) request.abort();
    compileRequests.current.clear();
  }, []);

  const viewArtifact = async (artifact: CompileArtifact) => {
    if (!artifact.viewable) return;
    setArtifactLoading(true);
    try {
      const result = await api<{ path: string; content: string }>(
        `/api/projects/${projectId}/compile/artifacts?mainFile=${encodeURIComponent(mainFile)}&path=${encodeURIComponent(artifact.path)}`
      );
      setArtifactPreview(result);
    } catch (error) {
      callbacks.current.onError(errorMessage(error));
    } finally {
      setArtifactLoading(false);
    }
  };

  return {
    pdfUrl,
    pdfCompiledAt,
    pdfLoading,
    compileLog,
    compileDiagnostics,
    compileOutcome,
    artifacts,
    artifactPreview,
    artifactLoading,
    editorNotice,
    localCompiling: compilingMainFiles.has(mainFile),
    cleaning,
    compile,
    cleanCompile,
    viewArtifact
  };
}
