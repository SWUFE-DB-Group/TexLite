import { lazy, useEffect, useMemo, useState } from "react";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { AtSign, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Comment, CommentMention, FileEntry, Project, SiteConfig } from "../types";
import type { EditorPreferences } from "../editorPreferences";
import { CommentThread } from "./Comments";
import { LazyPanel } from "../LazyLoadBoundary";
import {
  adjacentReviewComment,
  buildVisibleReviewQueue,
  commentReviewPosition,
  filterCommentsForReview,
  shouldRevealAfterCommentToggle,
  type CommentReviewFilter,
  type CommentReviewScope
} from "./commentNavigation";

const ProjectSettings = lazy(() => import("./ProjectSettings").then((module) => ({ default: module.ProjectSettings })));

export interface WorkspaceContextPanelProps {
  sidePanel: "comments" | "settings" | null;
  onClose: () => void;
  project: Project;
  projectId: string;
  site: SiteConfig;
  files: FileEntry[];
  currentUserId: string;
  comments: Comment[];
  commentsLoading: boolean;
  commentsError: string;
  onRetryComments: () => Promise<void>;
  activeFile: string;
  hasProjectCommentsScope: boolean;
  commentScope: CommentReviewScope;
  onCommentScopeChange: (scope: CommentReviewScope) => void;
  focusedCommentId?: string | null;
  onClearFocusComment: () => void;
  unreadMentions: CommentMention[];
  onMarkMentionRead: (mentionId: string) => Promise<boolean>;
  onMarkAllMentionsRead: () => Promise<boolean>;
  targetCommentId?: string | null;
  targetReplyId?: string | null;
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
  sidePanel, onClose, project, projectId, site, files, currentUserId, comments, commentsLoading, commentsError, onRetryComments, unreadMentions,
  activeFile, hasProjectCommentsScope, commentScope, onCommentScopeChange, focusedCommentId, onMarkMentionRead, onMarkAllMentionsRead,
  onClearFocusComment,
  targetCommentId, targetReplyId, onFocusComment,
  onToggleComment, onReplyComment, onEditComment, onDeleteComment, onEditCommentReply,
  onDeleteCommentReply, dictionaryWords, onDictionaryChange, editorPreferences,
  onEditorPreferences, spellCheckCount, spellCheckUniqueCount, spellCheckIndex,
  onSpellCheckNavigate, onProject
}: WorkspaceContextPanelProps) {
  const { t } = useTranslation();
  const [commentFilter, setCommentFilter] = useState<CommentReviewFilter>("unresolved");
  const [revealedCommentId, setRevealedCommentId] = useState<string | null>(null);
  const reviewCounts = useMemo(() => ({
    unresolved: filterCommentsForReview(comments, { activeFile, scope: commentScope, filter: "unresolved", unreadMentions }).length,
    mentions: filterCommentsForReview(comments, { activeFile, scope: commentScope, filter: "mentions", unreadMentions }).length,
    resolved: filterCommentsForReview(comments, { activeFile, scope: commentScope, filter: "resolved", unreadMentions }).length
  }), [activeFile, commentScope, comments, unreadMentions]);
  const visibleComments = useMemo(() => buildVisibleReviewQueue(comments, {
    activeFile, scope: commentScope, filter: commentFilter, unreadMentions
  }, [revealedCommentId, targetCommentId, focusedCommentId]), [
    activeFile, commentFilter, commentScope, comments, focusedCommentId,
    revealedCommentId, targetCommentId, unreadMentions
  ]);
  const currentCommentId = focusedCommentId && visibleComments.some((comment) => comment.id === focusedCommentId)
    ? focusedCommentId
    : revealedCommentId && visibleComments.some((comment) => comment.id === revealedCommentId)
      ? revealedCommentId
      : targetCommentId && visibleComments.some((comment) => comment.id === targetCommentId)
        ? targetCommentId
        : null;
  const currentPosition = commentReviewPosition(visibleComments, currentCommentId);
  useEffect(() => {
    if (revealedCommentId && !comments.some((comment) => comment.id === revealedCommentId)) setRevealedCommentId(null);
  }, [comments, revealedCommentId]);
  useEffect(() => {
    if (!hasProjectCommentsScope && commentScope !== "file") {
      setRevealedCommentId(null);
      onClearFocusComment();
      onCommentScopeChange("file");
    }
  }, [commentScope, hasProjectCommentsScope, onClearFocusComment, onCommentScopeChange]);
  useEffect(() => {
    const selector = targetCommentId && targetReplyId
      ? `[data-comment-reply-id="${targetReplyId}"]`
      : targetCommentId
        ? `[data-comment-id="${targetCommentId}"]`
        : currentCommentId
          ? `[data-comment-id="${currentCommentId}"]`
          : "";
    if (!selector) return;
    // Comment ids are server-generated UUIDs, so an attribute selector needs
    // no browser-specific escaping support (notably useful on older Safari).
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;
    const frame = window.requestAnimationFrame(() => element.scrollIntoView({
      block: targetCommentId ? "center" : "nearest", behavior: "smooth"
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [currentCommentId, targetCommentId, targetReplyId, visibleComments]);

  const focusReviewComment = (comment: Comment) => {
    if (revealedCommentId !== comment.id) setRevealedCommentId(null);
    onFocusComment(comment);
  };
  const toggleReviewComment = async (comment: Comment) => {
    // Keep a just-resolved thread visible until the reviewer explicitly moves
    // on, rather than making the current reading position disappear.
    onFocusComment(comment);
    setRevealedCommentId(shouldRevealAfterCommentToggle(comment, commentFilter, unreadMentions) ? comment.id : null);
    await onToggleComment(comment);
  };
  const navigateReview = (direction: -1 | 1) => {
    const next = adjacentReviewComment(visibleComments, currentCommentId, direction);
    setRevealedCommentId(null);
    if (next) focusReviewComment(next);
    else onClearFocusComment();
  };
  const markReviewMentionRead = async (mentionId: string): Promise<boolean> => {
    const marked = await onMarkMentionRead(mentionId);
    if (!marked || commentFilter !== "mentions") return marked;
    const commentId = unreadMentions.find((mention) => mention.id === mentionId)?.commentId;
    if (!commentId) return marked;
    const remaining = unreadMentions.some((mention) => mention.id !== mentionId && mention.commentId === commentId);
    if (!remaining) {
      if (revealedCommentId === commentId) setRevealedCommentId(null);
      if (focusedCommentId === commentId) onClearFocusComment();
    }
    return marked;
  };
  const markAllReviewMentionsRead = async (): Promise<void> => {
    const marked = await onMarkAllMentionsRead();
    if (marked && commentFilter === "mentions") {
      setRevealedCommentId(null);
      onClearFocusComment();
    }
  };
  const selectCommentScope = (scope: CommentReviewScope) => {
    if (scope === commentScope) return;
    setRevealedCommentId(null);
    onClearFocusComment();
    onCommentScopeChange(scope);
  };
  const selectCommentFilter = (filter: CommentReviewFilter) => {
    if (filter === commentFilter) return;
    setRevealedCommentId(null);
    onClearFocusComment();
    setCommentFilter(filter);
  };
  if (!sidePanel) return null;
  return <>
    <PanelResizeHandle className="resize-handle" />
    <Panel id="context" order={4} defaultSize={20} minSize={15} maxSize={38}>
      <aside className="context-panel">
        {sidePanel === "comments" && <>
          <div className="drawer-title">
            <strong>{t("editor.sourceComments")}</strong>
            <span className="drawer-title-actions">
              {unreadMentions.length > 0 && <button className="drawer-mention-read-all" type="button" onClick={() => void markAllReviewMentionsRead()} title={t("editor.markAllMentionsRead")}><AtSign aria-hidden size={13} /><span>{t("editor.markAllMentionsRead")}</span></button>}
              <button aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
            </span>
          </div>
          <div className="comment-review-controls">
            {hasProjectCommentsScope && <div className="comment-review-group" role="group" aria-label={t("editor.commentScope")}>
              <button type="button" className={commentScope === "file" ? "active" : ""} aria-pressed={commentScope === "file"} onClick={() => selectCommentScope("file")}>{t("editor.commentScopeFile")}</button>
              <button type="button" className={commentScope === "project" ? "active" : ""} aria-pressed={commentScope === "project"} onClick={() => selectCommentScope("project")}>{t("editor.commentScopeProject")}</button>
            </div>}
            <div className="comment-review-group" role="group" aria-label={t("editor.commentFilter")}>
              <button type="button" className={commentFilter === "unresolved" ? "active" : ""} aria-pressed={commentFilter === "unresolved"} onClick={() => selectCommentFilter("unresolved")}>{t("editor.commentFilterUnresolved", { count: reviewCounts.unresolved })}</button>
              <button type="button" className={commentFilter === "mentions" ? "active" : ""} aria-pressed={commentFilter === "mentions"} onClick={() => selectCommentFilter("mentions")}>{t("editor.commentFilterMentions", { count: reviewCounts.mentions })}</button>
              <button type="button" className={commentFilter === "resolved" ? "active" : ""} aria-pressed={commentFilter === "resolved"} onClick={() => selectCommentFilter("resolved")}>{t("editor.commentFilterResolved", { count: reviewCounts.resolved })}</button>
            </div>
            <div className="comment-review-navigation">
              <button type="button" disabled={currentPosition <= 1} aria-label={t("editor.commentPrevious")} title={t("editor.commentPrevious")} onClick={() => navigateReview(-1)}><ChevronLeft size={14} /></button>
              <output aria-live="polite">{t("editor.commentPosition", { current: currentPosition, total: visibleComments.length })}</output>
              <button type="button" disabled={visibleComments.length === 0 || (currentPosition > 0 && currentPosition >= visibleComments.length)} aria-label={t("editor.commentNext")} title={t("editor.commentNext")} onClick={() => navigateReview(1)}><ChevronRight size={14} /></button>
            </div>
          </div>
          {commentsError && <div className="comment-review-error" role="alert"><span>{commentsError}</span><button type="button" onClick={() => void onRetryComments()}>{t("common.retry")}</button></div>}
          {commentsLoading && <div className="comment-review-loading" role="status">{t("common.loading")}</div>}
          <div className="comments">
            {visibleComments.map((comment) => {
              const unreadCommentMentionId = unreadMentions.find((mention) => mention.commentId === comment.id && !mention.replyId)?.id;
              const unreadReplyMentionIds = new Map(unreadMentions.filter((mention) => mention.commentId === comment.id && mention.replyId).map((mention) => [mention.replyId!, mention.id]));
              return <CommentThread key={comment.id} projectId={projectId} comment={comment} currentUserId={currentUserId}
                unreadCommentMentionId={unreadCommentMentionId} unreadReplyMentionIds={unreadReplyMentionIds}
                highlightedComment={targetCommentId === comment.id && !targetReplyId} highlightedReplyId={targetCommentId === comment.id ? targetReplyId : null}
                currentComment={currentCommentId === comment.id} showFilePath={commentScope === "project"}
                onMarkMentionRead={markReviewMentionRead} onFocus={() => focusReviewComment(comment)} onToggle={() => void toggleReviewComment(comment)} onReply={(content) => onReplyComment(comment, content)} onEdit={(content) => onEditComment(comment, content)} onDelete={() => onDeleteComment(comment)} onEditReply={(replyId, content) => onEditCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => onDeleteCommentReply(comment, replyId)} />;
            })}
            {visibleComments.length === 0 && !commentsLoading && !commentsError && <p className="muted padded">{comments.length ? t("editor.commentNoMatches") : t("editor.noComments")}</p>}
          </div>
        </>}
        {sidePanel === "settings" && <LazyPanel onClose={onClose}><ProjectSettings key={projectId} onClose={onClose} project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={onDictionaryChange} editorPreferences={editorPreferences} onEditorPreferences={onEditorPreferences} spellCheckCount={spellCheckCount} spellCheckUniqueCount={spellCheckUniqueCount} spellCheckIndex={spellCheckIndex} onSpellCheckNavigate={onSpellCheckNavigate} onProject={onProject} /></LazyPanel>}
      </aside>
    </Panel>
  </>;
}
