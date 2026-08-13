import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { CompileDiagnostics } from "../compileDiagnostics";
import type { SharedCompileState } from "../collaboration";
import { errorMessage } from "../errors";
import type { Project } from "../types";
import type { CompileArtifact } from "./types";

type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts";

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
  onPdfChanged: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useProjectCompilation({
  projectId, project, mainFile, collaborationSynced, sharedState, onSharedState, save,
  loadOutline, onPreviewTab, onError, onCompileStart, onPdfChanged
}: UseProjectCompilationOptions) {
  const { t } = useTranslation();
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfCompiledAt, setPdfCompiledAt] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState("");
  const [compileDiagnostics, setCompileDiagnostics] = useState<CompileDiagnostics | null>(null);
  const [compileOutcome, setCompileOutcome] = useState<"succeeded" | "failed" | null>(null);
  const [artifacts, setArtifacts] = useState<CompileArtifact[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<{ path: string; content: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [compilingMainFiles, setCompilingMainFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [editorNotice, setEditorNotice] = useState("");
  const mainFileRef = useRef(mainFile);
  const latestRequest = useRef<AbortController | null>(null);
  const artifactsRequest = useRef<AbortController | null>(null);
  const compileRequests = useRef(new Map<string, AbortController>());
  const compileAction = useRef<() => void>(() => undefined);
  const callbacks = useRef({ onSharedState, save, loadOutline, onPreviewTab, onError, onCompileStart, onPdfChanged });
  mainFileRef.current = mainFile;
  callbacks.current = { onSharedState, save, loadOutline, onPreviewTab, onError, onCompileStart, onPdfChanged };

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
    setCompileLog("");
    setCompileDiagnostics(null);
    setCompileOutcome(null);
    setPdfUrl("");
    setPdfCompiledAt(null);
    setArtifacts([]);
    setArtifactPreview(null);
    callbacks.current.onPdfChanged();
    if (!project || !mainFile) return () => controller.abort();
    const query = `?mainFile=${encodeURIComponent(mainFile)}`;
    const artifactRequest = api<{ artifacts: CompileArtifact[] }>(
      `/api/projects/${projectId}/compile/artifacts${query}`,
      { signal: controller.signal }
    ).catch((error) => {
      if (isAbortError(error)) throw error;
      return { artifacts: [] };
    });
    void Promise.all([
      api<LatestCompileResponse>(`/api/projects/${projectId}/compile/latest${query}`, { signal: controller.signal }),
      artifactRequest,
      callbacks.current.loadOutline(controller.signal, mainFile)
    ]).then(([latest, artifactResult]) => {
      if (controller.signal.aborted || latest.mainFile !== mainFileRef.current) return;
      setArtifacts(artifactResult.artifacts);
      setCompileLog(latest.latestRun?.log ?? "");
      setCompileDiagnostics(latest.latestRun?.diagnostics ?? null);
      setCompileOutcome(latest.latestRun?.status === "succeeded" || latest.latestRun?.status === "failed"
        ? latest.latestRun.status
        : null);
      if (latest.latestRun?.requestedBy && (latest.latestRun.status === "queued" || latest.latestRun.status === "running")) {
        callbacks.current.onSharedState({
          mainFile,
          runId: latest.latestRun.id,
          status: latest.latestRun.status,
          requestedBy: latest.latestRun.requestedBy,
          updatedAt: new Date().toISOString()
        });
      }
      if (latest.pdfUrl) {
        setPdfUrl(latest.pdfUrl);
        setPdfCompiledAt(latest.pdfCompiledAt);
        callbacks.current.onPreviewTab("pdf");
      }
    }).catch((error) => {
      if (!isAbortError(error) && mainFileRef.current === mainFile) callbacks.current.onError(errorMessage(error));
    }).finally(() => {
      if (latestRequest.current === controller) latestRequest.current = null;
    });
    return () => controller.abort();
  }, [project?.id, projectId, mainFile]);

  useEffect(() => {
    if (!sharedState || sharedState.mainFile !== mainFile
      || (sharedState.status !== "succeeded" && sharedState.status !== "failed")) return;
    let cancelled = false;
    latestRequest.current?.abort();
    const controller = new AbortController();
    latestRequest.current = controller;
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
        void loadArtifacts(mainFile);
      } else if (sharedState.status === "failed") {
        callbacks.current.onPreviewTab(latest.latestRun.diagnostics.errors.length ? "errors" : "log");
      }
    }).catch((error) => {
      if (!isAbortError(error) && !cancelled) callbacks.current.onError(errorMessage(error));
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
      const result = await api<{ mainFile: string; ok: boolean; skipped?: boolean; log: string; diagnostics: CompileDiagnostics; pdfUrl: string | null; pdfCompiledAt: string | null }>(
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
    compileLog,
    compileDiagnostics,
    compileOutcome,
    artifacts,
    artifactPreview,
    artifactLoading,
    editorNotice,
    localCompiling: compilingMainFiles.has(mainFile),
    compile,
    viewArtifact
  };
}
