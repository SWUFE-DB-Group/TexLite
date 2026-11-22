import { lazy, Suspense, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AlignLeft, LoaderCircle, Search } from "lucide-react";
import { EditorTabs } from "./EditorTabs";
import { TikzCompileButton } from "./TikzCompileButton";
import type { LatexEngine, TikzFigurePdfState } from "./useTikzFigurePdf";
import { useTranslation } from "react-i18next";
import { Panel } from "react-resizable-panels";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Comment, LatexCompletionIndex, Project } from "../types";
import type { EditorPreferences } from "../editorPreferences";
import type { SpellCheckIssue } from "../spellCheck";
import type { SpellCheckJump } from "../LatexEditor";
import type { LatexReference } from "../../shared/latexReferences";
import type { AgentChange } from "../../shared/agentProtocol";
import { commentsForEditorFile, focusCommentForEditorFile } from "./commentNavigation";
import type { SelectionLineAction } from "../selectionLineActions";
import { EditorTerminalLayout, type TerminalPanelRenderer } from "./EditorTerminalLayout";
import { WorkspaceMobileSyncButton } from "./WorkspaceMobileSyncButton";
import type { SourceJump } from "./useSyncTeX";
import { formatShortcutKey } from "../shortcuts";

const LatexEditor = lazy(() => import("../LatexEditor").then((module) => ({ default: module.LatexEditor })));

/** Offered while the open file is a standalone TikZ figure the user may edit. */
export interface WorkspaceFigurePdf {
  state: TikzFigurePdfState;
  disabled: boolean;
  engine: LatexEngine;
  engines: LatexEngine[];
  onEngineChange: (engine: LatexEngine) => void;
  onCompile: () => void;
}

/** Offered while the open file is a formattable TeX/BibTeX source the user may edit. */
export interface WorkspaceFormatControls {
  busy: boolean;
  disabled: boolean;
  hasSelection: boolean;
  onFormatFile: () => void;
  onFormatSelection: () => void;
}

export interface WorkspaceEditorPanelProps {
  alternativeEditor?: ReactNode;
  figurePdf?: WorkspaceFigurePdf | null;
  formatControls?: WorkspaceFormatControls | null;
  mobileSync?: { disabled: boolean; onClick: () => Promise<void>; label?: string };
  terminal?: TerminalPanelRenderer | null;
  project: Project;
  projectId: string;
  activeFile: string;
  mainFile: string;
  openTabs: string[];
  content: string;
  loadedFile: string;
  readOnly: boolean;
  comments: Comment[];
  focusComment: Comment | null;
  editorPreferences: EditorPreferences;
  completionIndex: LatexCompletionIndex | null;
  nativeSpellCheck: boolean;
  spellCheckIssues: SpellCheckIssue[];
  spellCheckJump: SpellCheckJump | null;
  sourceJump: SourceJump | null;
  onSourceJumpHandled: (nonce: number) => void;
  collaborativeText: Y.Text | null;
  collaborationAwareness: Awareness;
  undoManager?: Y.UndoManager;
  editorNotice: string;
  activateTab: (path: string) => void;
  closeTab: (path: string) => void;
  handleTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  reorderTab: (path: string, to: number) => void;
  updateEditorContent: (value: string) => void;
  setSelection: (selectedText: string, startOffset: number, endOffset: number) => void;
  onAddComment: (selectedText: string, startOffset: number, endOffset: number, source: string) => void;
  onSelectionHistory: SelectionLineAction;
  onCommentClick: (id: string, toggle?: boolean) => void;
  onSpellCheckReplace: (issue: SpellCheckIssue, replacement: string) => void;
  onReferenceNavigate: (reference: LatexReference) => void;
  onCursor: (line: number, column: number, offset: number) => void;
  /** Unreviewed coding-agent changes in the active file, for highlighting. */
  agentChanges?: { sourceHash: string; changes: AgentChange[] } | null;
  activeAgentChangeId?: string | null;
  agentChangeReveal?: { id: string; nonce: number } | null;
  onAgentChangesStale?: () => void;
  onOpenAgentChange?: (id: string) => void;
}

export function WorkspaceEditorPanel({
  project, projectId, activeFile, mainFile, openTabs, content, loadedFile, readOnly, comments, focusComment,
  editorPreferences, completionIndex, nativeSpellCheck, spellCheckIssues, spellCheckJump, sourceJump, onSourceJumpHandled,
  collaborativeText, collaborationAwareness, undoManager, editorNotice, activateTab, closeTab,
  handleTabKeyDown, reorderTab, updateEditorContent, setSelection, onAddComment, onSelectionHistory, onCommentClick, onSpellCheckReplace, onReferenceNavigate, onCursor, terminal, mobileSync,
  alternativeEditor, figurePdf = null, formatControls = null, agentChanges = null, activeAgentChangeId = null, agentChangeReveal = null, onAgentChangesStale, onOpenAgentChange
}: WorkspaceEditorPanelProps) {
  const { t } = useTranslation();
  const searchNonceRef = useRef(0);
  const [pendingSearch, setPendingSearch] = useState<{ path: string; nonce: number } | null>(null);
  const activeSearchRequest = pendingSearch?.path === activeFile ? pendingSearch.nonce : 0;
  // Comment offsets are meaningful only for the source document which
  // produced them. Keep a late response or cross-file review selection from
  // decorating the newly mounted editor tab.
  const editorComments = commentsForEditorFile(comments, activeFile);
  const editorFocusComment = focusCommentForEditorFile(focusComment, activeFile, loadedFile);
  // A permission change can replace the undo binding. A temporary disconnect
  // changes only readOnly, so it keeps the same editor and history.
  const editorKey = `${activeFile}:${undoManager ? "undo" : "no-undo"}`;
  const collaboration = collaborativeText ? { text: collaborativeText, awareness: collaborationAwareness, undoManager } : undefined;
  const showTabs = !alternativeEditor && editorPreferences.openFilesInTabs && openTabs.length > 0;
  const searchAction = !alternativeEditor ? (
    <button type="button" className="editor-context-action"
      title={t(readOnly ? "editor.search.findOnlyHint" : "editor.search.findReplaceHint")}
      data-shortcut={formatShortcutKey("F")}
      aria-label={t(readOnly ? "editor.search.find" : "editor.search.findReplace")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setPendingSearch({ path: activeFile, nonce: ++searchNonceRef.current })}>
      <Search size={12} aria-hidden="true" />
      <span className="editor-context-action-label">{t(readOnly ? "editor.search.find" : "editor.search.findReplace")}</span>
    </button>
  ) : null;
  const formatAction = !alternativeEditor && formatControls ? (
    <button type="button" className={`editor-context-action${formatControls.hasSelection ? " is-selection" : ""}`}
      title={t(formatControls.hasSelection ? "editor.formatSelection" : "editor.formatFileHint")}
      aria-label={t(formatControls.hasSelection ? "editor.formatSelection" : "editor.formatFileHint")}
      aria-busy={formatControls.busy}
      onMouseDown={(event) => event.preventDefault()}
      onClick={formatControls.hasSelection ? formatControls.onFormatSelection : formatControls.onFormatFile}
      disabled={formatControls.disabled}>
      {formatControls.busy ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <AlignLeft size={12} aria-hidden="true" />}
      <span className="editor-context-action-label">{t(formatControls.hasSelection ? "editor.formatSelection" : "editor.formatDocument")}</span>
    </button>
  ) : null;
  const editorContextActions = searchAction || formatAction ? (
    <>
      {searchAction}
      {searchAction && formatAction && <span className="editor-actions-divider" aria-hidden="true" />}
      {formatAction}
    </>
  ) : null;
  const showContextBar = Boolean(figurePdf) || (!showTabs && Boolean(editorContextActions));
  return <Panel id="source" minSize="22%">
    <EditorTerminalLayout terminal={terminal} tabs={showTabs && (
        <EditorTabs openTabs={openTabs} activeFile={activeFile} projectMainFile={project.mainFile} activateTab={activateTab} closeTab={closeTab} handleTabKeyDown={handleTabKeyDown} reorderTab={reorderTab} actions={editorContextActions} />
      )}>
      {alternativeEditor || <div id="editor-source-content" className="editor-content-container editor-content-column">
        {showContextBar && <div className="figure-pdf-bar">{!showTabs && editorContextActions}{figurePdf && <TikzCompileButton {...figurePdf} />}</div>}
        <div className="editor-content-fill">
        <Suspense fallback={<div className="preview-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
          <LatexEditor key={editorKey} value={content} projectId={projectId} filePath={activeFile} mainFile={mainFile} readOnly={readOnly} comments={editorComments} focusComment={editorFocusComment} preferences={editorPreferences} nativeSpellCheck={nativeSpellCheck} completionIndex={completionIndex} spellCheckIssues={spellCheckIssues} spellCheckJump={spellCheckJump} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={activeSearchRequest} onSearchRequestHandled={(nonce) => setPendingSearch((current) => current?.nonce === nonce ? null : current)} collaboration={collaboration} onChange={updateEditorContent} onSelection={setSelection} onAddComment={onAddComment} onSelectionHistory={onSelectionHistory} onCommentClick={onCommentClick} onSpellCheckReplace={onSpellCheckReplace} onReferenceNavigate={onReferenceNavigate} onCursor={onCursor}
            onSourceJumpHandled={onSourceJumpHandled}
            agentChanges={agentChanges} activeAgentChangeId={activeAgentChangeId} agentChangeReveal={agentChangeReveal} onAgentChangesStale={onAgentChangesStale} onOpenAgentChange={onOpenAgentChange} />
        </Suspense>
        </div>
        {editorNotice && <div className="editor-centered-notice" role="status" aria-live="polite">{editorNotice}</div>}
        {mobileSync && <WorkspaceMobileSyncButton direction="pdf" {...mobileSync} />}
      </div>}
    </EditorTerminalLayout>
  </Panel>;
}
