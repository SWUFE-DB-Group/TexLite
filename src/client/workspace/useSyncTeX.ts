import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PdfTarget } from "../PdfPreview";
import { errorMessage } from "../errors";

export interface SourceJump {
  path: string;
  line: number;
  column: number;
  nonce: number;
}

interface UseSyncTeXOptions {
  projectId: string;
  mainFile: string;
  activeFile: string;
  onActiveFile: (path: string) => void;
  onError: (message: string) => void;
  onShowPdf: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useSyncTeX({ projectId, mainFile, activeFile, onActiveFile, onError, onShowPdf }: UseSyncTeXOptions) {
  const [pdfTarget, setPdfTarget] = useState<PdfTarget | null>(null);
  const [pdfViewport, setPdfViewport] = useState<{ page: number; x: number; y: number } | null>(null);
  const [sourceJump, setSourceJump] = useState<SourceJump | null>(null);
  const request = useRef<AbortController | null>(null);
  const nonce = useRef(0);
  const activeFileRef = useRef(activeFile);
  const onActiveFileRef = useRef(onActiveFile);
  const onErrorRef = useRef(onError);
  const onShowPdfRef = useRef(onShowPdf);
  const isMainTeX = (path: string): boolean => path === mainFile && /\.tex$/i.test(path);
  activeFileRef.current = activeFile;
  onActiveFileRef.current = onActiveFile;
  onErrorRef.current = onError;
  onShowPdfRef.current = onShowPdf;

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setPdfTarget(null);
    setPdfViewport(null);
    setSourceJump(null);
    return () => request.current?.abort();
  }, [projectId, mainFile]);

  const jumpToSource = (path: string, line: number, column: number) => {
    setSourceJump({ path, line, column, nonce: ++nonce.current });
    if (activeFileRef.current !== path) onActiveFileRef.current(path);
  };

  const syncSourceToPdf = async (path: string, line: number, column: number, options: { silent?: boolean } = {}) => {
    // SyncTeX coordinates are produced for the selected root document. Do not
    // send requests for a secondary tab: it has no reliable PDF mapping in the
    // current preview and would otherwise produce confusing 400 responses.
    if (!isMainTeX(path)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const location = await api<{ page: number; x: number; y: number } | null>(
        `/api/projects/${projectId}/sync/pdf?mainFile=${encodeURIComponent(mainFile)}&path=${encodeURIComponent(path)}&line=${line}&column=${column}`,
        { signal: controller.signal }
      );
      if (request.current !== controller || !location) return;
      setPdfTarget({ ...location, nonce: ++nonce.current });
      onShowPdfRef.current();
    } catch (error) {
      if (!isAbortError(error) && !options.silent) onErrorRef.current(errorMessage(error));
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  const syncPdfToSource = async (page: number, x: number, y: number) => {
    // A PDF belongs to the active root document. While a secondary TeX file is
    // open, leave the cursor in that file instead of silently switching files
    // from a PDF click.
    if (!isMainTeX(activeFileRef.current)) return;
    const requestedFromFile = activeFileRef.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const location = await api<{ path: string; line: number; column: number }>(
        `/api/projects/${projectId}/sync/source?mainFile=${encodeURIComponent(mainFile)}&page=${page}&x=${x}&y=${y}`,
        { signal: controller.signal }
      );
      if (request.current !== controller || activeFileRef.current !== requestedFromFile || !isMainTeX(activeFileRef.current)) return;
      jumpToSource(location.path, location.line, location.column);
    } catch (error) {
      if (!isAbortError(error)) onErrorRef.current(errorMessage(error));
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  const syncVisiblePdfToSource = () => {
    if (pdfViewport) void syncPdfToSource(pdfViewport.page, pdfViewport.x, pdfViewport.y);
  };

  return {
    pdfTarget,
    pdfViewport,
    sourceJump,
    setPdfViewport,
    clearPdfViewport: () => setPdfViewport(null),
    jumpToSource,
    syncSourceToPdf,
    syncPdfToSource,
    syncVisiblePdfToSource
  };
}
