import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Comment, FileEntry, Project, SiteConfig } from "../types";
import type { EditorPreferences } from "../editorPreferences";
import { CommentThread } from "./Comments";
import { ProjectSettings } from "./ProjectSettings";

export interface WorkspaceContextPanelProps {
  sidePanel: "comments" | "settings" | null;
  onClose: () => void;
  project: Project;
  projectId: string;
  site: SiteConfig;
  files: FileEntry[];
  currentUserId: string;
  comments: Comment[];
  onFocusComment: (comment: Comment) => void;
  onToggleComment: (comment: Comment) => Promise<void>;
  onReplyComment: (comment: Comment, content: string) => Promise<boolean>;
  onEditComment: (comment: Comment, content: string) => Promise<boolean>;
  onDeleteComment: (comment: Comment) => Promise<boolean>;
  onEditCommentReply: (comment: Comment, replyId: string, content: string) => Promise<boolean>;
  onDeleteCommentReply: (comment: Comment, replyId: string) => Promise<boolean>;
  dictionaryWords: string[];
  onDictionaryChange: (words: string[]) => void;
  editorPreferences: EditorPreferences;
  onEditorPreferences: (preferences: EditorPreferences) => void;
  spellCheckCount: number | null;
  spellCheckUniqueCount: number | null;
  spellCheckIndex: number;
  onSpellCheckNavigate: (index: number) => void;
  onProject: (project: Project) => void;
}

export function WorkspaceContextPanel({
  sidePanel, onClose, project, projectId, site, files, currentUserId, comments, onFocusComment,
  onToggleComment, onReplyComment, onEditComment, onDeleteComment, onEditCommentReply,
  onDeleteCommentReply, dictionaryWords, onDictionaryChange, editorPreferences,
  onEditorPreferences, spellCheckCount, spellCheckUniqueCount, spellCheckIndex,
  onSpellCheckNavigate, onProject
}: WorkspaceContextPanelProps) {
  const { t } = useTranslation();
  if (!sidePanel) return null;
  return <><PanelResizeHandle className="resize-handle" /><Panel id="context" order={4} defaultSize={20} minSize={15} maxSize={38}><aside className="context-panel"><div className="drawer-title"><strong>{sidePanel === "comments" ? t("editor.sourceComments") : t("editor.projectSettings")}</strong><button aria-label={t("common.close")} onClick={onClose}><X size={17} /></button></div>
    {sidePanel === "comments" && <div className="comments">{comments.map((comment) => <CommentThread key={comment.id} comment={comment} currentUserId={currentUserId} onFocus={() => onFocusComment(comment)} onToggle={() => void onToggleComment(comment)} onReply={(content) => onReplyComment(comment, content)} onEdit={(content) => onEditComment(comment, content)} onDelete={() => onDeleteComment(comment)} onEditReply={(replyId, content) => onEditCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => onDeleteCommentReply(comment, replyId)} />)}{comments.length === 0 && <p className="muted padded">{t("editor.noComments")}</p>}</div>}
    {sidePanel === "settings" && <ProjectSettings project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={onDictionaryChange} editorPreferences={editorPreferences} onEditorPreferences={onEditorPreferences} spellCheckCount={spellCheckCount} spellCheckUniqueCount={spellCheckUniqueCount} spellCheckIndex={spellCheckIndex} onSpellCheckNavigate={onSpellCheckNavigate} onProject={onProject} />}
  </aside></Panel></>;
}
