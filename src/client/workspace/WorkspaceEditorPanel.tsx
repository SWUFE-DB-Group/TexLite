import { lazy, Suspense, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BookOpen, FileText, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel } from "react-resizable-panels";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Comment, FileEntry, LatexCompletionIndex, Project } from "../types";
import type { EditorPreferences } from "../editorPreferences";
import type { SpellCheckIssue } from "../spellCheck";
import type { SpellCheckJump } from "../LatexEditor";

const LatexEditor = lazy(() => import("../LatexEditor").then((module) => ({ default: module.LatexEditor })));

export interface WorkspaceEditorPanelProps {
  project: Project;
  activeFile: string;
  activeMainFile: string;
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
  updateEditorContent: (value: string) => void;
  setSelection: (selectedText: string, startOffset: number, endOffset: number) => void;
  onCommentClick: (id: string) => void;
  onSpellCheckReplace: (issue: SpellCheckIssue, replacement: string) => void;
  onCursor: (line: number, column: number, offset: number) => void;
}

export function WorkspaceEditorPanel({
  project, activeFile, activeMainFile, openTabs, content, loadedFile, readOnly, comments, focusComment,
  editorPreferences, completionIndex, nativeSpellCheck, spellCheckIssues, spellCheckJump, sourceJump,
  collaborativeText, collaborationAwareness, undoManager, editorNotice, activateTab, closeTab,
  handleTabKeyDown, updateEditorContent, setSelection, onCommentClick, onSpellCheckReplace, onCursor
}: WorkspaceEditorPanelProps) {
  const { t } = useTranslation();
  return <Panel id="source" order={2} defaultSize={42} minSize={22}>
    <main className="source-panel">
      {editorPreferences.openFilesInTabs && openTabs.length > 0 && (
        <div className="editor-tabs-bar" role="tablist" aria-label={t("editor.openFiles")}>
          <div className="editor-tabs-scroll">
            {openTabs.map((tabPath, index) => {
              const isActive = tabPath === activeFile;
              const isMain = tabPath === (activeMainFile || project.mainFile);
              const fileName = tabPath.split("/").at(-1) || tabPath;
              return <div className={`editor-tab-item${isActive ? " active" : ""}`} role="presentation" key={tabPath}>
                <button id={`editor-tab-${encodeURIComponent(tabPath)}`} type="button" role="tab" aria-selected={isActive} aria-controls="editor-source-content" tabIndex={isActive ? 0 : -1} className={`editor-tab${isActive ? " active" : ""}${isMain ? " main-tab" : ""}`} onClick={() => activateTab(tabPath)} onKeyDown={(event) => handleTabKeyDown(event, index)} title={tabPath}>
                  <span className="editor-tab-icon">{isMain ? <BookOpen size={13} /> : <FileText size={13} />}</span>
                  <span className="editor-tab-title">{fileName}</span>
                  {isMain && <small className="editor-tab-badge">{t("editor.currentMainShort")}</small>}
                </button>
                <button type="button" className="editor-tab-close" title={t("common.close")} aria-label={`${t("common.close")} ${fileName}`} onClick={() => closeTab(tabPath)}><X size={12} /></button>
              </div>;
            })}
          </div>
        </div>
      )}
      <div id="editor-source-content" className="editor-content-container">
        <Suspense fallback={<div className="preview-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
          <LatexEditor key={activeFile} value={content} filePath={activeFile} readOnly={readOnly} comments={comments} focusComment={focusComment} preferences={editorPreferences} nativeSpellCheck={nativeSpellCheck} completionIndex={completionIndex} spellCheckIssues={spellCheckIssues} spellCheckJump={spellCheckJump} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={0} collaboration={collaborativeText ? { text: collaborativeText, awareness: collaborationAwareness, undoManager: readOnly ? undefined : undoManager } : undefined} onChange={updateEditorContent} onSelection={setSelection} onCommentClick={onCommentClick} onSpellCheckReplace={onSpellCheckReplace} onCursor={onCursor} />
        </Suspense>
        {editorNotice && <div className="editor-centered-notice" role="status" aria-live="polite">{editorNotice}</div>}
      </div>
    </main>
  </Panel>;
}
