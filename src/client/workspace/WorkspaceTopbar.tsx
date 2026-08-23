import { AlignLeft, ArrowLeft, BookMarked, GitBranch, Keyboard, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActiveSession, CollaborationStatus, SharedCompileState } from "../collaboration";
import type { EditorPreferences } from "../editorPreferences";
import type { Project, SiteConfig } from "../types";
import type { WorkspaceLayout } from "./types";
import { CollaborationPresence, WorkspaceLayoutMenu } from "./WorkspaceChrome";
import { SiteLogo } from "../pages/SiteChrome";

export interface WorkspaceTopbarProps {
  site: SiteConfig;
  project: Project;
  activeFile: string;
  saveStateLabel: string;
  editorPreferences: EditorPreferences;
  activeSessions: ActiveSession[];
  collaborationStatus: CollaborationStatus;
  reconnectCollaboration: () => void;
  showEditor: boolean;
  filesCollapsed: boolean;
  toggleFilesPanel: () => void;
  workspaceLayout: WorkspaceLayout;
  changeWorkspaceLayout: (layout: WorkspaceLayout) => void;
  onBack: () => void;
  onShare: () => void;
  showCitationLibrary: boolean;
  citationLibraryOpen: boolean;
  onCitationLibrary: () => void;
  onHistory: () => void;
  onGit: () => void;
  canManageGit: boolean;
  formatting: boolean;
  canFormat: boolean;
  readOnly: boolean;
  collaborationSynced: boolean;
  activeFormatLease: boolean;
  onFormatFile: () => void;
  onFormatSelection: () => void;
  hasSelection: boolean;
  onAddComment: () => void;
  onToggleComments: () => void;
  commentsOpen: boolean;
  unresolvedCommentCount: number;
  hasActiveFile: boolean;
  onToggleSettings: () => void;
  settingsOpen: boolean;
  compileBusy: boolean;
  sharedCompiling: boolean;
  localCompiling: boolean;
  compileState: SharedCompileState | null;
  onCompile: () => void;
}

export function WorkspaceTopbar({
  site, project, activeFile, saveStateLabel, editorPreferences, activeSessions, collaborationStatus,
  reconnectCollaboration, showEditor, filesCollapsed, toggleFilesPanel, workspaceLayout,
  changeWorkspaceLayout, onBack, onShare, showCitationLibrary, citationLibraryOpen,
  onCitationLibrary, onHistory, onGit, canManageGit, formatting, readOnly, collaborationSynced,
  canFormat, activeFormatLease, onFormatFile, onFormatSelection, hasSelection, onAddComment,
  onToggleComments, commentsOpen, unresolvedCommentCount, hasActiveFile, onToggleSettings,
  settingsOpen, compileBusy, sharedCompiling, localCompiling, compileState, onCompile
}: WorkspaceTopbarProps) {
  const { t } = useTranslation();
  return <header className="editor-topbar">
    <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button>
    <a className="brand-link compact-brand-link" href="/" aria-label={site.siteName} onClick={(event) => { event.preventDefault(); onBack(); }}><SiteLogo siteName={site.siteName} compact /></a>
    <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {saveStateLabel}</small></div>
    {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
    <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
    {collaborationStatus === "disconnected" && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
    <div className="editor-actions">
      {showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}
      <WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} />
      <button onClick={onShare}><Users size={15} />{t("projectSettings.share")}</button>
      {showCitationLibrary && <button className={citationLibraryOpen ? "active" : ""} onClick={onCitationLibrary}><BookMarked size={15} />{t("citationLibrary.title")}</button>}
      <div className="version-action" role="group" aria-label={t("common.version")}>
        <div className="version-action-label"><GitBranch size={14} /><span>{t("common.version")}</span></div>
        <div className="version-action-options">
          <button type="button" className="version-action-history" title={t("history.title")} onClick={onHistory}>{t("history.title")}</button>
          <button type="button" className="version-action-git" title={canManageGit ? t("git.title") : t("git.ownerOnly")} disabled={!canManageGit} onClick={onGit}>Git</button>
        </div>
      </div>
      {showEditor && project.permission !== "read" && canFormat && <div className="format-action" role="group" aria-label={t("editor.format")} aria-busy={formatting}>
        <div className="format-action-label"><AlignLeft size={14} /><span>{t("editor.format")}</span></div>
        <div className="format-action-options">
          <button type="button" className="format-action-file" title={t("editor.formatFileHint")} onMouseDown={(event) => event.preventDefault()} onClick={onFormatFile} disabled={formatting || activeFormatLease || !collaborationSynced}>{t("editor.formatFile")}</button>
          <button type="button" className="format-action-selected" title={hasSelection ? t("editor.formatSelection") : t("editor.formatSelectionHint")} onMouseDown={(event) => event.preventDefault()} onClick={onFormatSelection} disabled={formatting || activeFormatLease || !collaborationSynced || !hasSelection}>{t("editor.formatSelected")}</button>
        </div>
      </div>}
      <div className="comments-action" role="group" aria-label={t("common.comments")}>
        <div className="comments-action-label"><MessageSquare size={14} /><span>{t("common.comments")}</span></div>
        <div className="comments-action-options">
          <button type="button" className="comments-action-add" title={t("editor.addComment")} aria-label={t("editor.addComment")} onMouseDown={(event) => event.preventDefault()} onClick={onAddComment} disabled={!hasActiveFile}>{t("editor.commentsAdd")}</button>
          <button type="button" className={`comments-action-all${commentsOpen ? " active" : ""}`} title={t("editor.commentsAll")} onClick={onToggleComments}>{t("editor.commentsAll")} {unresolvedCommentCount || ""}</button>
        </div>
      </div>
      <button className={settingsOpen ? "active" : ""} onClick={onToggleSettings}><Settings size={15} />{t("common.settings")}</button>
      <button className="compile" title={sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : t("editor.compileShortcut")} onClick={onCompile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : localCompiling ? t("editor.compiling") : t("editor.compile", { engine: project.engine })}</button>
    </div>
  </header>;
}
