import { useTranslation } from "react-i18next";
import { AlignLeft, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FilePlus2, FileSearch, Folder, FolderPlus, Hash, ListTree, LoaderCircle, Move, PanelLeftClose, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type DragEvent, type RefObject } from "react";
import { Panel, type ImperativePanelHandle } from "react-resizable-panels";
import type { FileEntry, Project } from "../types";
import type { WordCountMode, ProjectOutlineItem } from "./types";
import type { SourceCursorStore } from "./sourceCursorStore";
import { buildOutlineTree, visibleOutlineTreeItems } from "./outlineTree";
import { FileTypeIcon } from "../fileIcons";
import type { UploadFeedback } from "./useProjectFiles";

const INTERNAL_PATH_DRAG_MIME = "application/x-texlite-project-path";
const INTERNAL_PATH_DRAG_PREFIX = "texlite-path:";

export interface WorkspaceFilePanelProps {
  project: Project;
  filesPanel: RefObject<ImperativePanelHandle | null>;
  files: FileEntry[];
  visibleEntries: FileEntry[];
  activeFile: string;
  activeMainFile: string;
  selectedFile: string;
  selectedFolder: string | null;
  expandedFolders: Set<string>;
  fileDragActive: boolean;
  uploadingFiles: boolean;
  uploadFeedback: UploadFeedback | null;
  readOnly: boolean;
  formatting: boolean;
  canFormat: boolean;
  activeFormatLease: boolean;
  collaborationSynced: boolean;
  editorFontSize: number;
  outline: ProjectOutlineItem[];
  sourceCursorStore: SourceCursorStore;
  wordCountBusy: boolean;
  hasSelection: boolean;
  hasFormatSelection: boolean;
  uploadInput: RefObject<HTMLInputElement | null>;
  setSelectedFolder: (folder: string | null) => void;
  setExpandedFolders: (updater: (current: Set<string>) => Set<string>) => void;
  setMoveEntry: (entry: FileEntry) => void;
  setMoveName: (name: string) => void;
  setMoveDestination: (destination: string) => void;
  setDeleteEntry: (entry: FileEntry) => void;
  setFileDialogError: (message: string) => void;
  setNewFolderName: (name: string) => void;
  setNewFolderOpen: (open: boolean) => void;
  setNewFilePath: (path: string) => void;
  setNewFileOpen: (open: boolean) => void;
  setQuickOpen: (open: boolean) => void;
  setProjectSearchOpen: (open: boolean) => void;
  setFileDragActive: (active: boolean) => void;
  dismissUploadFeedback: () => void;
  setFilesCollapsed: (collapsed: boolean) => void;
  toggleFilesPanel: () => void;
  onError: (message: string) => void;
  uploadFiles: (files: File[]) => Promise<void>;
  upload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  openFile: (entry: FileEntry) => void;
  movePathToFolder: (entry: FileEntry, destinationDirectory: string) => Promise<void>;
  onFormatFile: () => void;
  onFormatSelection: () => void;
  jumpToSource: (path: string, line: number, column: number) => void;
  syncSourceToPdf: (path: string, line: number, column: number) => Promise<void>;
  onWordCount: (mode: WordCountMode) => void;
}

export function WorkspaceFilePanel({
  project, filesPanel, files, visibleEntries, activeFile, activeMainFile, selectedFile, selectedFolder,
  expandedFolders, fileDragActive, uploadingFiles, uploadFeedback, readOnly, formatting, canFormat, activeFormatLease, collaborationSynced,
  editorFontSize, outline, sourceCursorStore, wordCountBusy, hasSelection, hasFormatSelection, uploadInput,
  setSelectedFolder, setExpandedFolders, setMoveEntry, setMoveName, setMoveDestination,
  setDeleteEntry, setFileDialogError, setNewFolderName, setNewFolderOpen, setNewFilePath, setNewFileOpen,
  setQuickOpen, setProjectSearchOpen, setFileDragActive, dismissUploadFeedback, setFilesCollapsed, toggleFilesPanel, uploadFiles, upload, openFile, movePathToFolder,
  onError, onFormatFile, onFormatSelection, jumpToSource, syncSourceToPdf, onWordCount
}: WorkspaceFilePanelProps) {
  const { t } = useTranslation();
  const [showFileSizes, setShowFileSizes] = useState(false);
  const [draggedEntry, setDraggedEntry] = useState<FileEntry | null>(null);
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null);
  const suppressClickUntil = useRef(0);
  const canMoveToFolder = (source: FileEntry, destination: string) => parentFolder(source.path) !== destination
    && (source.type !== "directory" || (destination !== source.path && !destination.startsWith(`${source.path}/`)));
  const clearMoveDrag = () => {
    setDraggedEntry(null);
    setDropTargetFolder(null);
  };
  return <Panel id="files" order={1} ref={filesPanel} defaultSize={16} minSize={12} maxSize={30} collapsible collapsedSize={0} onCollapse={() => setFilesCollapsed(true)} onExpand={() => setFilesCollapsed(false)}>
    <aside className="left-panel">
      <section className={`files-panel${fileDragActive ? " drop-active" : ""}`} onDragEnter={(event) => { if (isInternalPathDrag(event.dataTransfer)) { event.preventDefault(); return; } if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!readOnly && !uploadingFiles) setFileDragActive(true); }} onDragOver={(event) => { if (isInternalPathDrag(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; return; } if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = readOnly || uploadingFiles ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false); }} onDrop={(event) => { if (isInternalPathDrag(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); return; } event.preventDefault(); setFileDragActive(false); if (readOnly || uploadingFiles) return; const files = Array.from(event.dataTransfer.files); if (containsDroppedFolder(event.dataTransfer) || files.length === 0) { onError(t("editor.dropFoldersUnsupported")); return; } void uploadFiles(files); }}>
        <div className="panel-title"><button className="file-size-toggle" type="button" aria-pressed={showFileSizes} title={t(showFileSizes ? "editor.hideFileSizes" : "editor.showFileSizes")} onClick={() => setShowFileSizes((current) => !current)}>{t("common.files")}</button><span className="file-tools"><button type="button" aria-label={t("navigation.quickOpen")} title={`${t("navigation.quickOpen")} (Ctrl/Cmd+P)`} onClick={() => setQuickOpen(true)}><FileSearch size={15} /></button><button type="button" aria-label={t("navigation.projectSearch")} title={`${t("navigation.projectSearch")} (Ctrl/Cmd+Shift+F)`} onClick={() => setProjectSearchOpen(true)}><Search size={15} /></button>{!readOnly && <><button type="button" disabled={uploadingFiles} aria-label={t("editor.uploadAttachment")} title={t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })} onClick={() => uploadInput.current?.click()}><Upload size={15} /></button><button type="button" aria-label={t("editor.newFolder")} title={t("editor.newFolder")} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={15} /></button><button type="button" aria-label={t("editor.newFile")} title={t("editor.newFile")} onClick={() => { setNewFilePath(selectedFolder ? `${selectedFolder}/` : ""); setNewFileOpen(true); }}><FilePlus2 size={15} /></button><input ref={uploadInput} type="file" multiple hidden onChange={(event) => void upload(event)} /></>}<button type="button" aria-label={t("editor.collapseFiles")} title={t("editor.collapseFiles")} onClick={toggleFilesPanel}><PanelLeftClose size={15} /></button></span></div>
        {uploadFeedback && <div className={`file-upload-feedback ${uploadFeedback.kind}`} role={uploadFeedback.kind === "error" ? "alert" : "status"} aria-live={uploadFeedback.kind === "error" ? "assertive" : "polite"} aria-busy={uploadFeedback.kind === "uploading"}>
          {uploadFeedback.kind === "uploading"
            ? <LoaderCircle className="spin" size={14} />
            : uploadFeedback.kind === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span className="file-upload-feedback-text">
            {uploadFeedback.kind === "uploading" && t("editor.uploadingFile", { file: uploadFeedback.fileName, current: uploadFeedback.current, total: uploadFeedback.total })}
            {uploadFeedback.kind === "success" && t("editor.uploadSucceeded", { count: uploadFeedback.count })}
            {uploadFeedback.kind === "error" && uploadFeedback.message}
          </span>
          {uploadFeedback.kind !== "uploading" && <button type="button" className="file-upload-feedback-dismiss" aria-label={t("common.close")} title={t("common.close")} onClick={dismissUploadFeedback}><X size={13} /></button>}
        </div>}
        {fileDragActive && <div className="file-drop-overlay"><Upload size={24} /><strong>{t("editor.dropFiles")}</strong><span>{t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })}</span></div>}
        <div className={`file-list${selectedFolder !== null ? " folder-selected" : ""}${dropTargetFolder === "" ? " root-drop-target" : ""}`} style={{ fontSize: `${editorFontSize}px` }}
          onDragOver={(event) => {
            if (!draggedEntry && !isInternalPathDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!draggedEntry) return;
            if (!canMoveToFolder(draggedEntry, "")) {
              event.dataTransfer.dropEffect = "none";
              return;
            }
            event.dataTransfer.dropEffect = "move";
            setDropTargetFolder("");
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTargetFolder((current) => current === "" ? null : current);
            }
          }}
          onDrop={(event) => {
            if (!draggedEntry && !isInternalPathDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!draggedEntry) return;
            const source = draggedEntry;
            clearMoveDrag();
            if (canMoveToFolder(source, "")) void movePathToFolder(source, "");
          }}>
          {visibleEntries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const name = entry.path.split("/").at(-1);
            const expanded = expandedFolders.has(entry.path);
            const configuredMainDocument = project.mainFile === entry.path;
            const canDelete = entry.path !== project.mainFile && !project.mainFile.startsWith(`${entry.path}/`);
            if (entry.type === "directory") return <div className={`file-entry folder-entry${selectedFolder === entry.path ? " selected" : ""}${dropTargetFolder === entry.path ? " move-drop-target" : ""}`} style={{ paddingLeft: `${depth * 13 + 5}px` }} key={entry.path} onDragOver={(event) => { if (!draggedEntry && !isInternalPathDrag(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); if (!draggedEntry) return; if (!canMoveToFolder(draggedEntry, entry.path)) { event.dataTransfer.dropEffect = "none"; return; } event.dataTransfer.dropEffect = "move"; setDropTargetFolder(entry.path); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetFolder((current) => current === entry.path ? null : current); }} onDrop={(event) => { if (!draggedEntry && !isInternalPathDrag(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); if (!draggedEntry) return; const source = draggedEntry; clearMoveDrag(); if (canMoveToFolder(source, entry.path)) void movePathToFolder(source, entry.path); }}><button type="button" className="file-entry-main" onClick={() => { setSelectedFolder(entry.path); setExpandedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span></button>{!readOnly && <><button type="button" className="file-entry-action" data-texlite-tooltip-always title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button type="button" className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
            return <div className={`file-entry${selectedFolder === null && selectedFile === entry.path ? " active" : ""}${draggedEntry?.path === entry.path ? " move-drag-source" : ""}`} style={{ paddingLeft: `${depth * 13 + 18}px` }} key={entry.path}><button type="button" className="file-entry-main" draggable={!readOnly} onDragStart={(event) => { suppressClickUntil.current = Date.now() + 500; startPathDrag(event, entry, setDraggedEntry); }} onDragEnd={clearMoveDrag} onClick={() => { if (suppressClickUntil.current > Date.now()) { suppressClickUntil.current = 0; return; } openFile(entry); }}><FileTypeIcon path={entry.path} /><span>{name}</span>{configuredMainDocument && <small>{t("editor.currentMainShort")}</small>}</button>{showFileSizes && typeof entry.size === "number" && <span className="file-entry-size">{formatFileSize(entry.size)}</span>}{!readOnly && <><button type="button" className="file-entry-action" data-texlite-tooltip-always title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button type="button" className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
          })}
        </div>
        {!readOnly && canFormat && <div className="file-format-footer" role="group" aria-label={t("editor.format")} aria-busy={formatting}>
          <div className="file-format-label"><AlignLeft size={13} />{t("editor.format")}</div>
          <div className="file-format-actions">
            <button className={!hasFormatSelection ? "active" : ""} type="button" title={t("editor.formatFileHint")} onMouseDown={(event) => event.preventDefault()} onClick={onFormatFile} disabled={formatting || activeFormatLease || !collaborationSynced}>{t("editor.formatFile")}</button>
            <button className={hasFormatSelection ? "active" : ""} type="button" title={hasFormatSelection ? t("editor.formatSelection") : t("editor.formatSelectionHint")} onMouseDown={(event) => event.preventDefault()} onClick={onFormatSelection} disabled={formatting || activeFormatLease || !collaborationSynced || !hasFormatSelection}>{t("editor.formatSelected")}</button>
          </div>
        </div>}
      </section>
      <WorkspaceOutlinePanel outline={outline} activeFile={activeFile} activeMainFile={activeMainFile} sourceCursorStore={sourceCursorStore} wordCountBusy={wordCountBusy} hasSelection={hasSelection} jumpToSource={jumpToSource} syncSourceToPdf={syncSourceToPdf} onWordCount={onWordCount} />
    </aside>
  </Panel>;
}

function containsDroppedFolder(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) => {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    return entry?.isDirectory === true;
  });
}

function isInternalPathDrag(dataTransfer: DataTransfer): boolean {
  if (Array.from(dataTransfer.types).includes(INTERNAL_PATH_DRAG_MIME)) return true;
  // Some browsers expose only text/plain during a drop. The prefix keeps
  // ordinary external text drags from being mistaken for a project move.
  return Array.from(dataTransfer.types).includes("text/plain")
    && dataTransfer.getData("text/plain").startsWith(INTERNAL_PATH_DRAG_PREFIX);
}

function parentFolder(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator < 0 ? "" : filePath.slice(0, separator);
}

function startPathDrag(event: DragEvent<HTMLButtonElement>, entry: FileEntry, setDraggedEntry: (entry: FileEntry) => void): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(INTERNAL_PATH_DRAG_MIME, entry.path);
  // Safari can be selective about custom drag MIME types. A plain-text value
  // with a private prefix makes the drag valid there without treating an
  // arbitrary external text drop as a project path.
  event.dataTransfer.setData("text/plain", `${INTERNAL_PATH_DRAG_PREFIX}${entry.path}`);
  setDraggedEntry(entry);
}

function WorkspaceOutlinePanel({
  outline, activeFile, activeMainFile, sourceCursorStore, wordCountBusy, hasSelection, jumpToSource, syncSourceToPdf, onWordCount
}: {
  outline: ProjectOutlineItem[];
  activeFile: string;
  activeMainFile: string;
  sourceCursorStore: SourceCursorStore;
  wordCountBusy: boolean;
  hasSelection: boolean;
  jumpToSource: (path: string, line: number, column: number) => void;
  syncSourceToPdf: (path: string, line: number, column: number) => Promise<void>;
  onWordCount: (mode: WordCountMode) => void;
}) {
  const { t } = useTranslation();
  const sourceCursorLine = useSyncExternalStore(
    sourceCursorStore.subscribe,
    sourceCursorStore.getOutlineLine,
    sourceCursorStore.getOutlineLine
  );
  const tree = useMemo(() => buildOutlineTree(outline), [outline]);
  const collapsibleKeys = useMemo(() => tree.filter((entry) => entry.hasChildren).map((entry) => entry.key), [tree]);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const validKeys = new Set(collapsibleKeys);
    setCollapsedKeys((current) => {
      const next = new Set([...current].filter((key) => validKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [collapsibleKeys]);

  const allCollapsed = collapsibleKeys.length > 0 && collapsibleKeys.every((key) => collapsedKeys.has(key));
  const visibleItems = useMemo(() => visibleOutlineTreeItems(tree, collapsedKeys), [tree, collapsedKeys]);
  const toggleAll = () => setCollapsedKeys((current) => {
    if (allCollapsed) return new Set([...current].filter((key) => !collapsibleKeys.includes(key)));
    return new Set([...current, ...collapsibleKeys]);
  });
  const toggleItem = (key: string) => setCollapsedKeys((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return <section className="outline-panel"><div className="panel-title"><button className="outline-heading" type="button" aria-expanded={!allCollapsed} title={t(allCollapsed ? "editor.expandOutline" : "editor.collapseOutline")} onClick={toggleAll} disabled={collapsibleKeys.length === 0}><ListTree size={14} />{t("common.outline")}</button><span className="word-count-actions" role="group" aria-label={t("editor.wordCountTitle")}><button type="button" title={t("editor.wordCountFullHint")} onClick={() => onWordCount("full")} disabled={wordCountBusy || !activeMainFile}>{wordCountBusy ? <LoaderCircle className="spin" size={12} /> : <Hash size={12} />}{t("editor.wordCountFull")}</button><button type="button" title={t("editor.wordCountSelectionHint")} onClick={() => onWordCount("selection")} disabled={wordCountBusy || !hasSelection}>{wordCountBusy ? <LoaderCircle className="spin" size={12} /> : <Hash size={12} />}{t("editor.wordCountSelection")}</button></span></div><div className="outline">{visibleItems.map((entry) => {
    const { item } = entry;
    const collapsed = collapsedKeys.has(entry.key);
    const current = activeFile === item.path && sourceCursorLine === item.line;
    // Main-document rows keep their line numbers even when another source
    // tab is active. Included-file rows show their file name unless that
    // file is the active tab, where its line number is useful again.
    const showLineNumber = item.path === activeMainFile || item.path === activeFile;
    return <div className={`outline-row${current ? " current" : ""}`} key={entry.key}>
      <span className="outline-guides" aria-hidden style={{ width: `${item.level * 12}px` }} />
      {entry.hasChildren ? <button className="outline-toggle" type="button" aria-label={t(collapsed ? "editor.expandOutlineItem" : "editor.collapseOutlineItem", { title: item.title })} aria-expanded={!collapsed} onClick={() => toggleItem(entry.key)}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="outline-toggle-spacer" aria-hidden />}
      <button className="outline-item" type="button" onClick={() => { jumpToSource(item.path, item.line, 1); void syncSourceToPdf(item.path, item.line, 1); }}><small>{showLineNumber ? item.line : item.path.split("/").at(-1)}</small><span className="outline-title">{item.title}</span></button>
    </div>;
  })}{outline.length === 0 && <p className="muted padded">{t("editor.noOutline")}</p>}</div></section>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
