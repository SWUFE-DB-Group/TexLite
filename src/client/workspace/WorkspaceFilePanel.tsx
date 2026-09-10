import { useTranslation } from "react-i18next";
import { AlignLeft, BookOpen, ChevronDown, ChevronRight, FilePlus2, FileSearch, FileText, Folder, FolderOpen, FolderPlus, Hash, ListTree, LoaderCircle, Move, PanelLeftClose, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type RefObject } from "react";
import { Panel, type ImperativePanelHandle } from "react-resizable-panels";
import type { FileEntry, Project } from "../types";
import type { WordCountMode, ProjectOutlineItem } from "./types";
import type { SourceCursorStore } from "./sourceCursorStore";
import { buildOutlineTree, visibleOutlineTreeItems } from "./outlineTree";

export interface WorkspaceFilePanelProps {
  project: Project;
  filesPanel: RefObject<ImperativePanelHandle | null>;
  files: FileEntry[];
  visibleEntries: FileEntry[];
  activeFile: string;
  activeMainFile: string;
  rootDocuments: Set<string>;
  selectedFolder: string;
  expandedFolders: Set<string>;
  fileDragActive: boolean;
  uploadingFiles: boolean;
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
  setSelectedFolder: (folder: string) => void;
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
  setFilesCollapsed: (collapsed: boolean) => void;
  toggleFilesPanel: () => void;
  uploadFiles: (files: File[]) => Promise<void>;
  upload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  openFile: (entry: FileEntry) => void;
  onFormatFile: () => void;
  onFormatSelection: () => void;
  jumpToSource: (path: string, line: number, column: number) => void;
  syncSourceToPdf: (path: string, line: number, column: number) => Promise<void>;
  onWordCount: (mode: WordCountMode) => void;
}

export function WorkspaceFilePanel({
  project, filesPanel, files, visibleEntries, activeFile, activeMainFile, rootDocuments, selectedFolder,
  expandedFolders, fileDragActive, uploadingFiles, readOnly, formatting, canFormat, activeFormatLease, collaborationSynced,
  editorFontSize, outline, sourceCursorStore, wordCountBusy, hasSelection, hasFormatSelection, uploadInput,
  setSelectedFolder, setExpandedFolders, setMoveEntry, setMoveName, setMoveDestination,
  setDeleteEntry, setFileDialogError, setNewFolderName, setNewFolderOpen, setNewFilePath, setNewFileOpen,
  setQuickOpen, setProjectSearchOpen, setFileDragActive, setFilesCollapsed, toggleFilesPanel, uploadFiles, upload, openFile,
  onFormatFile, onFormatSelection, jumpToSource, syncSourceToPdf, onWordCount
}: WorkspaceFilePanelProps) {
  const { t } = useTranslation();
  const [showFileSizes, setShowFileSizes] = useState(false);
  return <Panel id="files" order={1} ref={filesPanel} defaultSize={16} minSize={12} maxSize={30} collapsible collapsedSize={0} onCollapse={() => setFilesCollapsed(true)} onExpand={() => setFilesCollapsed(false)}>
    <aside className="left-panel">
      <section className={`files-panel${fileDragActive ? " drop-active" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!readOnly && !uploadingFiles) setFileDragActive(true); }} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = readOnly || uploadingFiles ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setFileDragActive(false); if (!readOnly && !uploadingFiles) void uploadFiles(Array.from(event.dataTransfer.files)); }}>
        <div className="panel-title"><button className="file-size-toggle" type="button" aria-pressed={showFileSizes} title={t(showFileSizes ? "editor.hideFileSizes" : "editor.showFileSizes")} onClick={() => setShowFileSizes((current) => !current)}>{t("common.files")}</button><span className="file-tools"><button aria-label={t("navigation.quickOpen")} title={`${t("navigation.quickOpen")} (Ctrl/Cmd+P)`} onClick={() => setQuickOpen(true)}><FileSearch size={15} /></button><button aria-label={t("navigation.projectSearch")} title={`${t("navigation.projectSearch")} (Ctrl/Cmd+Shift+F)`} onClick={() => setProjectSearchOpen(true)}><Search size={15} /></button>{!readOnly && <><button disabled={uploadingFiles} aria-label={t("editor.uploadAttachment")} title={t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })} onClick={() => uploadInput.current?.click()}><Upload size={15} /></button><button aria-label={t("editor.newFolder")} title={t("editor.newFolder")} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={15} /></button><button aria-label={t("editor.newFile")} title={t("editor.newFile")} onClick={() => { setNewFilePath(selectedFolder ? `${selectedFolder}/` : ""); setNewFileOpen(true); }}><FilePlus2 size={15} /></button><input ref={uploadInput} type="file" multiple hidden onChange={(event) => void upload(event)} /></>}<button aria-label={t("editor.collapseFiles")} title={t("editor.collapseFiles")} onClick={toggleFilesPanel}><PanelLeftClose size={15} /></button></span></div>
        {fileDragActive && <div className="file-drop-overlay"><Upload size={24} /><strong>{t("editor.dropFiles")}</strong><span>{t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })}</span></div>}
        <div className="file-list" style={{ fontSize: `${editorFontSize}px` }}>
          <div className={`file-entry folder-entry root-entry${selectedFolder === "" ? " selected" : ""}`}><button className="file-entry-main" onClick={() => setSelectedFolder("")}><FolderOpen size={15} /><span>{t("editor.projectRoot")}</span></button></div>
          {visibleEntries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const name = entry.path.split("/").at(-1);
            const expanded = expandedFolders.has(entry.path);
            const rootDocument = rootDocuments.has(entry.path);
            const compileTarget = activeMainFile === entry.path;
            const canDelete = entry.path !== project.mainFile && !project.mainFile.startsWith(`${entry.path}/`);
            if (entry.type === "directory") return <div className={`file-entry folder-entry${selectedFolder === entry.path ? " selected" : ""}`} style={{ paddingLeft: `${depth * 13 + 5}px` }} key={entry.path}><button className="file-entry-main" onClick={() => { setSelectedFolder(entry.path); setExpandedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span></button>{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
            return <div className={`file-entry${activeFile === entry.path ? " active" : ""}${rootDocument ? " root-document" : ""}${compileTarget ? " compile-target" : ""}`} style={{ paddingLeft: `${depth * 13 + 18}px` }} key={entry.path}><button className="file-entry-main" onClick={() => openFile(entry)}>{rootDocument ? <BookOpen size={13} /> : <FileText size={13} />}<span>{name}</span>{compileTarget && <small>{t("editor.currentMainShort")}</small>}</button>{showFileSizes && typeof entry.size === "number" && <span className="file-entry-size">{formatFileSize(entry.size)}</span>}{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveName(name ?? ""); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
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
    return <div className={`outline-row${current ? " current" : ""}`} key={entry.key}>
      <span className="outline-guides" aria-hidden style={{ width: `${item.level * 12}px` }} />
      {entry.hasChildren ? <button className="outline-toggle" type="button" aria-label={t(collapsed ? "editor.expandOutlineItem" : "editor.collapseOutlineItem", { title: item.title })} aria-expanded={!collapsed} onClick={() => toggleItem(entry.key)}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="outline-toggle-spacer" aria-hidden />}
      <button className="outline-item" type="button" onClick={() => { jumpToSource(item.path, item.line, 1); void syncSourceToPdf(item.path, item.line, 1); }}><small>{item.path === activeFile ? item.line : item.path.split("/").at(-1)}</small><span className="outline-title">{item.title}</span></button>
    </div>;
  })}{outline.length === 0 && <p className="muted padded">{t("editor.noOutline")}</p>}</div></section>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
