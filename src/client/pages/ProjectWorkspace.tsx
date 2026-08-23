import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import type { CitationLibraryEntry, FileEntry, LatexCompletionIndex, Project, SiteConfig, User } from "../types";
import i18n from "../i18n";
import {
  AlertTriangle, AlignLeft, ArrowLeft, BookMarked, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Download, Eraser, FileArchive, FilePlus2, FileText, Keyboard,
  FileSearch, Folder, FolderOpen, FolderPlus, GitBranch, GripVertical, ListTree, LoaderCircle, MessageSquare, PackageOpen,
  Move, PanelLeftClose, PanelLeftOpen, Pencil, Play, RefreshCw, ScrollText,
  Search, Settings, Trash2, Upload, Users, X, XCircle
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { loadEditorPreferences, saveEditorPreferences, type EditorPreferences } from "../editorPreferences";
import { createLatexTextEdits, formatWithTexFmt, isFormattableLatexFile, isTexFmtError, reindentLatexSelection, type TexFmtFailureKind } from "../latexFormatter";
import { BibtexFormatError, formatBibtex, MAX_CITATION_BIBTEX_BYTES, parseBibEntriesResult } from "../citationLibrary";
import { classifyCompileLog } from "../compileLog";
import type { CollaborationSaveReceipt, FormatLease } from "../collaboration";
import { errorMessage } from "../errors";
import type { WorkspaceLayout } from "../workspace/types";
import { CollaborationPresence, WorkspaceLayoutMenu } from "../workspace/WorkspaceChrome";
import { CommentThread, ShareDialog } from "../workspace/Comments";
import { ProjectSettings } from "../workspace/ProjectSettings";
import { CompileArtifacts, CompileCleanup, CompileDiagnosticOutput, CompileOutput } from "../workspace/CompileOutput";
import type { CompileCleanMode } from "../workspace/useProjectCompilation";
import { useProjectComments, type SourceSelection } from "../workspace/useProjectComments";
import { useProjectCollaboration } from "../workspace/useProjectCollaboration";
import { useProjectCompilation } from "../workspace/useProjectCompilation";
import { isEditableTextFile, parentFolders, pathContains, useProjectFiles } from "../workspace/useProjectFiles";
import { useSpellCheck } from "../workspace/useSpellCheck";
import { useSyncTeX } from "../workspace/useSyncTeX";
import { useWorkspaceLayout } from "../workspace/useWorkspaceLayout";
import type { SpellCheckIssue } from "../spellCheck";
import { CitationLibraryDialog } from "../CitationLibraryDialog";
import { loadPdfPreview, type WorkspacePreload } from "../workspacePreload";
import { hasDocumentClass as hasDocumentClassInSource } from "../latexRoot";
import { SiteLogo } from "./SiteChrome";

const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));
const LatexEditor = lazy(() => import("../LatexEditor").then((module) => ({ default: module.LatexEditor })));
const GitDialog = lazy(() => import("../GitDialog").then((module) => ({ default: module.GitDialog })));
const HistoryDialog = lazy(() => import("../HistoryDialog").then((module) => ({ default: module.HistoryDialog })));
const ProjectSearchDialog = lazy(() => import("../ProjectNavigationDialogs").then((module) => ({ default: module.ProjectSearchDialog })));
const QuickOpenDialog = lazy(() => import("../ProjectNavigationDialogs").then((module) => ({ default: module.QuickOpenDialog })));

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts" | "clean";
type PreviewSurface = "pdf" | "diagnostics";
type DiagnosticTab = Exclude<PreviewTab, "pdf">;
type FormatterRecoveryAction = "file" | "selection";
interface FormatterRecovery { action: FormatterRecoveryAction; kind: TexFmtFailureKind; detail: string }
interface FormattedSource { formatted: string; diagnostics: string }
interface ProjectOutlineItem { path: string; line: number; level: number; title: string }
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
  const selectPreviewTab = (next: PreviewTab): void => {
    if (next === "pdf") {
      setPreviewTab("pdf");
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
        return { formatted: formatBibtex(source), diagnostics: "" };
      } catch (formatError) {
        if (!(formatError instanceof BibtexFormatError)) throw formatError;
        if (formatError.kind === "too-large") {
          throw new Error(t("citationLibrary.fileTooLarge", { size: `${Math.round(MAX_CITATION_BIBTEX_BYTES / 1024)} KB` }));
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
    const parsedBibtex = parseBibEntriesResult(source);
    if (parsedBibtex.status === "too-large") {
      setNotice(t("citationLibrary.fileTooLarge", { size: `${Math.round(MAX_CITATION_BIBTEX_BYTES / 1024)} KB` }));
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
    artifacts, artifactPreview, artifactLoading, editorNotice, localCompiling, cleaning,
    compile, cleanCompile, viewArtifact
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
      : "";
  const saveStateLabel = saveState === "editor.savedAt" && lastSavedAt
    ? t("editor.savedAt", { time: new Date(lastSavedAt).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
    : t(saveState);

  return <div className="workspace">
    <header className="editor-topbar">
      <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button><a className="brand-link compact-brand-link" href="/" aria-label={site.siteName} onClick={(event) => { event.preventDefault(); onBack(); }}><SiteLogo siteName={site.siteName} compact /></a>
      <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {saveStateLabel}</small></div>
      {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
      <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
      {collaborationStatus === "disconnected" && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
      <div className="editor-actions">
        {showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}
        <WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} />
        <button onClick={() => setShareOpen(true)}><Users size={15} />{t("projectSettings.share")}</button>
        {showEditor && /\.bib$/i.test(activeFile) && <button className={citationLibraryOpen ? "active" : ""} onClick={() => setCitationLibraryOpen(true)}><BookMarked size={15} />{t("citationLibrary.title")}</button>}
        <div className="version-action" role="group" aria-label={t("common.version")}>
          <div className="version-action-label"><GitBranch size={14} /><span>{t("common.version")}</span></div>
          <div className="version-action-options">
            <button type="button" className="version-action-history" title={t("history.title")} onClick={() => setHistoryOpen(true)}>{t("history.title")}</button>
            <button type="button" className="version-action-git" title={project.ownerId === user.id ? t("git.title") : t("git.ownerOnly")} disabled={project.ownerId !== user.id} onClick={() => setGitOpen(true)}>Git</button>
          </div>
        </div>
        {showEditor && project.permission !== "read" && isFormattableLatexFile(activeFile) && <div className="format-action" role="group" aria-label={t("editor.format")} aria-busy={formatting}>
          <div className="format-action-label"><AlignLeft size={14} /><span>{t("editor.format")}</span></div>
          <div className="format-action-options">
            <button type="button" className="format-action-file" title={t("editor.formatFileHint")} onMouseDown={(event) => event.preventDefault()} onClick={() => void formatCurrentFile()} disabled={readOnly || formatting || Boolean(activeFormatLease) || !collaborationSynced}>{t("editor.formatFile")}</button>
            <button type="button" className="format-action-selected" title={selection.selectedText.trim() ? t("editor.formatSelection") : t("editor.formatSelectionHint")} onMouseDown={(event) => event.preventDefault()} onClick={() => void formatSelectedSource()} disabled={readOnly || formatting || Boolean(activeFormatLease) || !collaborationSynced || !selection.selectedText.trim()}>{t("editor.formatSelected")}</button>
          </div>
        </div>}
        <div className="comments-action" role="group" aria-label={t("common.comments")}>
          <div className="comments-action-label"><MessageSquare size={14} /><span>{t("common.comments")}</span></div>
          <div className="comments-action-options">
            <button type="button" className="comments-action-add" title={t("editor.addComment")} aria-label={t("editor.addComment")} onMouseDown={(event) => event.preventDefault()} onClick={() => setCommentOpen(true)} disabled={!activeFile}>{t("editor.commentsAdd")}</button>
            <button type="button" className={`comments-action-all${sidePanel === "comments" ? " active" : ""}`} title={t("editor.commentsAll")} onClick={() => setSidePanel(sidePanel === "comments" ? null : "comments")}>{t("editor.commentsAll")} {comments.filter((item) => !item.resolved).length || ""}</button>
          </div>
        </div>
        <button className={sidePanel === "settings" ? "active" : ""} onClick={() => setSidePanel(sidePanel === "settings" ? null : "settings")}><Settings size={15} />{t("common.settings")}</button>
        <button className="compile" title={sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : t("editor.compileShortcut")} onClick={compile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : localCompiling ? t("editor.compiling") : t("editor.compile", { engine: project.engine })}</button>
      </div>
    </header>
    {compileStatusMessage && <div className={`compile-status-strip${compileOutcome === "failed" ? " failed" : ""}`} role="status" aria-live="polite"><LoaderCircle className={compileBusy ? "spin" : ""} size={14} /><span>{compileStatusMessage}</span></div>}
    {(spellCheck.error || formatterRecovery || formatterDiagnostics || remoteFormatLease) && <div className="client-tool-recoveries">
      {spellCheck.error && <div className="client-tool-recovery" role="alert" title={spellCheck.error}><AlertTriangle size={15} /><span><strong>{t("editor.harperRecoveryTitle")}</strong>{t("editor.harperFallbackHint")}</span><div className="client-tool-recovery-actions"><button type="button" onClick={spellCheck.retry}>{t("common.retry")}</button></div><button type="button" className="formatter-diagnostics-dismiss" title={t("common.close")} aria-label={t("common.close")} onClick={spellCheck.dismissError}><X size={13} /></button></div>}
      {formatterRecovery && <div className="client-tool-recovery" role="alert" title={formatterRecovery.detail}><AlertTriangle size={15} /><span><strong>{t(formatterRecovery.kind === "format" ? "editor.texFmtOptionsRecoveryTitle" : formatterRecovery.kind === "load" ? "editor.texFmtRecoveryTitle" : "editor.texFmtRuntimeRecoveryTitle")}</strong>{t("editor.clientToolRecoveryHint")}</span><div className="client-tool-recovery-actions"><button type="button" disabled={formatting || readOnly} onClick={() => retryFormatter()}>{t("common.retry")}</button>{formatterRecovery.kind === "format" && editorPreferences.texFmtConfig.trim() && <button type="button" disabled={formatting || readOnly} onClick={() => retryFormatter(true)}>{t("editor.resetFormatterOptions")}</button>}<button type="button" onClick={() => window.location.reload()}>{t("common.reload")}</button></div><button type="button" className="formatter-diagnostics-dismiss" title={t("common.close")} aria-label={t("common.close")} onClick={() => setFormatterRecovery(null)}><X size={13} /></button></div>}
      {formatterDiagnostics && <div className="client-tool-recovery formatter-diagnostics" role="status"><AlertTriangle size={15} /><span><strong>{t("editor.texFmtDiagnosticsTitle")}</strong>{t("editor.texFmtDiagnosticsHint")}</span><details><summary>{t("editor.viewFormatterDiagnostics")}</summary><pre>{formatterDiagnostics}</pre></details><button type="button" className="formatter-diagnostics-dismiss" title={t("editor.dismissFormatterDiagnostics")} aria-label={t("editor.dismissFormatterDiagnostics")} onClick={() => setFormatterDiagnostics("")}><X size={13} /></button></div>}
      {remoteFormatLease && <div className="client-tool-recovery format-lease-status" role="status"><LoaderCircle className="spin" size={15} /><span>{t("editor.formattingBy", { name: remoteFormatLease.holderName })}</span></div>}
    </div>}
    {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    {notice && <div className="toast success" onClick={() => setNotice("")}>{notice}</div>}
    {permissionDowngrade && <Modal
      open
      title={t("editor.collaboration.permissionDowngradeTitle")}
      description={permissionDowngrade.localDraftReady && permissionDowngrade.otherTabDraft
        ? t("editor.collaboration.permissionDowngradeMultipleDrafts")
        : permissionDowngrade.otherTabDraft
          ? t("editor.collaboration.permissionDowngradeOtherTab")
          : permissionDowngrade.localDraftReady
        ? t("editor.collaboration.permissionDowngradeDescription", {
          previous: t("common.readWrite")
        })
        : t("editor.collaboration.permissionDowngradeNoDraft")}
      onOpenChange={(open) => { if (!open && !permissionDowngradeBusy) dismissPermissionDowngrade(); }}
      footer={<>
        <button type="button" disabled={permissionDowngradeBusy} onClick={dismissPermissionDowngrade}>{permissionDowngrade.localDraftReady ? t("editor.collaboration.permissionDowngradeKeep") : t("common.close")}</button>
        {!permissionDowngrade.otherTabDraft && <button type="button" className="danger" disabled={permissionDowngradeBusy} onClick={() => void discardPermissionDraft()}>{permissionDowngradeBusy ? <LoaderCircle className="spin" size={14} /> : permissionDowngrade.localDraftReady ? <Trash2 size={14} /> : <RefreshCw size={14} />}{permissionDowngrade.localDraftReady ? t("editor.collaboration.permissionDowngradeDiscard") : t("editor.collaboration.permissionDowngradeReload")}</button>}
      </>}
    ><div /></Modal>}
    <PanelGroup autoSaveId="texlite-workspace-layout" direction="horizontal" className="work-grid">
      {showEditor && <Panel id="files" order={1} ref={filesPanel} defaultSize={16} minSize={12} maxSize={30} collapsible collapsedSize={0} onCollapse={() => setFilesCollapsed(true)} onExpand={() => setFilesCollapsed(false)}>
        <aside className="left-panel"><section className={`files-panel${fileDragActive ? " drop-active" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!readOnly && !uploadingFiles) setFileDragActive(true); }} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = readOnly || uploadingFiles ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setFileDragActive(false); if (!readOnly && !uploadingFiles) void uploadFiles(Array.from(event.dataTransfer.files)); }}><div className="panel-title"><span>{t("common.files")}</span><span className="file-tools"><button aria-label={t("navigation.quickOpen")} title={`${t("navigation.quickOpen")} (Ctrl/Cmd+P)`} onClick={() => setQuickOpen(true)}><FileSearch size={15} /></button><button aria-label={t("navigation.projectSearch")} title={`${t("navigation.projectSearch")} (Ctrl/Cmd+Shift+F)`} onClick={() => setProjectSearchOpen(true)}><Search size={15} /></button>{!readOnly && <><button disabled={uploadingFiles} aria-label={t("editor.uploadAttachment")} title={t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })} onClick={() => uploadInput.current?.click()}><Upload size={15} /></button><button aria-label={t("editor.newFolder")} title={t("editor.newFolder")} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={15} /></button><button aria-label={t("editor.newFile")} title={t("editor.newFile")} onClick={() => { setNewFilePath(selectedFolder ? `${selectedFolder}/` : ""); setNewFileOpen(true); }}><FilePlus2 size={15} /></button><input ref={uploadInput} type="file" multiple hidden onChange={(event) => void upload(event)} /></>}<button aria-label={t("editor.collapseFiles")} title={t("editor.collapseFiles")} onClick={toggleFilesPanel}><PanelLeftClose size={15} /></button></span></div>
          {fileDragActive && <div className="file-drop-overlay"><Upload size={24} /><strong>{t("editor.dropFiles")}</strong><span>{t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })}</span></div>}
          <div className="file-list" style={{ fontSize: `${editorPreferences.fontSize}px` }}><div className={`file-entry folder-entry root-entry${selectedFolder === "" ? " selected" : ""}`}><button className="file-entry-main" onClick={() => setSelectedFolder("")}><FolderOpen size={15} /><span>{t("editor.projectRoot")}</span></button></div>{visibleEntries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const name = entry.path.split("/").at(-1);
            const expanded = expandedFolders.has(entry.path);
            const rootDocument = rootDocuments.has(entry.path);
            const compileTarget = activeMainFile === entry.path;
            const canDelete = entry.path !== project.mainFile && !project.mainFile.startsWith(`${entry.path}/`);
            if (entry.type === "directory") return <div className={`file-entry folder-entry${selectedFolder === entry.path ? " selected" : ""}`} style={{ paddingLeft: `${depth * 13 + 5}px` }} key={entry.path}><button className="file-entry-main" title={entry.path} onClick={() => { setSelectedFolder(entry.path); setExpandedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span></button>{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
            return <div className={`file-entry${activeFile === entry.path ? " active" : ""}${rootDocument ? " root-document" : ""}${compileTarget ? " compile-target" : ""}`} style={{ paddingLeft: `${depth * 13 + 18}px` }} key={entry.path}><button className="file-entry-main" title={compileTarget ? t("editor.currentMainDocument", { path: entry.path }) : rootDocument ? t("editor.mainDocumentCandidate", { path: entry.path }) : entry.path} onClick={() => openFile(entry)}>{rootDocument ? <BookOpen size={13} /> : <FileText size={13} />}<span>{name}</span>{compileTarget && <small>{t("editor.currentMainShort")}</small>}</button>{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
          })}</div></section>
          <section className="outline-panel"><div className="panel-title"><span><ListTree size={14} />{t("common.outline")}</span></div><div className="outline">{outline.map((item, i) => <button className={`outline-item${activeFile === item.path && sourceCursor.line === item.line ? " current" : ""}`} key={`${item.path}-${item.line}-${i}`} title={`${item.path}:${item.line}`} onClick={() => { jumpToSource(item.path, item.line, 1); void syncSourceToPdf(item.path, item.line, 1); }}><span className="outline-guides" aria-hidden style={{ width: `${item.level * 12}px` }} /><small>{item.path === activeFile ? item.line : item.path.split("/").at(-1)}</small><span className="outline-title">{item.title}</span></button>)}{outline.length === 0 && <p className="muted padded">{t("editor.noOutline")}</p>}</div></section>
        </aside>
      </Panel>}
      {showEditor && <PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle>}
      {showEditor && <Panel id="source" order={2} defaultSize={42} minSize={22}>
        <main className="source-panel">
          {editorPreferences.openFilesInTabs && openTabs.length > 0 && (
            <div className="editor-tabs-bar" role="tablist" aria-label={t("editor.openFiles")}>
              <div className="editor-tabs-scroll">
                {openTabs.map((tabPath, index) => {
                  const isActive = tabPath === activeFile;
                  const isMain = tabPath === (activeMainFile || project.mainFile);
                  const fileName = tabPath.split("/").at(-1) || tabPath;
                  return (
                    <div className={`editor-tab-item${isActive ? " active" : ""}`} role="presentation" key={tabPath}>
                      <button
                      id={`editor-tab-${encodeURIComponent(tabPath)}`}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls="editor-source-content"
                      tabIndex={isActive ? 0 : -1}
                      className={`editor-tab${isActive ? " active" : ""}${isMain ? " main-tab" : ""}`}
                      onClick={() => activateTab(tabPath)}
                      onKeyDown={(event) => handleTabKeyDown(event, index)}
                      title={tabPath}
                    >
                      <span className="editor-tab-icon">
                        {isMain ? <BookOpen size={13} /> : <FileText size={13} />}
                      </span>
                      <span className="editor-tab-title">{fileName}</span>
                      {isMain && <small className="editor-tab-badge">{t("editor.currentMainShort")}</small>}
                    </button>
                    <button
                      type="button"
                      className="editor-tab-close"
                      title={t("common.close")}
                      aria-label={`${t("common.close")} ${fileName}`}
                      onClick={() => closeTab(tabPath)}
                    >
                      <X size={12} />
                    </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div id="editor-source-content" className="editor-content-container">
            <Suspense fallback={<div className="preview-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
              <LatexEditor key={activeFile} value={content} filePath={activeFile} readOnly={readOnly} comments={comments} focusComment={focusComment} preferences={editorPreferences} nativeSpellCheck={spellCheck.nativeFallback} completionIndex={completionIndex} spellCheckIssues={spellCheck.issues} spellCheckJump={spellCheck.jump} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={0} collaboration={collaborativeText ? { text: collaborativeText, awareness: collaboration.awareness, undoManager: readOnly ? undefined : collaboration.getUndoManager(activeFile) } : undefined} onChange={updateEditorContent} onSelection={(selectedText, startOffset, endOffset) => setSelection({ selectedText, startOffset, endOffset })} onCommentClick={(id) => { const comment = comments.find((item) => item.id === id); if (comment) { setFocusComment({ ...comment }); setSidePanel("comments"); } }} onSpellCheckReplace={replaceSpellCheckIssue} onCursor={updateSourceCursor} />
            </Suspense>
            {editorNotice && <div className="editor-centered-notice" role="status" aria-live="polite">{editorNotice}</div>}
          </div>
        </main>
      </Panel>}
      {showEditor && showPreview && <PanelResizeHandle className="resize-handle sync-resize-handle"><GripVertical className="resize-grip" size={12} /><span className="sync-direction-buttons" onPointerDown={(event) => event.stopPropagation()}><button disabled={!pdfViewport || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInSource") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInSource")} onClick={() => { if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } syncVisiblePdfToSource(); }}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInPdf") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInPdf")} onClick={() => { if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } void syncSourceToPdf(activeFile, sourceCursor.line, sourceCursor.column); }}><span aria-hidden>→</span></button></span></PanelResizeHandle>}
      {showPreview && <Panel id="preview" order={3} defaultSize={42} minSize={22}>
        <section className="preview-panel">
          <div className="preview-tabs">
            <div className="preview-tab-list" role="tablist" aria-label={t("editor.outputTabs")}>
              <button role="tab" aria-selected={previewTab === "pdf"} className={`pdf-tab${previewTab === "pdf" ? " active" : ""}`} onClick={() => selectPreviewTab("pdf")} title={pdfCompiledAt ? t("editor.pdfCompiledAtFor", { file: activeMainFile, time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) }) : t("editor.currentMainDocument", { path: activeMainFile })}><FileText size={16} /><span className="pdf-tab-label">PDF · {pdfTargetLabel}{pdfCompiledLabel && <small>{pdfCompiledLabel}</small>}</span></button>
              <button role="tab" aria-selected={previewTab === "diagnostics"} className={`diagnostics-tab${previewTab === "diagnostics" ? " active" : ""}`} onClick={() => setPreviewTab("diagnostics")}><ScrollText size={14} />{t("editor.outputTabs")}<span>{diagnosticCount}</span></button>
            </div>
            {pdfDownloadUrl && <a className="pdf-download-top" href={pdfDownloadUrl} download title={t("editor.downloadPdf")} aria-label={t("editor.downloadPdf")}><Download size={15} /><span>{t("editor.downloadPdf")}</span></a>}
          </div>
          {previewTab === "diagnostics" && <div className="preview-subtabs" role="tablist" aria-label={t("editor.outputTabs")}>
            <button role="tab" aria-selected={diagnosticTab === "log"} className={diagnosticTab === "log" ? "active" : ""} onClick={() => selectPreviewTab("log")}><ScrollText size={13} />{t("editor.log")}</button>
            <button role="tab" aria-selected={diagnosticTab === "warnings"} className={diagnosticTab === "warnings" ? "active" : ""} onClick={() => selectPreviewTab("warnings")}><AlertTriangle size={13} />{t("editor.warnings")}<span>{compileMessages.warnings.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "errors"} className={diagnosticTab === "errors" ? "active" : ""} onClick={() => selectPreviewTab("errors")}><XCircle size={13} />{t("editor.errors")}<span>{compileMessages.errors.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "artifacts"} className={diagnosticTab === "artifacts" ? "active" : ""} onClick={() => selectPreviewTab("artifacts")}><PackageOpen size={13} />{t("editor.artifacts")}<span>{artifacts.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "clean"} className={diagnosticTab === "clean" ? "active" : ""} onClick={() => selectPreviewTab("clean")}><Eraser size={13} />{t("editor.clean")}</button>
          </div>}
          <div className={`preview-content preview-${previewTab} ${previewTab === "diagnostics" ? `preview-${diagnosticTab}` : ""}`}>
            {previewTab === "pdf" && (pdfUrl ? <Suspense fallback={<div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}><PdfPreview url={pdfUrl} loadingMode={pdfLoadingMode} target={pdfTarget} compiling={compileBusy} onViewportLocation={(page, x, y) => setPdfViewport({ page, x, y })} onDoubleClickLocation={(page, x, y) => { setPdfViewport({ page, x, y }); if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } void syncPdfToSource(page, x, y); }} /></Suspense> : pdfLoading ? <div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div> : <div className="preview-empty"><FileText size={28} /><strong>{t("editor.preview")}</strong><span>{t("editor.previewHint")}</span></div>)}
            {previewTab === "diagnostics" && diagnosticTab === "log" && <CompileOutput lines={compileLog ? compileLog.split("\n") : []} empty={localCompiling ? t("editor.compiling") : t("editor.noLog")} />}
            {previewTab === "diagnostics" && diagnosticTab === "warnings" && (compileDiagnostics
              ? <CompileDiagnosticOutput tone="warning" diagnostics={compileDiagnostics.warnings} files={files} empty={t("editor.noWarnings")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} />
              : <CompileOutput tone="warning" lines={compileMessages.warnings} empty={t("editor.noWarnings")} />)}
            {previewTab === "diagnostics" && diagnosticTab === "errors" && (compileDiagnostics
              ? <CompileDiagnosticOutput tone="error" diagnostics={compileDiagnostics.errors} files={files} empty={t("editor.noErrors")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} />
              : <CompileOutput tone="error" lines={compileMessages.errors} empty={t("editor.noErrors")} />)}
            {previewTab === "diagnostics" && diagnosticTab === "artifacts" && <CompileArtifacts projectId={projectId} mainFile={activeMainFile} artifacts={artifacts} preview={artifactPreview} loading={artifactLoading} onView={(artifact) => void viewArtifact(artifact)} />}
            {previewTab === "diagnostics" && diagnosticTab === "clean" && <CompileCleanup mainFile={activeMainFile} disabled={readOnly || !collaborationSynced || compileBusy} cleaning={cleaning} onCleanCache={() => setCleanMode("cache")} onCleanArtifacts={() => setCleanMode("artifacts")} />}
          </div>
        </section>
      </Panel>}
      {sidePanel && <><PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle><Panel id="context" order={4} defaultSize={20} minSize={15} maxSize={38}><aside className="context-panel"><div className="drawer-title"><strong>{sidePanel === "comments" ? t("editor.sourceComments") : t("editor.projectSettings")}</strong><button aria-label={t("common.close")} onClick={() => setSidePanel(null)}><X size={17} /></button></div>
          {sidePanel === "comments" && <div className="comments">{comments.map((comment) => <CommentThread key={comment.id} comment={comment} currentUserId={user.id} onFocus={() => setFocusComment({ ...comment })} onToggle={() => void toggleComment(comment)} onReply={(content) => replyToComment(comment, content)} onEdit={(content) => editComment(comment, content)} onDelete={() => deleteComment(comment)} onEditReply={(replyId, content) => editCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => deleteCommentReply(comment, replyId)} />)}{comments.length === 0 && <p className="muted padded">{t("editor.noComments")}</p>}</div>}
          {sidePanel === "settings" && <ProjectSettings project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={setDictionaryWords} editorPreferences={editorPreferences} onEditorPreferences={updateEditorPreferences} spellCheckCount={spellCheck.summary?.total ?? null} spellCheckUniqueCount={spellCheck.summary?.unique ?? null} spellCheckIndex={spellCheck.summary ? spellCheck.index : -1} onSpellCheckNavigate={spellCheck.jumpToIssue} onProject={setProject} />}
        </aside></Panel></>}
    </PanelGroup>
    <Modal open={Boolean(resourcePreview)} extraWide={resourcePreview?.kind === "image" || resourcePreview?.kind === "pdf" || resourcePreview?.kind === "text"} title={resourcePreview?.path ?? ""} description={resourcePreview?.kind === "large" ? t("editor.resourceTooLarge", { size: formatFileSize(resourcePreview.size), limit: "10 MB" }) : t(`editor.resourcePreview.${resourcePreview?.kind ?? "text"}`)} onOpenChange={(open) => { if (!open) { setResourcePreview(null); setResourcePreviewLoading(false); } }} footer={resourcePreview && <a className="primary resource-download" href={`${resourcePreview.url}&download=1`} download><Download size={14} />{t("editor.downloadResource")}</a>}>
      {resourcePreview?.kind === "large" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceTooLargeTitle")}</strong><span>{t("editor.resourceTooLargeDescription")}</span></div>}
      {resourcePreview?.kind === "unsupported" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceUnsupportedTitle")}</strong><span>{t("editor.resourceUnsupportedDescription")}</span></div>}
      {resourcePreview?.kind === "image" && <div className="resource-image-wrap"><img className="resource-image" src={resourcePreview.url} alt={resourcePreview.path} /></div>}
      {resourcePreview?.kind === "pdf" && <iframe className="resource-pdf" src={resourcePreview.url} title={resourcePreview.path} />}
      {resourcePreview?.kind === "text" && (resourcePreviewLoading ? <div className="resource-preview-message"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div> : <pre className="resource-text">{resourcePreview.content}</pre>)}
    </Modal>
    <ConfirmDialog open={Boolean(uploadConflict)} title={t("editor.uploadOverwriteTitle")} description={t("editor.uploadOverwriteDescription", { files: uploadConflict?.collisions.join(", ") ?? "" })} confirmLabel={t("editor.uploadOverwrite")} danger onCancel={() => setUploadConflict(null)} onConfirm={() => { const pending = uploadConflict; setUploadConflict(null); if (pending) void uploadFiles(pending.files, new Set(pending.collisions), pending.directory); }} />
    <ConfirmDialog open={Boolean(cleanMode)} title={cleanMode === "cache" ? t("editor.cleanCacheConfirmTitle") : t("editor.cleanArtifactsConfirmTitle")} description={cleanMode === "cache" ? t("editor.cleanCacheConfirmDescription") : t("editor.cleanArtifactsConfirmDescription")} confirmLabel={t("editor.cleanConfirm")} danger={cleanMode === "artifacts"} onCancel={() => setCleanMode(null)} onConfirm={() => { const mode = cleanMode; setCleanMode(null); if (mode) void cleanCompile(mode); }} />
    <Modal open={newFileOpen} title={t("editor.newFile")} description={t("editor.newFileDescription")} onOpenChange={(open) => { setNewFileOpen(open); if (!open) setFileDialogError(""); }} footer={<><button onClick={() => setNewFileOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFile()}>{t("common.create")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.filePath")}<input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} /></label></></Modal>
    <Modal open={newFolderOpen} title={t("editor.newFolder")} description={t("editor.folderDestination", { folder: selectedFolder || t("editor.projectRoot") })} onOpenChange={(open) => { setNewFolderOpen(open); if (!open) setFileDialogError(""); }} footer={<><button onClick={() => setNewFolderOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFolder()}>{t("common.create")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.folderName")}<input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); }} /></label></></Modal>
    <Modal open={Boolean(moveEntry)} title={t("editor.moveTitle", { name: moveEntry?.path.split("/").at(-1) ?? "" })} description={t("editor.moveDescription")} onOpenChange={(open) => { if (!open) { setMoveEntry(null); setMoveName(""); setFileDialogError(""); } }} footer={<><button onClick={() => setMoveEntry(null)}>{t("common.cancel")}</button><button className="primary" disabled={!moveName.trim()} onClick={() => void movePath()}>{t("editor.moveApply")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.pathName")}<input autoFocus value={moveName} onChange={(event) => setMoveName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void movePath(); }} /></label><label className="form-field">{t("editor.destinationFolder")}<select value={moveDestination} onChange={(event) => setMoveDestination(event.target.value)}><option value="">{t("editor.projectRoot")}</option>{directoryEntries.filter((directory) => moveEntry?.type !== "directory" || (directory.path !== moveEntry.path && !directory.path.startsWith(`${moveEntry.path}/`))).map((directory) => <option value={directory.path} key={directory.path}>{directory.path}</option>)}</select></label></></Modal>
    <Modal open={Boolean(deleteEntry)} title={t("editor.deletePathTitle", { name: deleteEntry?.path.split("/").at(-1) ?? "" })} description={deleteActiveSessions.length
      ? t("editor.deletePathActiveDescription", { path: deleteEntry?.path ?? "", users: [...new Set(deleteActiveSessions.map((session) => session.name))].join(", ") })
      : t("editor.deletePathDescription", { path: deleteEntry?.path ?? "" })} onOpenChange={(open) => { if (!open) { setDeleteEntry(null); setFileDialogError(""); } }} footer={<><button onClick={() => setDeleteEntry(null)}>{t("common.cancel")}</button><button className="danger" onClick={() => void removePath()}>{t("common.delete")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}{deleteActiveSessions.length > 0 && <p className="warning"><AlertTriangle size={15} />{t("editor.deletePathWillClose")}</p>}</></Modal>
    <Modal open={commentOpen} title={t("editor.addComment")} description={selection.selectedText ? t("editor.commentDescription", { count: selection.endOffset - selection.startOffset }) : t("editor.pointComment")} onOpenChange={setCommentOpen} footer={<><button onClick={() => setCommentOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void addComment()}>{t("editor.addComment")}</button></>}><label className="form-field">{t("editor.commentContent")}<textarea autoFocus rows={5} value={commentText} onChange={(event) => setCommentText(event.target.value)} /></label>{selection.selectedText && <blockquote className="selection-preview">{selection.selectedText}</blockquote>}</Modal>
    <ShareDialog open={shareOpen} onOpenChange={setShareOpen} project={project} projectId={projectId} />
    <CitationLibraryDialog open={citationLibraryOpen} onOpenChange={setCitationLibraryOpen} currentFile={activeFile} currentSource={content} readOnly={readOnly} currentUserId={user.id} onInsert={insertCitationAtCursor} />
    {quickOpen && <Suspense fallback={null}><QuickOpenDialog open files={files} onOpenChange={setQuickOpen} onOpenFile={(filePath) => { const entry = files.find((file) => file.path === filePath); if (entry) openFile(entry); }} /></Suspense>}
    {projectSearchOpen && <Suspense fallback={null}><ProjectSearchDialog open project={project} onOpenChange={setProjectSearchOpen} onJump={(filePath, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(filePath, line, column); }} /></Suspense>}
    {historyOpen && <Suspense fallback={null}><HistoryDialog open onOpenChange={setHistoryOpen} project={project} onBeforeMutation={project.permission === "read" ? async () => true : save} /></Suspense>}
    {project.ownerId === user.id && gitOpen && <Suspense fallback={null}><GitDialog open onOpenChange={setGitOpen} project={project} onBeforeMutation={save} /></Suspense>}
  </div>;
}



function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
