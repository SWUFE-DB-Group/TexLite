import { lazy, Suspense, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LoaderCircle } from "lucide-react";
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

export interface WorkspaceEditorPanelProps {
  figurePdf?: WorkspaceFigurePdf | null;
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
  sourceJump: { path: string; line: number; column: number; nonce: number } | null;
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
  editorPreferences, completionIndex, nativeSpellCheck, spellCheckIssues, spellCheckJump, sourceJump,
  collaborativeText, collaborationAwareness, undoManager, editorNotice, activateTab, closeTab,
  handleTabKeyDown, reorderTab, updateEditorContent, setSelection, onAddComment, onSelectionHistory, onCommentClick, onSpellCheckReplace, onReferenceNavigate, onCursor, terminal, mobileSync,
  figurePdf = null, agentChanges = null, activeAgentChangeId = null, agentChangeReveal = null, onAgentChangesStale, onOpenAgentChange
}: WorkspaceEditorPanelProps) {
  const { t } = useTranslation();
  // Comment offsets are meaningful only for the source document which
  // produced them. Keep a late response or cross-file review selection from
  // decorating the newly mounted editor tab.
  const editorComments = commentsForEditorFile(comments, activeFile);
  const editorFocusComment = focusCommentForEditorFile(focusComment, activeFile, loadedFile);
  return <Panel id="source" minSize="22%">
    <EditorTerminalLayout terminal={terminal} tabs={editorPreferences.openFilesInTabs && openTabs.length > 0 && (
        <EditorTabs openTabs={openTabs} activeFile={activeFile} projectMainFile={project.mainFile} activateTab={activateTab} closeTab={closeTab} handleTabKeyDown={handleTabKeyDown} reorderTab={reorderTab} />
      )}>
      <div id="editor-source-content" className="editor-content-container editor-content-column">
        {figurePdf && <div className="figure-pdf-bar"><TikzCompileButton {...figurePdf} /></div>}
        <div className="editor-content-fill">
        <Suspense fallback={<div className="preview-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
          <LatexEditor key={activeFile} value={content} projectId={projectId} filePath={activeFile} mainFile={mainFile} readOnly={readOnly} comments={editorComments} focusComment={editorFocusComment} preferences={editorPreferences} nativeSpellCheck={nativeSpellCheck} completionIndex={completionIndex} spellCheckIssues={spellCheckIssues} spellCheckJump={spellCheckJump} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={0} collaboration={collaborativeText ? { text: collaborativeText, awareness: collaborationAwareness, undoManager: readOnly ? undefined : undoManager } : undefined} onChange={updateEditorContent} onSelection={setSelection} onAddComment={onAddComment} onSelectionHistory={onSelectionHistory} onCommentClick={onCommentClick} onSpellCheckReplace={onSpellCheckReplace} onReferenceNavigate={onReferenceNavigate} onCursor={onCursor}
            agentChanges={agentChanges} activeAgentChangeId={activeAgentChangeId} agentChangeReveal={agentChangeReveal} onAgentChangesStale={onAgentChangesStale} onOpenAgentChange={onOpenAgentChange} />
        </Suspense>
        </div>
        {editorNotice && <div className="editor-centered-notice" role="status" aria-live="polite">{editorNotice}</div>}
        {mobileSync && <WorkspaceMobileSyncButton direction="pdf" {...mobileSync} />}
      </div>
    </EditorTerminalLayout>
  </Panel>;
}
