import { ArrowLeft, BookMarked, FileClock, GitBranch, Keyboard, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Settings, Users, X } from "lucide-react";
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
  protocolUpgradeRequired: boolean;
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
  onSelectionHistory: () => void;
  onHistory: () => void;
  onGit: () => void;
  canManageGit: boolean;
  formatting: boolean;
  readOnly: boolean;
  collaborationSynced: boolean;
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
  cancelling: boolean;
  compileState: SharedCompileState | null;
  onCompile: () => void;
  onCancelCompile: () => void;
}

export function WorkspaceTopbar({
  site, project, activeFile, saveStateLabel, editorPreferences, activeSessions, collaborationStatus,
  reconnectCollaboration, protocolUpgradeRequired, showEditor, filesCollapsed, toggleFilesPanel, workspaceLayout,
  changeWorkspaceLayout, onBack, onShare, showCitationLibrary, citationLibraryOpen,
  onCitationLibrary, onSelectionHistory, onHistory, onGit, canManageGit, formatting, readOnly, collaborationSynced,
  hasSelection, onAddComment,
  onToggleComments, commentsOpen, unresolvedCommentCount, hasActiveFile, onToggleSettings,
  settingsOpen, compileBusy, sharedCompiling, localCompiling, cancelling, compileState, onCompile, onCancelCompile
}: WorkspaceTopbarProps) {
  const { t } = useTranslation();
  return <header className="editor-topbar">
    <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button>
    <a className="brand-link compact-brand-link" href="/" aria-label={site.siteName} onClick={(event) => { event.preventDefault(); onBack(); }}><SiteLogo siteName={site.siteName} compact /></a>
    <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {saveStateLabel}</small></div>
    {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
    <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
    {collaborationStatus === "disconnected" && !protocolUpgradeRequired && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
    <div className="editor-actions">
      {showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}
      <WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} />
      <button onClick={onShare}><Users size={15} />{t("projectSettings.share")}</button>
      {showCitationLibrary && <button className={citationLibraryOpen ? "active" : ""} onClick={onCitationLibrary}><BookMarked size={15} />{t("citationLibrary.title")}</button>}
      <div className="history-action" role="group" aria-label={t("history.title")}>
        <div className="history-action-label"><FileClock size={14} /><span>{t("history.title")}</span></div>
        <div className="history-action-options">
          <button type="button" className="history-action-selection" title={hasSelection ? t("selectionHistory.title") : t("selectionHistory.selectSourceHint")} onMouseDown={(event) => event.preventDefault()} onClick={onSelectionHistory} disabled={!hasSelection || !hasActiveFile}>{t("selectionHistory.title")}</button>
          <button type="button" className="history-action-snapshots" title={t("history.projectSnapshots")} onClick={onHistory}>{t("history.projectSnapshots")}</button>
        </div>
      </div>
      <div className="comments-action" role="group" aria-label={t("common.comments")}>
        <div className="comments-action-label"><MessageSquare size={14} /><span>{t("common.comments")}</span></div>
        <div className="comments-action-options">
          <button type="button" className="comments-action-add" title={t("editor.addComment")} aria-label={t("editor.addComment")} onMouseDown={(event) => event.preventDefault()} onClick={onAddComment} disabled={!hasActiveFile}>{t("editor.commentsAdd")}</button>
          <button type="button" className={`comments-action-all${commentsOpen ? " active" : ""}`} title={t("editor.commentsAll")} onClick={onToggleComments}>{t("editor.commentsAll")} {unresolvedCommentCount || ""}</button>
        </div>
      </div>
      <button className="git-action" title={canManageGit ? t("git.title") : t("git.ownerOnly")} disabled={!canManageGit} onClick={onGit}><GitBranch size={15} />Git</button>
      <button className={settingsOpen ? "active" : ""} onClick={onToggleSettings}><Settings size={15} />{t("common.settings")}</button>
      {sharedCompiling || localCompiling
        ? <button className="compile cancel-compile" title={t("compileControls.cancel")} onClick={onCancelCompile} disabled={cancelling || formatting || readOnly || !collaborationSynced}>{cancelling ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}{cancelling ? t("compileControls.cancelling") : t("compileControls.cancel")}</button>
        : <button className="compile" title={t("editor.compileShortcut")} onClick={onCompile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{t("editor.compile", { engine: project.engine })}</button>}
    </div>
  </header>;
}
