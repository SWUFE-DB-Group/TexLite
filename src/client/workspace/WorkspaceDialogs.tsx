import { lazy, Suspense } from "react";
import { AlertTriangle, Download, FileArchive, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog, Modal } from "../Dialog";
import type { ActiveSession } from "../collaboration";
import type { CitationLibraryEntry } from "../types";
import type { FileEntry, Project, User } from "../types";
import type { SourceSelection } from "./useProjectComments";
import type { PermissionDowngradeNotice } from "./useProjectCollaboration";
import { MAX_DIRECT_RESOURCE_PREVIEW_BYTES, type PendingUpload, type ResourcePreview } from "./useProjectFiles";
import type { CompileCleanMode } from "./useProjectCompilation";
import { CitationLibraryDialog } from "../CitationLibraryDialog";
import { CommentThread, ShareDialog } from "./Comments";
import type { WorkspaceLayout } from "./types";

const GitDialog = lazy(() => import("../GitDialog").then((module) => ({ default: module.GitDialog })));
const HistoryDialog = lazy(() => import("../HistoryDialog").then((module) => ({ default: module.HistoryDialog })));
const ProjectSearchDialog = lazy(() => import("../ProjectNavigationDialogs").then((module) => ({ default: module.ProjectSearchDialog })));
const QuickOpenDialog = lazy(() => import("../ProjectNavigationDialogs").then((module) => ({ default: module.QuickOpenDialog })));

export interface WorkspaceDialogsProps {
  user: User;
  project: Project;
  projectId: string;
  activeFile: string;
  content: string;
  maxCitationBibtexBytes: number;
  files: FileEntry[];
  directoryEntries: FileEntry[];
  readOnly: boolean;
  workspaceLayout: WorkspaceLayout;
  changeWorkspaceLayout: (layout: WorkspaceLayout) => void;
  resourcePreview: ResourcePreview | null;
  resourcePreviewLoading: boolean;
  setResourcePreview: (preview: ResourcePreview | null) => void;
  setResourcePreviewLoading: (loading: boolean) => void;
  uploadConflict: PendingUpload | null;
  setUploadConflict: (pending: PendingUpload | null) => void;
  uploadFiles: (files: File[], overwritePaths?: ReadonlySet<string>, directory?: string) => Promise<void>;
  cleanMode: CompileCleanMode | null;
  setCleanMode: (mode: CompileCleanMode | null) => void;
  cleanCompile: (mode: CompileCleanMode) => Promise<void>;
  newFileOpen: boolean;
  setNewFileOpen: (open: boolean) => void;
  newFilePath: string;
  setNewFilePath: (path: string) => void;
  newFolderOpen: boolean;
  setNewFolderOpen: (open: boolean) => void;
  newFolderName: string;
  setNewFolderName: (name: string) => void;
  selectedFolder: string;
  fileDialogError: string;
  setFileDialogError: (message: string) => void;
  createFile: () => Promise<void>;
  createFolder: () => Promise<void>;
  moveEntry: FileEntry | null;
  setMoveEntry: (entry: FileEntry | null) => void;
  moveName: string;
  setMoveName: (name: string) => void;
  moveDestination: string;
  setMoveDestination: (destination: string) => void;
  movePath: () => Promise<void>;
  deleteEntry: FileEntry | null;
  setDeleteEntry: (entry: FileEntry | null) => void;
  deleteActiveSessions: ActiveSession[];
  removePath: () => Promise<void>;
  commentOpen: boolean;
  setCommentOpen: (open: boolean) => void;
  selection: SourceSelection;
  commentText: string;
  setCommentText: (text: string) => void;
  addComment: () => Promise<void>;
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
  citationLibraryOpen: boolean;
  setCitationLibraryOpen: (open: boolean) => void;
  insertCitationAtCursor: (entry: CitationLibraryEntry) => boolean | Promise<boolean>;
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  projectSearchOpen: boolean;
  setProjectSearchOpen: (open: boolean) => void;
  openFile: (entry: FileEntry) => void;
  jumpToSource: (path: string, line: number, column: number) => void;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  gitOpen: boolean;
  setGitOpen: (open: boolean) => void;
  save: () => Promise<boolean>;
  permissionDowngrade: PermissionDowngradeNotice | null;
  permissionDowngradeBusy: boolean;
  dismissPermissionDowngrade: () => void;
  discardPermissionDraft: () => Promise<void>;
}

export function WorkspaceDialogs({
  user, project, projectId, activeFile, content, maxCitationBibtexBytes, files, directoryEntries, readOnly, workspaceLayout,
  changeWorkspaceLayout, resourcePreview, resourcePreviewLoading, setResourcePreview, setResourcePreviewLoading,
  uploadConflict, setUploadConflict, uploadFiles, cleanMode, setCleanMode, cleanCompile, newFileOpen,
  setNewFileOpen, newFilePath, setNewFilePath, newFolderOpen, setNewFolderOpen, newFolderName,
  setNewFolderName, selectedFolder, fileDialogError, setFileDialogError, createFile, createFolder, moveEntry,
  setMoveEntry, moveName, setMoveName, moveDestination, setMoveDestination, movePath, deleteEntry,
  setDeleteEntry, deleteActiveSessions, removePath, commentOpen, setCommentOpen, selection, commentText,
  setCommentText, addComment, shareOpen, setShareOpen, citationLibraryOpen, setCitationLibraryOpen,
  insertCitationAtCursor, quickOpen, setQuickOpen, projectSearchOpen, setProjectSearchOpen, openFile,
  jumpToSource, historyOpen, setHistoryOpen, gitOpen, setGitOpen, save, permissionDowngrade,
  permissionDowngradeBusy, dismissPermissionDowngrade, discardPermissionDraft
}: WorkspaceDialogsProps) {
  const { t } = useTranslation();
  return <>
    {permissionDowngrade && <Modal open title={t("editor.collaboration.permissionDowngradeTitle")} description={permissionDowngrade.localDraftReady && permissionDowngrade.otherTabDraft
      ? t("editor.collaboration.permissionDowngradeMultipleDrafts")
      : permissionDowngrade.otherTabDraft
        ? t("editor.collaboration.permissionDowngradeOtherTab")
      : permissionDowngrade.localDraftReady
          ? t("editor.collaboration.permissionDowngradeDescription", { previous: t("common.readWrite") })
          : t("editor.collaboration.permissionDowngradeNoDraft")} onOpenChange={(open) => { if (!open && !permissionDowngradeBusy) dismissPermissionDowngrade(); }} footer={<><button type="button" disabled={permissionDowngradeBusy} onClick={dismissPermissionDowngrade}>{permissionDowngrade.localDraftReady ? t("editor.collaboration.permissionDowngradeKeep") : t("common.close")}</button>{!permissionDowngrade.otherTabDraft && <button type="button" className="danger" disabled={permissionDowngradeBusy} onClick={() => void discardPermissionDraft()}>{permissionDowngradeBusy ? <LoaderCircle className="spin" size={14} /> : permissionDowngrade.localDraftReady ? <Trash2 size={14} /> : <RefreshCw size={14} />}{permissionDowngrade.localDraftReady ? t("editor.collaboration.permissionDowngradeDiscard") : t("editor.collaboration.permissionDowngradeReload")}</button>}</>}><div /></Modal>}
    <Modal open={Boolean(resourcePreview)} extraWide={resourcePreview?.kind === "image" || resourcePreview?.kind === "pdf" || resourcePreview?.kind === "text"} title={resourcePreview?.path ?? ""} description={resourcePreview?.kind === "large" ? t("editor.resourceTooLarge", { size: formatFileSize(resourcePreview.size), limit: `${MAX_DIRECT_RESOURCE_PREVIEW_BYTES / 1024 / 1024} MB` }) : t(`editor.resourcePreview.${resourcePreview?.kind ?? "text"}`)} onOpenChange={(open) => { if (!open) { setResourcePreview(null); setResourcePreviewLoading(false); } }} footer={resourcePreview && <a className="primary resource-download" href={`${resourcePreview.url}&download=1`} download><Download size={14} />{t("editor.downloadResource")}</a>}>
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
    <Modal open={Boolean(deleteEntry)} title={t("editor.deletePathTitle", { name: deleteEntry?.path.split("/").at(-1) ?? "" })} description={deleteActiveSessions.length ? t("editor.deletePathActiveDescription", { path: deleteEntry?.path ?? "", users: [...new Set(deleteActiveSessions.map((session) => session.name))].join(", ") }) : t("editor.deletePathDescription", { path: deleteEntry?.path ?? "" })} onOpenChange={(open) => { if (!open) { setDeleteEntry(null); setFileDialogError(""); } }} footer={<><button onClick={() => setDeleteEntry(null)}>{t("common.cancel")}</button><button className="danger" onClick={() => void removePath()}>{t("common.delete")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}{deleteActiveSessions.length > 0 && <p className="warning"><AlertTriangle size={15} />{t("editor.deletePathWillClose")}</p>}</></Modal>
    <Modal open={commentOpen} title={t("editor.addComment")} description={selection.selectedText ? t("editor.commentDescription", { count: selection.endOffset - selection.startOffset }) : t("editor.pointComment")} onOpenChange={setCommentOpen} footer={<><button onClick={() => setCommentOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void addComment()}>{t("editor.addComment")}</button></>}><label className="form-field">{t("editor.commentContent")}<textarea autoFocus rows={5} value={commentText} onChange={(event) => setCommentText(event.target.value)} /></label>{selection.selectedText && <blockquote className="selection-preview">{selection.selectedText}</blockquote>}</Modal>
    <ShareDialog open={shareOpen} onOpenChange={setShareOpen} project={project} projectId={projectId} />
    <CitationLibraryDialog open={citationLibraryOpen} onOpenChange={setCitationLibraryOpen} currentFile={activeFile} currentSource={content} readOnly={readOnly} currentUserId={user.id} maxBibtexBytes={maxCitationBibtexBytes} onInsert={insertCitationAtCursor} />
    {quickOpen && <Suspense fallback={null}><QuickOpenDialog open files={files} onOpenChange={setQuickOpen} onOpenFile={(filePath) => { const entry = files.find((file) => file.path === filePath); if (entry) openFile(entry); }} /></Suspense>}
    {projectSearchOpen && <Suspense fallback={null}><ProjectSearchDialog open project={project} onOpenChange={setProjectSearchOpen} onJump={(filePath, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(filePath, line, column); }} /></Suspense>}
    {historyOpen && <Suspense fallback={null}><HistoryDialog open onOpenChange={setHistoryOpen} project={project} onBeforeMutation={project.permission === "read" ? async () => true : save} /></Suspense>}
    {project.ownerId === user.id && gitOpen && <Suspense fallback={null}><GitDialog open onOpenChange={setGitOpen} project={project} onBeforeMutation={save} /></Suspense>}
  </>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
