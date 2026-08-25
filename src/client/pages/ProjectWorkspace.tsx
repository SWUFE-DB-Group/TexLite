import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import type { CitationLibraryEntry, FileEntry, LatexCompletionIndex, Project, SiteConfig, User } from "../types";
import i18n from "../i18n";
import { AlertTriangle, GripVertical, LoaderCircle, X } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { loadEditorPreferences, saveEditorPreferences, type EditorPreferences } from "../editorPreferences";
import { createLatexTextEdits, formatWithTexFmt, isFormattableLatexFile, isTexFmtError, reindentLatexSelection, type TexFmtFailureKind } from "../latexFormatter";
import { BibtexFormatError, citationBibtexLimitLabel, formatBibtex, parseBibEntriesResult } from "../citationLibrary";
import { classifyCompileLog } from "../compileLog";
import type { CollaborationSaveReceipt, FormatLease } from "../collaboration";
import { errorMessage } from "../errors";
import type { WorkspaceLayout } from "../workspace/types";
import type { CompileCleanMode } from "../workspace/useProjectCompilation";
import { useProjectComments, type SourceSelection } from "../workspace/useProjectComments";
import { useProjectCollaboration } from "../workspace/useProjectCollaboration";
import { useProjectCompilation } from "../workspace/useProjectCompilation";
import { isEditableTextFile, parentFolders, pathContains, useProjectFiles } from "../workspace/useProjectFiles";
import { useSpellCheck } from "../workspace/useSpellCheck";
import { useSyncTeX } from "../workspace/useSyncTeX";
import { useWorkspaceLayout } from "../workspace/useWorkspaceLayout";
import type { SpellCheckIssue } from "../spellCheck";
import { loadPdfPreview, type WorkspacePreload } from "../workspacePreload";
import { hasDocumentClass as hasDocumentClassInSource } from "../latexRoot";
import { WorkspaceTopbar } from "../workspace/WorkspaceTopbar";
import { WorkspaceFilePanel } from "../workspace/WorkspaceFilePanel";
import { WorkspaceEditorPanel } from "../workspace/WorkspaceEditorPanel";
import { WorkspacePreviewPanel } from "../workspace/WorkspacePreviewPanel";
import { WorkspaceDialogs } from "../workspace/WorkspaceDialogs";
import { WorkspaceContextPanel } from "../workspace/WorkspaceContextPanel";
import type { DiagnosticTab, PreviewSurface, PreviewTab, ProjectOutlineItem } from "../workspace/types";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
type FormatterRecoveryAction = "file" | "selection";
interface FormatterRecovery { action: FormatterRecoveryAction; kind: TexFmtFailureKind; detail: string }
interface FormattedSource { formatted: string; diagnostics: string }
interface LoadOptions { signal?: AbortSignal; isCurrent?: () => boolean }

export function ProjectWorkspace({ site, user, projectId, preload, onBack }: {
  site: SiteConfig; user: User; projectId: string; preload: WorkspacePreload | null; onBack: () => void;
}) {
  const { t } = useTranslation();
  const [project, setProject] = useState<Project | null>(null);
  const [collaborationReady, setCollaborationReady] = useState(false);
  const [dictionaryWords, setDictionaryWords] = useState<string[]>([]);
  const [completionIndex, setCompletionIndex] = useState<LatexCompletionIndex | null>(null);
  const [projectOutline, setProjectOutline] = useState<ProjectOutlineItem[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [activeMainFile, setActiveMainFile] = useState("");
  const [rootDocuments, setRootDocuments] = useState<Set<string>>(new Set());
  const [content, setContent] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState("editor.saved");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const lastSavedAtRef = useRef(lastSavedAt);
  lastSavedAtRef.current = lastSavedAt;
  const [sourceCursor, setSourceCursor] = useState({ line: 1, column: 1 });
  const sourceCursorRef = useRef(sourceCursor);
  const sourceCursorOffsetRef = useRef(0);
  const [previewTab, setPreviewTab] = useState<PreviewSurface>("pdf");
  const [diagnosticTab, setDiagnosticTab] = useState<DiagnosticTab>("log");
  const selectPreviewTab = (next: PreviewTab | PreviewSurface): void => {
    if (next === "pdf") {
      setPreviewTab("pdf");
      return;
    }
    if (next === "diagnostics") {
      setPreviewTab("diagnostics");
      return;
    }
    setDiagnosticTab(next);
    setPreviewTab("diagnostics");
  };
  const { workspaceLayout, setWorkspaceLayout } = useWorkspaceLayout(user.id, projectId);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelectionState] = useState<SourceSelection>({ selectedText: "", startOffset: 0, endOffset: 0 });
  const selectionRef = useRef<SourceSelection>({ selectedText: "", startOffset: 0, endOffset: 0 });
  const setSelection = (next: SourceSelection): void => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  const [sidePanel, setSidePanel] = useState<"comments" | "settings" | null>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [citationLibraryOpen, setCitationLibraryOpen] = useState(false);
  const [cleanMode, setCleanMode] = useState<CompileCleanMode | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [formatterRecovery, setFormatterRecovery] = useState<FormatterRecovery | null>(null);
  const [formatterDiagnostics, setFormatterDiagnostics] = useState("");
  const [permissionDowngradeBusy, setPermissionDowngradeBusy] = useState(false);
  const [editorPreferences, setEditorPreferences] = useState<EditorPreferences>(() => loadEditorPreferences(user.id, projectId));
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openTabsRef = useRef<string[]>([]);
  openTabsRef.current = openTabs;
  const uploadInput = useRef<HTMLInputElement>(null);
  const filesPanel = useRef<ImperativePanelHandle>(null);
  const localEditSequence = useRef(0);
  const persistedEditSequence = useRef(0);
  const contentRef = useRef("");
  const activeFileRef = useRef("");
  const activeMainFileRef = useRef("");
  const projectLoadSequence = useRef(0);
  const completionRequest = useRef<AbortController | null>(null);
  const outlineRequest = useRef<AbortController | null>(null);
  const dictionaryRequest = useRef<AbortController | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const formattingRef = useRef(false);
  const formattingTaskRef = useRef<Promise<void> | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  activeMainFileRef.current = activeMainFile;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updateSourceCursor = (line: number, column: number, offset = 0) => {
    const next = { line, column };
    sourceCursorRef.current = next;
    sourceCursorOffsetRef.current = offset;
    setSourceCursor(next);
  };

  const updateOpenTabs = (updater: (current: string[]) => string[]) => {
    const current = openTabsRef.current;
    const next = updater(current);
    if (next === current) return;
    openTabsRef.current = next;
    setOpenTabs(next);
  };

  useEffect(() => {
    // ProjectWorkspace can stay mounted while the route changes. Never carry
    // tabs from the previous project into the new file tree.
    openTabsRef.current = [];
    setOpenTabs([]);
    setFormatterRecovery(null);
    setFormatterDiagnostics("");
  }, [projectId]);

  const closeTab = (tabPath: string) => {
    const current = openTabsRef.current;
    const index = current.indexOf(tabPath);
    if (index < 0) return;
    const nextTabs = current.filter((p) => p !== tabPath);
    openTabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    if (activeFileRef.current !== tabPath) return;
    const nextActive = nextTabs.length > 0
      ? nextTabs[Math.min(index, nextTabs.length - 1)]
      : project?.mainFile ?? "";
    setActiveFile(nextActive);
  };

  const {
    collaboration,
    status: collaborationStatus,
    synced: collaborationSynced,
    activeSessions,
    formatLeaseStates,
    compileState,
    setCompileState,
    filesEvent,
    commentsRevision,
    dictionaryRevision,
    localDraftReady,
    permission: collaborationPermission,
    reconnect: reconnectCollaboration,
    protocolUpgradeRequired,
    permissionDowngrade,
    dismissPermissionDowngrade,
    discardLocalDraft
  } = useProjectCollaboration(projectId, user, activeMainFile, project?.permission ?? "read", collaborationReady, () => setSaveState("editor.offlineDraft"));

  const {
    pdfTarget, pdfViewport, sourceJump, setPdfViewport, clearPdfViewport,
    jumpToSource, syncSourceToPdf, syncPdfToSource, syncVisiblePdfToSource
  } = useSyncTeX({
    projectId,
    mainFile: activeMainFile,
    activeFile,
    onActiveFile: setActiveFile,
    onError: setError,
    onShowPdf: () => selectPreviewTab("pdf")
  });

  const spellCheck = useSpellCheck({
    active: Boolean(project && activeFile && collaborationSynced && editorPreferences.spellCheck),
    projectId,
    activeFile,
    content,
    dictionaryWords
  });

  useEffect(() => {
    setEditorPreferences(loadEditorPreferences(user.id, projectId));
  }, [user.id, projectId]);

  const updateEditorContent = (next: string) => {
    contentRef.current = next;
    setContent(next);
  };

  useEffect(() => {
    activeFileRef.current = activeFile;
    sourceCursorRef.current = { line: 1, column: 1 };
    sourceCursorOffsetRef.current = 0;
    setSourceCursor({ line: 1, column: 1 });
    setSelection({ selectedText: "", startOffset: 0, endOffset: 0 });
    if (!editorPreferences.openFilesInTabs) {
      if (openTabsRef.current.length > 0) {
        openTabsRef.current = [];
        setOpenTabs([]);
      }
      return;
    }
    if (activeFile) {
      updateOpenTabs((current) => current.includes(activeFile) ? current : [...current, activeFile]);
    }
  }, [activeFile, editorPreferences.openFilesInTabs, projectId]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (collaborationStatus !== "disconnected") return;
    const controller = new AbortController();
    void api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal })
      .then(({ project: currentProject }) => {
        if (!controller.signal.aborted) {
          setProject(currentProject);
          setError("");
        }
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setError(errorMessage(error));
          onBackRef.current();
          return;
        }
        setError(t("errors.collaborationUnavailable"));
      });
    return () => controller.abort();
  }, [collaborationStatus, projectId, t]);

  const loadCompletionIndex = async (options: LoadOptions = {}) => {
    completionRequest.current?.abort();
    completionRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) completionRequest.current = controller;
    try {
      const result = await api<{ index: LatexCompletionIndex }>(`/api/projects/${projectId}/completions`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setCompletionIndex(result.index);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!options.isCurrent || options.isCurrent()) setCompletionIndex(null);
    } finally {
      if (controller && completionRequest.current === controller) completionRequest.current = null;
    }
  };
  const loadProjectOutline = async (options: LoadOptions = {}, mainFile = activeMainFileRef.current) => {
    outlineRequest.current?.abort();
    outlineRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) outlineRequest.current = controller;
    try {
      const query = mainFile ? `?mainFile=${encodeURIComponent(mainFile)}` : "";
      const result = await api<{ outline: ProjectOutlineItem[] }>(`/api/projects/${projectId}/outline${query}`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setProjectOutline(result.outline);
    } catch (error) {
      if (!isAbortError(error) && (!options.isCurrent || options.isCurrent())) setProjectOutline([]);
    } finally {
      if (controller && outlineRequest.current === controller) outlineRequest.current = null;
    }
  };
  const loadDictionary = async (options: LoadOptions = {}) => {
    dictionaryRequest.current?.abort();
    dictionaryRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) dictionaryRequest.current = controller;
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setDictionaryWords(result.words);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!options.isCurrent || options.isCurrent()) setDictionaryWords([]);
    } finally {
      if (controller && dictionaryRequest.current === controller) dictionaryRequest.current = null;
    }
  };
  useEffect(() => {
    let cancelled = false;
    const sequence = ++projectLoadSequence.current;
    const controller = new AbortController();
    const isCurrent = () => !cancelled && projectLoadSequence.current === sequence;
    let projectLoaded = false;
    setProject(null); setFiles([]); setProjectOutline([]); setActiveFile(""); setActiveMainFile(""); setRootDocuments(new Set()); setContent(""); setLoadedFile(""); setCompileState(null);
    clearPdfViewport(); setCompletionIndex(null); setDictionaryWords([]);
    void loadPdfPreview();
    const projectRequest = (preload?.projectId === projectId
      ? preload.project
      : api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal })).then((result) => {
      if (!isCurrent()) return;
      projectLoaded = true;
      setProject(result.project);
      setActiveFile(result.project.mainFile);
      setActiveMainFile(result.project.mainFile);
      setRootDocuments(new Set());
      setExpandedFolders(new Set(parentFolders(result.project.mainFile)));
    }).catch((e) => { if (isCurrent()) setError(errorMessage(e)); });
    const filesLoadRequest = api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`, { signal: controller.signal })
      .then((result) => { if (isCurrent()) setFiles(result.files); })
      .catch((e) => { if (isCurrent()) setError(errorMessage(e)); });
    let deferredTimer: number | null = null;
    void Promise.allSettled([projectRequest, filesLoadRequest]).then(() => {
      if (!isCurrent() || !projectLoaded) return;
      // Completion indexing reads the whole project. Let the critical editor
      // and retained-PDF requests finish and paint before starting these.
      deferredTimer = window.setTimeout(() => {
        if (!isCurrent()) return;
        void Promise.all([
          loadCompletionIndex({ signal: controller.signal, isCurrent }),
          loadDictionary({ signal: controller.signal, isCurrent })
        ]);
      }, 0);
    });
    return () => {
      cancelled = true;
      if (deferredTimer !== null) window.clearTimeout(deferredTimer);
      controller.abort();
      completionRequest.current?.abort(); completionRequest.current = null;
      outlineRequest.current?.abort(); outlineRequest.current = null;
      dictionaryRequest.current?.abort(); dictionaryRequest.current = null;
      refreshRequest.current?.abort(); refreshRequest.current = null;
    };
  }, [projectId, preload]);

  useEffect(() => {
    if (dictionaryRevision) void loadDictionary();
  }, [dictionaryRevision, projectId]);

  useEffect(() => {
    if (!project || collaborationStatus !== "connected" || collaborationPermission === project.permission) return;
    // A server-side member update can change an already-open editor from edit
    // to read-only without waiting for the next API request.
    setProject((current) => current ? { ...current, permission: collaborationPermission } : current);
  }, [collaborationPermission, project?.permission]);

  useEffect(() => {
    if (!filesEvent) return;
    const deletedActiveFile = filesEvent.kind === "delete" && Boolean(filesEvent.path)
      && pathContains(filesEvent.path!, activeFileRef.current);
    const deletedCompileTarget = filesEvent.kind === "delete" && Boolean(filesEvent.path)
      && pathContains(filesEvent.path!, activeMainFileRef.current);
    if (filesEvent.kind === "move" && filesEvent.source && filesEvent.destination) {
      const source = filesEvent.source;
      const destination = filesEvent.destination;
      const remap = (value: string) => value === source
        ? destination
        : value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
      setActiveFile((current) => remap(current));
      setActiveMainFile((current) => remap(current));
      setRootDocuments((current) => new Set([...current].map(remap)));
      setSelectedFolder((current) => current ? remap(current) : current);
      updateOpenTabs((current) => current.map(remap));
    }
    if (deletedActiveFile) {
      setActiveFile("");
      setLoadedFile("");
      updateEditorContent("");
      setNotice(t("editor.fileDeletedByCollaborator", { path: filesEvent.path }));
    }
    if (filesEvent.kind === "delete" && filesEvent.path) {
      setRootDocuments((current) => new Set([...current].filter((filePath) => !pathContains(filesEvent.path!, filePath))));
      setSelectedFolder((current) => pathContains(filesEvent.path!, current) ? "" : current);
      setResourcePreview((current) => current && pathContains(filesEvent.path!, current.path) ? null : current);
      updateOpenTabs((current) => current.filter((filePath) => !pathContains(filesEvent.path!, filePath)));
    }
    refreshRequest.current?.abort();
    const controller = new AbortController();
    refreshRequest.current = controller;
    void Promise.all([
      loadFiles({ signal: controller.signal }),
      api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal })
    ]).then(([nextFiles, projectResult]) => {
      setProject(projectResult.project);
      if (deletedCompileTarget) setActiveMainFile(projectResult.project.mainFile);
      if (deletedActiveFile && nextFiles) {
        const fallback = nextFiles.find((entry) => entry.type === "file" && entry.path === projectResult.project.mainFile)
          ?? nextFiles.find((entry) => entry.type === "file" && isEditableTextFile(entry.path));
        setActiveFile(fallback?.path ?? "");
      }
      void loadCompletionIndex({ signal: controller.signal });
      void loadProjectOutline({ signal: controller.signal }, deletedCompileTarget ? projectResult.project.mainFile : activeMainFileRef.current);
    }).catch((error) => { if (!isAbortError(error)) return; })
      .finally(() => { if (refreshRequest.current === controller) refreshRequest.current = null; });
  }, [filesEvent?.revision]);

  useEffect(() => {
    collaboration.setActiveFile(activeFile);
    if (!activeFile) return;
    setLoadedFile(""); setSaveState("editor.loading");
    const sharedText = collaboration.getText(activeFile);
    const updateContent = (_event?: unknown, transaction?: { local: boolean }) => {
      updateEditorContent(sharedText.toString());
      setLoadedFile(activeFile);
      if (transaction?.local && project?.permission !== "read") {
        localEditSequence.current += 1;
        setDirty(true);
        setSaveState("editor.pending");
      } else if (localEditSequence.current <= persistedEditSequence.current) {
        setSaveState(lastSavedAtRef.current ? "editor.savedAt" : "editor.saved");
      }
    };
    sharedText.observe(updateContent);
    if (collaborationSynced || localDraftReady) updateContent();
    return () => {
      sharedText.unobserve(updateContent);
    };
  }, [activeFile, collaboration, collaborationSynced, localDraftReady, project?.permission]);

  const persistPendingEdits = async (): Promise<CollaborationSaveReceipt> => {
    if (!collaborationSynced) throw new Error("Collaboration is not synchronized");
    const sequence = localEditSequence.current;
    const receipt = await collaboration.flush();
    persistedEditSequence.current = Math.max(persistedEditSequence.current, sequence);
    setLastSavedAt(receipt.persistedAt);
    if (/\.tex$/i.test(activeFileRef.current)) void loadProjectOutline();
    if (localEditSequence.current === sequence) {
      setDirty(false);
      setSaveState("editor.savedAt");
    } else {
      setSaveState("editor.pending");
    }
    return receipt;
  };

  useEffect(() => {
    if (!dirty || !activeFile) return;
    if (!collaborationSynced) {
      setSaveState("editor.offlineDraft");
      return;
    }
    setSaveState("editor.pending");
    const timer = window.setTimeout(() => {
      setSaveState("editor.saving");
      void persistPendingEdits().catch(() => {
        setSaveState(collaboration.connected ? "editor.saveFailed" : "editor.offlineDraft");
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [content, dirty, activeFile, collaborationSynced]);

  const save = async (): Promise<boolean> => {
    if (!project || project.permission === "read" || !collaborationSynced || !activeFile) return false;
    setSaveState("editor.saving");
    try {
      await persistPendingEdits();
      void loadCompletionIndex();
      return true;
    } catch (saveError) {
      setSaveState("editor.saveFailed");
      setError(errorMessage(saveError) || t("errors.collaborationUnavailable"));
      return false;
    }
  };
  const formatSource = async (filePath: string, source: string, texFmtConfig = editorPreferences.texFmtConfig): Promise<FormattedSource> => {
    if (/\.bib$/i.test(filePath)) {
      try {
        return { formatted: formatBibtex(source, site.maxCitationBibtexBytes), diagnostics: "" };
      } catch (formatError) {
        if (!(formatError instanceof BibtexFormatError)) throw formatError;
        if (formatError.kind === "too-large") {
          throw new Error(t("citationLibrary.fileTooLarge", { size: citationBibtexLimitLabel(site.maxCitationBibtexBytes) }));
        }
        throw new Error(t("citationLibrary.fileInvalid"));
      }
    }
    const result = await formatWithTexFmt(source, texFmtConfig);
    return { formatted: result.output, diagnostics: result.logs.trim() };
  };
  const formatCurrentFile = async (texFmtConfig?: string): Promise<void> => {
    if (!project || project.permission === "read" || !collaborationSynced || formattingRef.current
      || !isFormattableLatexFile(activeFileRef.current)) return;
    const filePath = activeFileRef.current;
    const sharedText = collaboration.getText(filePath);
    formattingRef.current = true;
    setFormatting(true);
    let finishFormattingTask: () => void = () => {};
    const formattingTask = new Promise<void>((resolve) => { finishFormattingTask = resolve; });
    formattingTaskRef.current = formattingTask;
    setFormatterDiagnostics("");
    let lease: FormatLease | null = null;
    try {
      // Acquire before taking the source snapshot. Other formatters queue on
      // this file, while ordinary Yjs editing remains available.
      lease = await collaboration.acquireFormatLease(filePath);
      const source = sharedText.toString();
      const { formatted, diagnostics } = await formatSource(filePath, source, texFmtConfig);
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        setError(t("editor.formatSourceChanged"));
        return;
      }
      // Renew before the potentially expensive diff. The formatter and diff
      // each have their own timeout, so a single initial lease could expire
      // before the final apply confirmation.
      await lease.confirm();
      const edits = await createLatexTextEdits(source, formatted);
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        setError(t("editor.formatSourceChanged"));
        return;
      }
      await lease.confirm();
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        setError(t("editor.formatSourceChanged"));
        return;
      }
      if (edits.length) collaboration.applyTextEdits(filePath, edits);
      if (edits.length) await persistPendingEdits();
      setFormatterRecovery(null);
      setFormatterDiagnostics(diagnostics);
      setError("");
      setNotice(t("editor.formatFileComplete"));
    } catch (formatError) {
      if (isTexFmtError(formatError)) {
        setFormatterRecovery({ action: "file", kind: formatError.kind, detail: formatError.message });
        setError("");
      } else setError(t("editor.formatFileFailed", { message: errorMessage(formatError) }));
    } finally {
      if (lease) await lease.release();
      formattingRef.current = false;
      setFormatting(false);
      finishFormattingTask();
      if (formattingTaskRef.current === formattingTask) formattingTaskRef.current = null;
    }
  };
  const formatBeforeCompile = async (): Promise<void> => {
    if (!editorPreferences.formatOnCompile || !project || project.permission === "read"
      || !collaborationSynced || !isFormattableLatexFile(activeFileRef.current) || formattingRef.current) return;
    const filePath = activeFileRef.current;
    const sharedText = collaboration.getText(filePath);
    formattingRef.current = true;
    setFormatting(true);
    setFormatterDiagnostics("");
    let lease: FormatLease | null = null;
    try {
      lease = await collaboration.acquireFormatLease(filePath);
      const source = sharedText.toString();
      const { formatted, diagnostics } = await formatSource(filePath, source);
      await lease.confirm();
      const edits = await createLatexTextEdits(source, formatted);
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        throw new Error(t("editor.formatSourceChanged"));
      }
      await lease.confirm();
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        throw new Error(t("editor.formatSourceChanged"));
      }
      if (edits.length) collaboration.applyTextEdits(filePath, edits);
      // Keep the lease until the formatter's Yjs update is durable. The
      // compile save that follows may still issue its normal idempotent flush.
      if (edits.length) await collaboration.flush();
      setFormatterRecovery(null);
      setFormatterDiagnostics(diagnostics);
    } catch (formatError) {
      if (isTexFmtError(formatError)) {
        setFormatterRecovery({ action: "file", kind: formatError.kind, detail: formatError.message });
        setError("");
      } else setError(t("editor.formatFailedContinue", { message: errorMessage(formatError) }));
    } finally {
      if (lease) await lease.release();
      formattingRef.current = false;
      setFormatting(false);
    }
  };
  const saveForCompile = async (): Promise<boolean> => {
    if (formattingTaskRef.current) await formattingTaskRef.current;
    await formatBeforeCompile();
    return save();
  };
  const formatSelectedSource = async (texFmtConfig?: string): Promise<void> => {
    if (!project || project.permission === "read" || !collaborationSynced || formattingRef.current
      || !isFormattableLatexFile(activeFileRef.current)) return;
    const currentSelection = selectionRef.current;
    if (!currentSelection.selectedText.trim()) {
      setNotice(t("editor.formatSelectionRequired"));
      return;
    }
    const filePath = activeFileRef.current;
    const { startOffset, endOffset, selectedText } = currentSelection;
    const sharedText = collaboration.getText(filePath);
    if (sharedText.toString().slice(startOffset, endOffset) !== selectedText) {
      setError(t("editor.formatSelectionChanged"));
      return;
    }
    formattingRef.current = true;
    setFormatting(true);
    let finishFormattingTask: () => void = () => {};
    const formattingTask = new Promise<void>((resolve) => { finishFormattingTask = resolve; });
    formattingTaskRef.current = formattingTask;
    setFormatterDiagnostics("");
    let lease: FormatLease | null = null;
    try {
      lease = await collaboration.acquireFormatLease(filePath);
      const source = sharedText.toString();
      if (source.slice(startOffset, endOffset) !== selectedText) {
        setError(t("editor.formatSelectionChanged"));
        return;
      }
      const result = await formatSource(filePath, selectedText, texFmtConfig);
      const formatted = reindentLatexSelection(selectedText, result.formatted);
      await lease.confirm();
      const edits = await createLatexTextEdits(selectedText, formatted, startOffset);
      if (activeFileRef.current !== filePath || sharedText.toString().slice(startOffset, endOffset) !== selectedText) {
        setError(t("editor.formatSelectionChanged"));
        return;
      }
      await lease.confirm();
      if (activeFileRef.current !== filePath || sharedText.toString().slice(startOffset, endOffset) !== selectedText) {
        setError(t("editor.formatSelectionChanged"));
        return;
      }
      if (edits.length) collaboration.applyTextEdits(filePath, edits);
      if (edits.length) await persistPendingEdits();
      setFormatterRecovery(null);
      setFormatterDiagnostics(result.diagnostics);
      setError("");
      setNotice(t("editor.formatSelectionComplete"));
    } catch (formatError) {
      if (isTexFmtError(formatError)) {
        setFormatterRecovery({ action: "selection", kind: formatError.kind, detail: formatError.message });
        setError("");
      } else setError(t("editor.formatFailed", { message: errorMessage(formatError) }));
    } finally {
      if (lease) await lease.release();
      formattingRef.current = false;
      setFormatting(false);
      finishFormattingTask();
      if (formattingTaskRef.current === formattingTask) formattingTaskRef.current = null;
    }
  };
  const insertCitationAtCursor = (entry: CitationLibraryEntry): boolean => {
    const filePath = activeFileRef.current;
    if (!/\.bib$/i.test(filePath) || project?.permission === "read" || !collaborationSynced) {
      setNotice(t("citationLibrary.importRequiresWrite"));
      return false;
    }
    const sharedText = collaboration.getText(filePath);
    const source = sharedText.toString();
    const parsedBibtex = parseBibEntriesResult(source, site.maxCitationBibtexBytes);
    if (parsedBibtex.status === "too-large") {
      setNotice(t("citationLibrary.fileTooLarge", { size: citationBibtexLimitLabel(site.maxCitationBibtexBytes) }));
      return false;
    }
    if (parsedBibtex.status === "invalid") {
      setNotice(t("citationLibrary.fileInvalid"));
      return false;
    }
    if (parsedBibtex.entries.some((item) => item.citationKey.toLowerCase() === entry.citationKey.toLowerCase())) {
      setNotice(t("citationErrors.alreadyInFile", { key: entry.citationKey }));
      return false;
    }
    const offset = Math.max(0, Math.min(source.length, sourceCursorOffsetRef.current));
    const before = source.slice(0, offset);
    const after = source.slice(offset);
    const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    collaboration.applyTextEdits(filePath, [{ from: offset, to: offset, replacement: `${prefix}${entry.bibtex.trim()}${suffix}` }]);
    setNotice(t("citationLibrary.imported", { key: entry.citationKey }));
    return true;
  };
  const {
    files, setFiles, loadFiles,
    newFileOpen, setNewFileOpen, newFilePath, setNewFilePath,
    resourcePreview, setResourcePreview, resourcePreviewLoading, setResourcePreviewLoading,
    newFolderOpen, setNewFolderOpen, newFolderName, setNewFolderName,
    fileDialogError, setFileDialogError,
    selectedFolder, setSelectedFolder,
    expandedFolders, setExpandedFolders,
    moveEntry, setMoveEntry, moveName, setMoveName, moveDestination, setMoveDestination,
    deleteEntry, setDeleteEntry,
    fileDragActive, setFileDragActive,
    uploadConflict, setUploadConflict, uploadingFiles,
    directoryEntries, visibleEntries,
    createFile, createFolder, uploadFiles, upload, openFile, movePath, removePath
  } = useProjectFiles({
    projectId,
    site,
    activeFile,
    dirty,
    save,
    onError: setError,
    onProject: setProject,
    onActiveFile: setActiveFile,
    onActiveMainFile: setActiveMainFile,
    onRootDocuments: setRootDocuments
  });

  useEffect(() => {
    if (!activeFile || loadedFile !== activeFile || !activeFile.toLocaleLowerCase().endsWith(".tex")) return;
    const texFileCount = files.filter((entry) => entry.type === "file" && /\.tex$/i.test(entry.path)).length;
    if (texFileCount === 0) return;
    const configuredRoot = activeFile === project?.mainFile;
    const detectedRoot = hasDocumentClassInSource(content);
    const isRoot = detectedRoot || texFileCount === 1;
    setRootDocuments((current) => {
      if (current.has(activeFile) === isRoot) return current;
      const next = new Set(current);
      if (isRoot) next.add(activeFile);
      else next.delete(activeFile);
      return next;
    });
    if (isRoot && !configuredRoot && activeMainFileRef.current !== activeFile) {
      setActiveMainFile(activeFile);
    } else if (!isRoot && activeMainFileRef.current === activeFile && project?.mainFile) {
      setActiveMainFile(project.mainFile);
    }
  }, [activeFile, loadedFile, content, files, project?.mainFile]);

  useEffect(() => {
    if (!editorPreferences.openFilesInTabs || files.length === 0) return;
    const existingFiles = new Set(files.filter((entry) => entry.type === "file" && isEditableTextFile(entry.path)).map((entry) => entry.path));
    updateOpenTabs((current) => {
      const next = current.filter((filePath) => existingFiles.has(filePath));
      return next.length === current.length ? current : next;
    });
  }, [files, editorPreferences.openFilesInTabs]);
  const {
    comments, focusComment, setFocusComment, commentOpen, setCommentOpen, commentText, setCommentText,
    addComment, toggleComment, replyToComment, editComment, deleteComment, editCommentReply, deleteCommentReply
  } = useProjectComments({
    projectId,
    activeFile,
    permission: project?.permission,
    revision: commentsRevision,
    selection,
    save,
    onError: setError,
    onAdded: () => setSidePanel("comments")
  });
  const {
    pdfUrl, pdfCompiledAt, pdfLoadingMode, pdfLoading, compileLog, compileDiagnostics, compileOutcome,
    artifacts, artifactPreview, artifactLoading, editorNotice, localCompiling, cancelling, cleaning,
    compile, cancelCompile, cleanCompile, viewArtifact
  } = useProjectCompilation({
    projectId,
    project,
    mainFile: activeMainFile,
    initialLatest: preload?.projectId === projectId ? preload.latestCompile : null,
    collaborationSynced,
    sharedState: compileState,
    onSharedState: setCompileState,
    save: saveForCompile,
    loadOutline: (signal, mainFile) => loadProjectOutline({ signal }, mainFile),
    onPreviewTab: selectPreviewTab,
    onError: setError,
    onCompileStart: () => { setError(""); setNotice(""); },
    onCompileSuccess: () => {
      const path = activeFileRef.current;
      if (path) void syncSourceToPdf(path, sourceCursorRef.current.line, sourceCursorRef.current.column, { silent: true });
    },
    onPdfChanged: clearPdfViewport
  });
  useEffect(() => {
    // Let the latest-PDF response render PdfPreview first. Its PDF request is
    // the critical path; only then should a cold Yjs room be reconstructed.
    if (!project || !activeMainFile || (!pdfUrl && pdfLoading)) return;
    // Give the browser a short scheduling head start for the PDF fetch before
    // opening the WebSocket that may trigger a cold room reconstruction.
    const timer = window.setTimeout(() => setCollaborationReady(true), pdfUrl ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [project, pdfLoading, pdfUrl]);
  useEffect(() => {
    const openNavigation = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!event.shiftKey && event.key.toLocaleLowerCase() === "p") {
        event.preventDefault(); setQuickOpen(true);
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault(); setProjectSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openNavigation, true);
    return () => window.removeEventListener("keydown", openNavigation, true);
  }, []);
  const updateEditorPreferences = (next: EditorPreferences) => {
    setEditorPreferences(next); saveEditorPreferences(user.id, projectId, next);
  };
  const retryFormatter = (resetOptions = false): void => {
    const recovery = formatterRecovery;
    if (!recovery) return;
    setFormatterRecovery(null);
    setFormatterDiagnostics("");
    setError("");
    if (resetOptions) updateEditorPreferences({ ...editorPreferences, texFmtConfig: "" });
    const configOverride = resetOptions ? "" : undefined;
    if (recovery.action === "selection") void formatSelectedSource(configOverride);
    else void formatCurrentFile(configOverride);
  };
  const discardPermissionDraft = async (): Promise<void> => {
    setPermissionDowngradeBusy(true);
    try {
      const discarded = await discardLocalDraft();
      if (!discarded) {
        setError(t("editor.collaboration.permissionDowngradeOtherTabBlocked"));
        setPermissionDowngradeBusy(false);
      }
    } catch (draftError) {
      setError(errorMessage(draftError));
      setPermissionDowngradeBusy(false);
    }
  };
  const toggleFilesPanel = () => {
    if (filesPanel.current?.isCollapsed()) filesPanel.current.expand();
    else filesPanel.current?.collapse();
  };
  const outline = useMemo(() => projectOutline.length
    ? projectOutline
    : parseOutline(content).map((item) => ({ ...item, path: activeFile })), [projectOutline, content, activeFile]);
  const compileMessages = useMemo(() => classifyCompileLog(compileLog, compileOutcome), [compileLog, compileOutcome]);
  const showEditor = workspaceLayout !== "pdf-only";
  const showPreview = workspaceLayout !== "editor-only";
  const changeWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (next === "pdf-only") selectPreviewTab("pdf");
  };
  const deleteActiveSessions = deleteEntry
    ? activeSessions.filter((session) => session.filePath && pathContains(deleteEntry.path, session.filePath))
    : [];
  if (!project) return <div className="center-card"><p>{error || t("common.loading")}</p>{error && <button className="primary" onClick={onBack}>{t("editor.backToProjects")}</button>}</div>;
  const readOnly = project.permission === "read" || !collaborationSynced;
  const activeFormatLease = formatLeaseStates.find((lease) => lease.path === activeFile);
  // The lease state deliberately has no durable user/session identity. Show
  // it whenever this browser is not the formatter currently holding it; this
  // also explains a second tab belonging to the same account.
  const remoteFormatLease = activeFormatLease && !formatting ? activeFormatLease : null;
  const replaceSpellCheckIssue = (issue: SpellCheckIssue, replacement: string): void => {
    if (readOnly) return;
    const filePath = activeFileRef.current;
    if (!filePath) return;
    const sharedText = collaboration.getText(filePath);
    const source = sharedText.toString();
    if (source.slice(issue.from, issue.to) !== issue.word) {
      setError(t("editor.spellCheckSourceChanged"));
      return;
    }
    try {
      collaboration.applyTextEdits(filePath, [{ from: issue.from, to: issue.to, replacement }]);
    } catch (replaceError) {
      setError(errorMessage(replaceError));
    }
  };
  const sharedCompiling = compileState?.mainFile === activeMainFile
    && (compileState.status === "queued" || compileState.status === "running");
  const compileBusy = localCompiling || sharedCompiling || cleaning;
  const collaborativeText = activeFile ? collaboration.getText(activeFile) : null;
  const pdfCompiledLabel = pdfCompiledAt ? new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }) : "";
  const pdfTargetLabel = activeMainFile.split("/").at(-1) ?? activeMainFile;
  const diagnosticCount = compileMessages.warnings.length + compileMessages.errors.length + artifacts.length;
  const pdfDownloadUrl = pdfUrl ? `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}download=1` : "";
  const syncMainFile = activeMainFile || project.mainFile;
  const canSyncWithPdf = Boolean(activeFile && activeFile === syncMainFile && /\.tex$/i.test(activeFile));
  const activateTab = (tabPath: string): void => {
    const entry = files.find((file) => file.path === tabPath);
    if (entry && isEditableTextFile(entry.path)) openFile(entry);
    else closeTab(tabPath);
  };
  const focusTab = (tabPath: string): void => {
    document.getElementById(`editor-tab-${encodeURIComponent(tabPath)}`)?.focus();
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? openTabs.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + openTabs.length) % openTabs.length;
    const nextPath = openTabs[nextIndex];
    if (!nextPath) return;
    activateTab(nextPath);
    window.requestAnimationFrame(() => focusTab(nextPath));
  };
  const compileStatusMessage = compileBusy
    ? sharedCompiling
      ? compileState?.status === "queued" ? t("editor.compileQueued") : t("editor.compilingBy", { name: compileState?.requestedBy.name ?? t("common.user") })
      : t("editor.compiling")
    : compileOutcome === "failed"
      ? pdfUrl && pdfCompiledAt
        ? t("editor.compileFailedRetained", { time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) })
        : t("editor.compileFailedNoPdf")
      : compileOutcome === "cancelled"
        ? t("compileControls.cancelled")
      : "";
  const saveStateLabel = saveState === "editor.savedAt" && lastSavedAt
    ? t("editor.savedAt", { time: new Date(lastSavedAt).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
    : t(saveState);

  return <div className="workspace">
    <WorkspaceTopbar
      site={site} project={project} activeFile={activeFile} saveStateLabel={saveStateLabel}
      editorPreferences={editorPreferences} activeSessions={activeSessions} collaborationStatus={collaborationStatus}
      reconnectCollaboration={reconnectCollaboration} protocolUpgradeRequired={protocolUpgradeRequired} showEditor={showEditor} filesCollapsed={filesCollapsed}
      toggleFilesPanel={toggleFilesPanel} workspaceLayout={workspaceLayout} changeWorkspaceLayout={changeWorkspaceLayout}
      onBack={onBack} onShare={() => setShareOpen(true)} showCitationLibrary={showEditor && /\.bib$/i.test(activeFile)}
      citationLibraryOpen={citationLibraryOpen} onCitationLibrary={() => setCitationLibraryOpen(true)}
      onHistory={() => setHistoryOpen(true)} onGit={() => setGitOpen(true)} canManageGit={project.ownerId === user.id}
      formatting={formatting} canFormat={isFormattableLatexFile(activeFile)} readOnly={readOnly} collaborationSynced={collaborationSynced}
      activeFormatLease={Boolean(activeFormatLease)} onFormatFile={() => void formatCurrentFile()}
      onFormatSelection={() => void formatSelectedSource()} hasSelection={Boolean(selection.selectedText.trim())}
      onAddComment={() => setCommentOpen(true)} onToggleComments={() => setSidePanel(sidePanel === "comments" ? null : "comments")}
      commentsOpen={sidePanel === "comments"} unresolvedCommentCount={comments.filter((item) => !item.resolved).length}
      hasActiveFile={Boolean(activeFile)} onToggleSettings={() => setSidePanel(sidePanel === "settings" ? null : "settings")}
      settingsOpen={sidePanel === "settings"} compileBusy={compileBusy} sharedCompiling={sharedCompiling}
      localCompiling={localCompiling} cancelling={cancelling} compileState={compileState} onCompile={compile} onCancelCompile={() => void cancelCompile()}
    />
    {protocolUpgradeRequired && <div className="workspace-update-banner" role="alert">
      <AlertTriangle size={15} />
      <span>{t("workspaceUpdates.protocolUpgrade")}</span>
      <button type="button" onClick={() => window.location.reload()}>{t("common.reload")}</button>
    </div>}
    {compileStatusMessage && <div className={`compile-status-strip${compileOutcome === "failed" ? " failed" : ""}`} role="status" aria-live="polite"><LoaderCircle className={compileBusy ? "spin" : ""} size={14} /><span>{compileStatusMessage}</span></div>}
    {(spellCheck.error || formatterRecovery || formatterDiagnostics || remoteFormatLease) && <div className="client-tool-recoveries">
      {spellCheck.error && <div className="client-tool-recovery" role="alert" title={spellCheck.error}><AlertTriangle size={15} /><span><strong>{t("editor.harperRecoveryTitle")}</strong>{t("editor.harperFallbackHint")}</span><div className="client-tool-recovery-actions"><button type="button" onClick={spellCheck.retry}>{t("common.retry")}</button></div><button type="button" className="formatter-diagnostics-dismiss" title={t("common.close")} aria-label={t("common.close")} onClick={spellCheck.dismissError}><X size={13} /></button></div>}
      {formatterRecovery && <div className="client-tool-recovery" role="alert" title={formatterRecovery.detail}><AlertTriangle size={15} /><span><strong>{t(formatterRecovery.kind === "format" ? "editor.texFmtOptionsRecoveryTitle" : formatterRecovery.kind === "load" ? "editor.texFmtRecoveryTitle" : "editor.texFmtRuntimeRecoveryTitle")}</strong>{t("editor.clientToolRecoveryHint")}</span><div className="client-tool-recovery-actions"><button type="button" disabled={formatting || readOnly} onClick={() => retryFormatter()}>{t("common.retry")}</button>{formatterRecovery.kind === "format" && editorPreferences.texFmtConfig.trim() && <button type="button" disabled={formatting || readOnly} onClick={() => retryFormatter(true)}>{t("editor.resetFormatterOptions")}</button>}<button type="button" onClick={() => window.location.reload()}>{t("common.reload")}</button></div><button type="button" className="formatter-diagnostics-dismiss" title={t("common.close")} aria-label={t("common.close")} onClick={() => setFormatterRecovery(null)}><X size={13} /></button></div>}
      {formatterDiagnostics && <div className="client-tool-recovery formatter-diagnostics" role="status"><AlertTriangle size={15} /><span><strong>{t("editor.texFmtDiagnosticsTitle")}</strong>{t("editor.texFmtDiagnosticsHint")}</span><details><summary>{t("editor.viewFormatterDiagnostics")}</summary><pre>{formatterDiagnostics}</pre></details><button type="button" className="formatter-diagnostics-dismiss" title={t("editor.dismissFormatterDiagnostics")} aria-label={t("editor.dismissFormatterDiagnostics")} onClick={() => setFormatterDiagnostics("")}><X size={13} /></button></div>}
      {remoteFormatLease && <div className="client-tool-recovery format-lease-status" role="status"><LoaderCircle className="spin" size={15} /><span>{t("editor.formattingBy", { name: remoteFormatLease.holderName })}</span></div>}
    </div>}
    {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    {notice && <div className="toast success" onClick={() => setNotice("")}>{notice}</div>}
    <PanelGroup autoSaveId="texlite-workspace-layout" direction="horizontal" className="work-grid">
      {showEditor && <WorkspaceFilePanel
        project={project} filesPanel={filesPanel} files={files} visibleEntries={visibleEntries}
        activeFile={activeFile} activeMainFile={activeMainFile} rootDocuments={rootDocuments}
        selectedFolder={selectedFolder} expandedFolders={expandedFolders} fileDragActive={fileDragActive}
        uploadingFiles={uploadingFiles} readOnly={readOnly} editorFontSize={editorPreferences.fontSize}
        outline={outline} sourceCursor={sourceCursor} uploadInput={uploadInput}
        setSelectedFolder={setSelectedFolder} setExpandedFolders={setExpandedFolders}
        setMoveEntry={setMoveEntry} setMoveName={setMoveName} setMoveDestination={setMoveDestination}
        setDeleteEntry={setDeleteEntry} setFileDialogError={setFileDialogError}
        setNewFolderName={setNewFolderName} setNewFolderOpen={setNewFolderOpen}
        setNewFilePath={setNewFilePath} setNewFileOpen={setNewFileOpen}
        setQuickOpen={setQuickOpen} setProjectSearchOpen={setProjectSearchOpen}
        setFileDragActive={setFileDragActive} setFilesCollapsed={setFilesCollapsed} toggleFilesPanel={toggleFilesPanel}
        uploadFiles={uploadFiles} upload={upload} openFile={openFile}
        jumpToSource={jumpToSource} syncSourceToPdf={syncSourceToPdf}
      />}
      {showEditor && <PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle>}
      {showEditor && <WorkspaceEditorPanel
        project={project} activeFile={activeFile} activeMainFile={activeMainFile} openTabs={openTabs}
        content={content} loadedFile={loadedFile} readOnly={readOnly} comments={comments}
        focusComment={focusComment} editorPreferences={editorPreferences} completionIndex={completionIndex}
        nativeSpellCheck={spellCheck.nativeFallback} spellCheckIssues={spellCheck.issues}
        spellCheckJump={spellCheck.jump} sourceJump={sourceJump} collaborativeText={collaborativeText}
        collaborationAwareness={collaboration.awareness} undoManager={activeFile ? collaboration.getUndoManager(activeFile) : undefined}
        editorNotice={editorNotice} activateTab={activateTab} closeTab={closeTab}
        handleTabKeyDown={handleTabKeyDown} updateEditorContent={updateEditorContent}
        setSelection={(selectedText, startOffset, endOffset) => setSelection({ selectedText, startOffset, endOffset })}
        onCommentClick={(id) => { const comment = comments.find((item) => item.id === id); if (comment) { setFocusComment({ ...comment }); setSidePanel("comments"); } }}
        onSpellCheckReplace={replaceSpellCheckIssue} onCursor={updateSourceCursor}
      />}
      {showPreview && <WorkspacePreviewPanel
        projectId={projectId} activeMainFile={activeMainFile} previewTab={previewTab} diagnosticTab={diagnosticTab}
        pdfUrl={pdfUrl} pdfLoadingMode={pdfLoadingMode} pdfLoading={pdfLoading} pdfCompiledAt={pdfCompiledAt}
        pdfCompiledLabel={pdfCompiledLabel} pdfTargetLabel={pdfTargetLabel} pdfDownloadUrl={pdfDownloadUrl}
        pdfTarget={pdfTarget} pdfViewport={pdfViewport} activeFile={activeFile} sourceCursor={sourceCursor}
        compileBusy={compileBusy} compileLog={compileLog} compileDiagnostics={compileDiagnostics}
        compileMessages={compileMessages} artifacts={artifacts}
        artifactPreview={artifactPreview} artifactLoading={artifactLoading} cleaning={cleaning}
        readOnly={readOnly} collaborationSynced={collaborationSynced} workspaceLayout={workspaceLayout} showSyncResize={showEditor && showPreview}
        diagnosticCount={diagnosticCount} selectPreviewTab={selectPreviewTab}
        changeWorkspaceLayout={changeWorkspaceLayout} onSetNotice={setNotice} onSetPdfViewport={setPdfViewport}
        syncVisiblePdfToSource={syncVisiblePdfToSource} syncSourceToPdf={syncSourceToPdf}
        syncPdfToSource={syncPdfToSource} canSyncWithPdf={canSyncWithPdf} files={files}
        jumpToSource={jumpToSource} onSetCleanMode={setCleanMode} cleanCompile={cleanCompile}
        viewArtifact={viewArtifact}
      />}
      <WorkspaceContextPanel
        sidePanel={sidePanel} onClose={() => setSidePanel(null)} project={project} projectId={projectId}
        site={site} files={files} currentUserId={user.id} comments={comments}
        onFocusComment={(comment) => setFocusComment({ ...comment })} onToggleComment={toggleComment}
        onReplyComment={replyToComment} onEditComment={editComment} onDeleteComment={deleteComment}
        onEditCommentReply={editCommentReply} onDeleteCommentReply={deleteCommentReply}
        dictionaryWords={dictionaryWords} onDictionaryChange={setDictionaryWords}
        editorPreferences={editorPreferences} onEditorPreferences={updateEditorPreferences}
        spellCheckCount={spellCheck.summary?.total ?? null} spellCheckUniqueCount={spellCheck.summary?.unique ?? null}
        spellCheckIndex={spellCheck.summary ? spellCheck.index : -1} onSpellCheckNavigate={spellCheck.jumpToIssue}
        onProject={setProject}
      />
    </PanelGroup>
    <WorkspaceDialogs
      user={user} project={project} projectId={projectId} activeFile={activeFile}
      content={content} maxCitationBibtexBytes={site.maxCitationBibtexBytes} files={files} directoryEntries={directoryEntries} readOnly={readOnly}
      workspaceLayout={workspaceLayout} changeWorkspaceLayout={changeWorkspaceLayout}
      resourcePreview={resourcePreview} resourcePreviewLoading={resourcePreviewLoading}
      setResourcePreview={setResourcePreview} setResourcePreviewLoading={setResourcePreviewLoading}
      uploadConflict={uploadConflict} setUploadConflict={setUploadConflict} uploadFiles={uploadFiles}
      cleanMode={cleanMode} setCleanMode={setCleanMode} cleanCompile={cleanCompile}
      newFileOpen={newFileOpen} setNewFileOpen={setNewFileOpen} newFilePath={newFilePath}
      setNewFilePath={setNewFilePath} newFolderOpen={newFolderOpen} setNewFolderOpen={setNewFolderOpen}
      newFolderName={newFolderName} setNewFolderName={setNewFolderName} selectedFolder={selectedFolder}
      fileDialogError={fileDialogError} setFileDialogError={setFileDialogError}
      createFile={createFile} createFolder={createFolder} moveEntry={moveEntry}
      setMoveEntry={setMoveEntry} moveName={moveName} setMoveName={setMoveName}
      moveDestination={moveDestination} setMoveDestination={setMoveDestination} movePath={movePath}
      deleteEntry={deleteEntry} setDeleteEntry={setDeleteEntry} deleteActiveSessions={deleteActiveSessions}
      removePath={removePath} commentOpen={commentOpen} setCommentOpen={setCommentOpen}
      selection={selection} commentText={commentText} setCommentText={setCommentText} addComment={addComment}
      shareOpen={shareOpen} setShareOpen={setShareOpen} citationLibraryOpen={citationLibraryOpen}
      setCitationLibraryOpen={setCitationLibraryOpen} insertCitationAtCursor={insertCitationAtCursor}
      quickOpen={quickOpen} setQuickOpen={setQuickOpen} projectSearchOpen={projectSearchOpen}
      setProjectSearchOpen={setProjectSearchOpen} openFile={openFile} jumpToSource={jumpToSource}
      historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} gitOpen={gitOpen} setGitOpen={setGitOpen}
      save={save} permissionDowngrade={permissionDowngrade} permissionDowngradeBusy={permissionDowngradeBusy}
      dismissPermissionDowngrade={dismissPermissionDowngrade} discardPermissionDraft={discardPermissionDraft}
    />
  </div>;
}



function parseOutline(content: string): Array<{ level: number; title: string; line: number }> {
  const result: Array<{ level: number; title: string; line: number }> = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/;
  const levels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
  content.split("\n").forEach((line, index) => {
    const match = line.match(pattern);
    if (match) result.push({ level: levels[match[1]], title: match[2], line: index + 1 });
  });
  return result;
}
