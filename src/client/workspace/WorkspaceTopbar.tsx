import { BookMarked, FileClock, GitBranch, Keyboard, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Settings, TerminalSquare, Users, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActiveSession, CollaborationStatus } from "../collaboration";
import type { EditorPreferences } from "../editorPreferences";
import type { Project, SiteConfig } from "../types";
import type { WorkspaceLayout } from "./types";
import { CollaborationPresence, WorkspaceLayoutMenu } from "./WorkspaceChrome";
import { useTerminalPreferences } from "../terminalPreferences";
import { WorkspaceTopbarFrame } from "./WorkspaceTopbarFrame";

export interface WorkspaceTopbarProps {
  agentTerminal?: { open: boolean; activeCount: number; toggle: () => void };
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
  onCompile: () => void;
  onCancelCompile: () => void;
}

export function WorkspaceTopbar({
  site, project, activeFile, saveStateLabel, editorPreferences, activeSessions, collaborationStatus,
  reconnectCollaboration, protocolUpgradeRequired, showEditor, filesCollapsed, toggleFilesPanel, workspaceLayout,
  changeWorkspaceLayout, onBack, onShare, showCitationLibrary, citationLibraryOpen,
  onCitationLibrary, onHistory, onGit, canManageGit, formatting, readOnly, collaborationSynced,
  onToggleComments, commentsOpen, unresolvedCommentCount, onToggleSettings,
  settingsOpen, compileBusy, sharedCompiling, localCompiling, cancelling, onCompile, onCancelCompile, agentTerminal
}: WorkspaceTopbarProps) {
  const { t } = useTranslation();
  const { showExecutionReminder } = useTerminalPreferences();
  return <WorkspaceTopbarFrame siteName={site.siteName} projectName={project.name} subtitle={<>{activeFile} · {saveStateLabel}</>} onBack={onBack} accessory={<>
    {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
    <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
    {collaborationStatus === "disconnected" && !protocolUpgradeRequired && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
    </>}>
      {showEditor && <button className={!filesCollapsed ? "active" : ""} aria-label={t("common.files")} title={t("common.files")} aria-expanded={!filesCollapsed} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}<span className="workspace-action-label">{t("common.files")}</span></button>}
      <WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} />
      <button type="button" className="share-action" title={t("projectSettings.share")} aria-label={project.sharedMemberCount ? `${t("projectSettings.share")} (${project.sharedMemberCount})` : t("projectSettings.share")} onClick={onShare}>
        <Users size={15} /><span className="workspace-action-label">{t("projectSettings.share")}</span>
        {(project.sharedMemberCount ?? 0) > 0 && <sup className="share-action-count">{project.sharedMemberCount}</sup>}
      </button>
      {showCitationLibrary && <button className={`citation-action${citationLibraryOpen ? " active" : ""}`} aria-label={t("citationProject.button")} title={t("citationProject.button")} onClick={onCitationLibrary}><BookMarked size={15} /><span className="workspace-action-label">{t("citationProject.button")}</span></button>}
      <button type="button" className="snapshots-action" aria-label={t("history.projectSnapshots")} title={t("history.projectSnapshots")} onClick={onHistory}><FileClock size={15} /><span className="workspace-action-label">{t("history.projectSnapshotsButton")}</span></button>
      <button
        type="button"
        className={`comments-action${commentsOpen ? " active" : ""}`}
        title={t("editor.commentsAll")}
        aria-label={unresolvedCommentCount > 0 ? `${t("common.comments")} (${unresolvedCommentCount})` : t("common.comments")}
        onClick={onToggleComments}
      >
        <MessageSquare size={15} />
        <span className="workspace-action-label">{t("common.comments")}</span>
        {unresolvedCommentCount > 0 && <sup className="comments-action-count">{unresolvedCommentCount}</sup>}
      </button>
      <button className="git-action" aria-label={t("git.title")} title={canManageGit ? t("git.title") : t("git.ownerOnly")} disabled={!canManageGit} onClick={onGit}><GitBranch size={15} /><span className="workspace-action-label">Git</span></button>
      {agentTerminal && <button type="button" className={agentTerminal.open ? "active" : ""} aria-expanded={agentTerminal.open}
        aria-label={showExecutionReminder && agentTerminal.activeCount > 0 ? `${t("agents.terminal")}: ${t("agents.activeCount", { count: agentTerminal.activeCount })}` : t("agents.terminal")}
        title={t("agents.terminal")} onClick={agentTerminal.toggle}><TerminalSquare size={15} /><span className="workspace-action-label">{t("agents.terminal")}</span>
        {showExecutionReminder && agentTerminal.activeCount > 0 && <sup className="agent-active-count" aria-label={t("agents.activeCount", { count: agentTerminal.activeCount })}>{agentTerminal.activeCount}</sup>}
      </button>}
      <button className={settingsOpen ? "active" : ""} aria-label={t("common.settings")} title={t("common.settings")} onClick={onToggleSettings}><Settings size={15} /><span className="workspace-action-label workspace-action-label-persistent">{t("common.settings")}</span></button>
      {sharedCompiling || localCompiling
        ? <button className="compile cancel-compile" aria-label={cancelling ? t("compileControls.cancelling") : t("compileControls.cancel")} title={t("compileControls.cancel")} onClick={onCancelCompile} disabled={cancelling || formatting || readOnly || !collaborationSynced}>{cancelling ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}<span className="workspace-action-label workspace-action-label-persistent">{cancelling ? t("compileControls.cancelling") : t("compileControls.cancel")}</span></button>
        : <button className="compile" aria-label={t("editor.compile", { engine: project.engine })} title={t("editor.compileShortcut")} onClick={onCompile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}<span className="workspace-action-label workspace-action-label-persistent">{t("editor.compileShort")}<span className="compile-engine-label"> · {project.engine}</span></span></button>}
  </WorkspaceTopbarFrame>;
}
