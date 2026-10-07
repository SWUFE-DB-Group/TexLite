import { ArrowLeft, BookMarked, FileClock, GitBranch, Keyboard, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Settings, Users, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActiveSession, CollaborationStatus, SharedCompileState } from "../collaboration";
import type { EditorPreferences } from "../editorPreferences";
import type { Project, SiteConfig } from "../types";
import type { WorkspaceLayout } from "./types";
import { CollaborationPresence, WorkspaceLayoutMenu } from "./WorkspaceChrome";
import { SiteLogo } from "../pages/SiteChrome";
import { appPath } from "../basePath";

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
  onHistory: () => void;
  onGit: () => void;
  canManageGit: boolean;
  formatting: boolean;
  readOnly: boolean;
  collaborationSynced: boolean;
  onToggleComments: () => void;
  commentsOpen: boolean;
  unresolvedCommentCount: number;
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
  onCitationLibrary, onHistory, onGit, canManageGit, formatting, readOnly, collaborationSynced,
  onToggleComments, commentsOpen, unresolvedCommentCount, onToggleSettings,
  settingsOpen, compileBusy, sharedCompiling, localCompiling, cancelling, compileState, onCompile, onCancelCompile
}: WorkspaceTopbarProps) {
  const { t } = useTranslation();
  return <header className="editor-topbar">
    <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button>
    <a className="brand-link compact-brand-link" href={appPath("/")} aria-label={site.siteName} onClick={(event) => { event.preventDefault(); onBack(); }}><SiteLogo siteName={site.siteName} compact /></a>
    <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {saveStateLabel}</small></div>
    {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
    <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
    {collaborationStatus === "disconnected" && !protocolUpgradeRequired && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
    <div className="editor-actions">
      {showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}
      <WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} />
      <button onClick={onShare}><Users size={15} />{t("projectSettings.share")}</button>
      {showCitationLibrary && <button className={citationLibraryOpen ? "active" : ""} onClick={onCitationLibrary}><BookMarked size={15} />{t("citationLibrary.title")}</button>}
      <button type="button" className="snapshots-action" title={t("history.projectSnapshots")} onClick={onHistory}><FileClock size={15} />{t("history.projectSnapshotsButton")}</button>
      <button
        type="button"
        className={`comments-action${commentsOpen ? " active" : ""}`}
        title={t("editor.commentsAll")}
        aria-label={unresolvedCommentCount > 0 ? `${t("common.comments")} (${unresolvedCommentCount})` : t("common.comments")}
        onClick={onToggleComments}
      >
        <MessageSquare size={15} />
        <span>{t("common.comments")}</span>
        {unresolvedCommentCount > 0 && <sup className="comments-action-count">{unresolvedCommentCount}</sup>}
      </button>
      <button className="git-action" title={canManageGit ? t("git.title") : t("git.ownerOnly")} disabled={!canManageGit} onClick={onGit}><GitBranch size={15} />Git</button>
      <button className={settingsOpen ? "active" : ""} onClick={onToggleSettings}><Settings size={15} />{t("common.settings")}</button>
      {sharedCompiling || localCompiling
        ? <button className="compile cancel-compile" title={t("compileControls.cancel")} onClick={onCancelCompile} disabled={cancelling || formatting || readOnly || !collaborationSynced}>{cancelling ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}{cancelling ? t("compileControls.cancelling") : t("compileControls.cancel")}</button>
        : <button className="compile" title={t("editor.compileShortcut")} onClick={onCompile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{t("editor.compile", { engine: project.engine })}</button>}
    </div>
  </header>;
}
