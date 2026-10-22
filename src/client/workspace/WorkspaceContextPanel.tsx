import { lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Panel, Separator } from "react-resizable-panels";
import { ArrowDown, ArrowUp, AtSign, ChevronLeft, ChevronRight, MessagesSquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Comment, CommentMention, FileEntry, Project, SiteConfig } from "../types";
import type { EditorPreferences } from "../editorPreferences";
import { CommentThread } from "./Comments";
import { CommentParticipantFilter } from "./CommentParticipantFilter";
import { LazyPanel } from "../LazyLoadBoundary";
import { COMMENT_EXIT_DURATION_MS, useCommentReviewTransitions } from "./useCommentReviewTransitions";
import type { CommentDraftStore } from "./commentDrafts";
import {
  adjacentReviewComment,
  buildVisibleReviewQueue,
  collectCommentParticipants,
  currentOpenComment,
  commentReviewPosition,
  filterCommentsForReview,
  type CommentReviewFilter,
  type CommentReviewSort,
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
  commentDraftStore: CommentDraftStore;
  commentsLoading: boolean;
  commentsError: string;
  onRetryComments: () => Promise<void>;
  activeFile: string;
  singleCommentId?: string | null;
  onShowAllComments: () => void;
  hasProjectCommentsScope: boolean;
  commentScope: CommentReviewScope;
  onCommentScopeChange: (scope: CommentReviewScope) => void;
  focusedCommentId?: string | null;
  commentFocusNonce?: number;
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
  sidePanel, onClose, project, projectId, site, files, currentUserId, comments, commentDraftStore, commentsLoading, commentsError, onRetryComments, unreadMentions,
  activeFile, singleCommentId, onShowAllComments, hasProjectCommentsScope, commentScope, onCommentScopeChange, focusedCommentId, commentFocusNonce, onMarkMentionRead, onMarkAllMentionsRead,
  onClearFocusComment,
  targetCommentId, targetReplyId, onFocusComment,
  onToggleComment, onReplyComment, onEditComment, onDeleteComment, onEditCommentReply,
  onDeleteCommentReply, dictionaryWords, onDictionaryChange, editorPreferences,
  onEditorPreferences, spellCheckCount, spellCheckUniqueCount, spellCheckIndex,
  onSpellCheckNavigate, onProject
}: WorkspaceContextPanelProps) {
  const { t } = useTranslation();
  const singleCommentMode = Boolean(singleCommentId);
  const [commentFilter, setCommentFilter] = useState<CommentReviewFilter>("unresolved");
  const [unreadMentionsOnly, setUnreadMentionsOnly] = useState(false);
  const [commentSort, setCommentSort] = useState<CommentReviewSort>("source");
  const [participantIds, setParticipantIds] = useState<Set<string | null>>(() => new Set());
  const [topLevelOnly, setTopLevelOnly] = useState(true);
  // View preferences survive thread unmounts and ordinary resource refreshes;
  // they do not belong to the shared comment data or the draft/request store.
  const [replyExpansion, setReplyExpansion] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [activeComposerId, setActiveComposerId] = useState<string | null>(null);
  const previousResolution = useRef(new Map(comments.map((comment) => [comment.id, comment.resolved])));
  const participants = useMemo(() => collectCommentParticipants(comments), [comments]);
  const reviewCounts = useMemo(() => {
    const options = { activeFile, scope: commentScope, unreadMentions, participantIds, topLevelOnly, unreadMentionsOnly };
    return {
      unresolved: filterCommentsForReview(comments, { ...options, filter: "unresolved" }).length,
      resolved: filterCommentsForReview(comments, { ...options, filter: "resolved" }).length,
      mentions: filterCommentsForReview(comments, { ...options, filter: commentFilter, unreadMentionsOnly: true }).length
    };
  }, [activeFile, commentScope, comments, unreadMentions, participantIds, topLevelOnly, commentFilter, unreadMentionsOnly]);
  const visibleComments = useMemo(() => singleCommentId ? currentOpenComment(comments, singleCommentId, activeFile) : buildVisibleReviewQueue(comments, {
    activeFile, scope: commentScope, filter: commentFilter, unreadMentions, sort: commentSort, participantIds, topLevelOnly, unreadMentionsOnly
  }, [targetCommentId, focusedCommentId]), [
    activeFile, singleCommentId, commentFilter, commentScope, comments, focusedCommentId,
    targetCommentId, unreadMentions, commentSort, participantIds, topLevelOnly, unreadMentionsOnly
  ]);
  const navigationCommentId = focusedCommentId && visibleComments.some((comment) => comment.id === focusedCommentId)
    ? focusedCommentId
    : targetCommentId && visibleComments.some((comment) => comment.id === targetCommentId)
        ? targetCommentId
        : null;
  const currentCommentId = singleCommentMode ? visibleComments[0]?.id ?? null
    : activeComposerId && visibleComments.some((comment) => comment.id === activeComposerId)
      ? activeComposerId : navigationCommentId;
  useEffect(() => {
    // Source/mention navigation takes precedence over a previous inline form.
    setActiveComposerId(null);
  }, [focusedCommentId, commentFocusNonce, targetCommentId, targetReplyId, activeFile, commentScope]);
  useEffect(() => {
    if (activeComposerId && !visibleComments.some((comment) => comment.id === activeComposerId)) setActiveComposerId(null);
  }, [activeComposerId, visibleComments]);
  const currentPosition = commentReviewPosition(visibleComments, currentCommentId);
  const transitionContext = JSON.stringify([
    sidePanel, singleCommentId, commentScope, commentScope === "file" ? activeFile : "", commentFilter,
    commentSort, [...participantIds].sort(), topLevelOnly, unreadMentionsOnly
  ]);
  const { entries: displayedComments, finishExit } = useCommentReviewTransitions(visibleComments, comments, singleCommentMode ? "unresolved" : commentFilter, transitionContext);
  useEffect(() => {
    // A navigation reveal is temporary, not an exemption from future status
    // changes (including a coauthor resolving the currently focused thread).
    const changedFocus = comments.some((comment) => (comment.id === focusedCommentId || comment.id === targetCommentId)
      && previousResolution.current.has(comment.id) && previousResolution.current.get(comment.id) !== comment.resolved);
    previousResolution.current = new Map(comments.map((comment) => [comment.id, comment.resolved]));
    if (changedFocus) onClearFocusComment();
  }, [comments, focusedCommentId, targetCommentId, onClearFocusComment]);
  useEffect(() => {
    // An inline composer owns focus; never scroll an older navigation target
    // while replying, including after an ordinary comment-resource refresh.
    if (sidePanel !== "comments" || activeComposerId) return;
    const selector = targetCommentId && targetReplyId
      ? `.comments [data-comment-reply-id="${targetReplyId}"]`
      : targetCommentId
        ? `.comments .comment-thread[data-comment-id="${targetCommentId}"]`
       : navigationCommentId
          ? `.comments .comment-thread[data-comment-id="${navigationCommentId}"]`
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
  }, [sidePanel, activeComposerId, navigationCommentId, commentFocusNonce, targetCommentId, targetReplyId, visibleComments]);

  const focusReviewComment = (comment: Comment) => {
    setActiveComposerId(null);
    onFocusComment(comment);
  };
  const navigateReview = (direction: -1 | 1) => {
    const next = adjacentReviewComment(visibleComments, currentCommentId, direction);
    if (next) focusReviewComment(next);
    else onClearFocusComment();
  };
  const markReviewMentionRead = async (mentionId: string): Promise<boolean> => {
    const marked = await onMarkMentionRead(mentionId);
    if (!marked || singleCommentMode || !unreadMentionsOnly) return marked;
    const commentId = unreadMentions.find((mention) => mention.id === mentionId)?.commentId;
    if (!commentId) return marked;
    const remaining = unreadMentions.some((mention) => mention.id !== mentionId && mention.commentId === commentId);
    if (!remaining) {
      if (focusedCommentId === commentId || targetCommentId === commentId) onClearFocusComment();
    }
    return marked;
  };
  const markAllReviewMentionsRead = async (): Promise<void> => {
    const marked = await onMarkAllMentionsRead();
    if (marked && unreadMentionsOnly) {
      onClearFocusComment();
    }
  };
  const selectCommentScope = (scope: CommentReviewScope) => {
    if (scope === commentScope) return;
    setActiveComposerId(null);
    onClearFocusComment();
    onCommentScopeChange(scope);
  };
  const selectCommentFilter = (filter: CommentReviewFilter) => {
    if (filter === commentFilter) return;
    setActiveComposerId(null);
    onClearFocusComment();
    setCommentFilter(filter);
  };
  const clearReviewFocus = () => {
    setActiveComposerId(null);
    onClearFocusComment();
  };
  const toggleParticipant = (id: string | null) => {
    clearReviewFocus();
    if (participantIds.size === 1 && participantIds.has(id)) setTopLevelOnly(true);
    setParticipantIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  if (!sidePanel) return null;
  return <>
    <Separator className="resize-handle" />
    <Panel id="context" defaultSize="20%" minSize="15%" maxSize="38%">
      <aside className="context-panel">
        {sidePanel === "comments" && <>
          <div className="drawer-title">
            <strong>{t(singleCommentMode ? "editor.currentComment" : "editor.sourceComments")}</strong>
            <span className="drawer-title-actions">
              {!singleCommentMode && unreadMentions.length > 0 && <button className="drawer-mention-read-all" type="button" onClick={() => void markAllReviewMentionsRead()} title={t("editor.markAllMentionsRead")}><AtSign aria-hidden size={13} /><span>{t("editor.markAllMentionsRead")}</span></button>}
              <button aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
            </span>
          </div>
          {singleCommentMode ? <div className="comment-current-controls">
            <button type="button" onClick={onShowAllComments}><MessagesSquare size={14} aria-hidden />{t("editor.viewAllComments")}</button>
          </div> : <div className="comment-review-controls">
            <div className="comment-review-queue-row">
              {hasProjectCommentsScope && <div className="comment-review-group" role="group" aria-label={t("editor.commentScope")}>
                <button type="button" className={commentScope === "file" ? "active" : ""} aria-pressed={commentScope === "file"} onClick={() => selectCommentScope("file")}>{t("editor.commentScopeFile")}</button>
                <button type="button" className={commentScope === "project" ? "active" : ""} aria-pressed={commentScope === "project"} onClick={() => selectCommentScope("project")}>{t("editor.commentScopeProject")}</button>
              </div>}
              <div className="comment-review-group" role="group" aria-label={t("editor.commentFilter")}>
                <button type="button" className={commentFilter === "unresolved" ? "active" : ""} aria-pressed={commentFilter === "unresolved"} onClick={() => selectCommentFilter("unresolved")}>{t("editor.commentFilterUnresolved", { count: reviewCounts.unresolved })}</button>
                <button type="button" className={commentFilter === "resolved" ? "active" : ""} aria-pressed={commentFilter === "resolved"} onClick={() => selectCommentFilter("resolved")}>{t("editor.commentFilterResolved", { count: reviewCounts.resolved })}</button>
              </div>
              <div className="comment-review-navigation">
                <button type="button" disabled={currentPosition <= 1} aria-label={t("editor.commentPrevious")} title={t("editor.commentPrevious")} onClick={() => navigateReview(-1)}><ChevronLeft size={14} /></button>
                <output aria-live="polite">{t("editor.commentPosition", { current: currentPosition, total: visibleComments.length })}</output>
                <button type="button" disabled={visibleComments.length === 0 || (currentPosition > 0 && currentPosition >= visibleComments.length)} aria-label={t("editor.commentNext")} title={t("editor.commentNext")} onClick={() => navigateReview(1)}><ChevronRight size={14} /></button>
              </div>
            </div>
            <div className="comment-review-sort-row">
              <CommentParticipantFilter key={`${commentScope}:${commentScope === "file" ? activeFile : "project"}`}
                participants={participants} selectedIds={participantIds} topLevelOnly={topLevelOnly} onToggle={toggleParticipant}
                onClear={() => { clearReviewFocus(); setParticipantIds(new Set()); setTopLevelOnly(true); }}
                onTopLevelOnlyChange={(value) => { clearReviewFocus(); setTopLevelOnly(value); }} />
              <button type="button" className={`comment-unread-toggle${unreadMentionsOnly ? " active" : ""}`} aria-pressed={unreadMentionsOnly}
                aria-label={t("editor.commentUnreadMentionsHint")} title={t("editor.commentUnreadMentionsHint")}
                onClick={() => { clearReviewFocus(); setUnreadMentionsOnly((current) => !current); }}>
                <AtSign size={12} aria-hidden />{t("editor.commentUnreadMentionsOnly")}<span>{reviewCounts.mentions}</span>
              </button>
              <label className="comment-review-sort" data-texlite-tooltip-always data-tooltip={t(commentSort === "source" ? "editor.commentSortSource" : "editor.commentSortTime")}>
                <span className="sr-only">{t("editor.commentSort")}</span>{commentSort === "source" ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />}
                <select value={commentSort} aria-label={`${t("editor.commentSort")}: ${t(commentSort === "source" ? "editor.commentSortSource" : "editor.commentSortTime")}`}
                  onChange={(event) => setCommentSort(event.target.value as CommentReviewSort)}>
                  <option value="source">{t("editor.commentSortSourceShort")}</option>
                  <option value="time">{t("editor.commentSortTimeShort")}</option>
                </select>
              </label>
            </div>
          </div>}
          {commentsError && <div className="comment-review-error" role="alert"><span>{commentsError}</span><button type="button" onClick={() => void onRetryComments()}>{t("common.retry")}</button></div>}
          {commentsLoading && <div className="comment-review-loading" role="status">{t("common.loading")}</div>}
          <div className="comments">
            {displayedComments.map(({ comment, exitAt }) => {
              const unreadCommentMentionId = unreadMentions.find((mention) => mention.commentId === comment.id && !mention.replyId)?.id;
              const unreadReplyMentionIds = new Map(unreadMentions.filter((mention) => mention.commentId === comment.id && mention.replyId).map((mention) => [mention.replyId!, mention.id]));
              return <div key={comment.id} className={`comment-thread-slot${exitAt !== null ? " is-exiting" : ""}`}
                inert={exitAt !== null ? true : undefined} aria-hidden={exitAt !== null ? true : undefined}
                style={{ "--comment-exit-duration": `${COMMENT_EXIT_DURATION_MS}ms` } as CSSProperties}
                onAnimationEnd={(event) => { if (event.target === event.currentTarget && exitAt !== null) finishExit(comment.id); }}>
                <div className="comment-thread-slot-content"><CommentThread projectId={projectId} comment={comment} draftStore={commentDraftStore} currentUserId={currentUserId}
                unreadCommentMentionId={unreadCommentMentionId} unreadReplyMentionIds={unreadReplyMentionIds}
                highlightedComment={targetCommentId === comment.id && !targetReplyId} highlightedReplyId={targetCommentId === comment.id ? targetReplyId : null}
                currentComment={currentCommentId === comment.id} showFilePath={!singleCommentMode && commentScope === "project" && hasProjectCommentsScope}
                replyExpansion={replyExpansion.get(comment.id)} onReplyExpansionChange={(expanded) => {
                  setReplyExpansion((current) => current.get(comment.id) === expanded ? current : new Map(current).set(comment.id, expanded));
                }}
                selectedParticipantIds={singleCommentMode ? undefined : participantIds} highlightReplyParticipants={!singleCommentMode && !topLevelOnly}
                onMarkMentionRead={markReviewMentionRead} onFocus={() => focusReviewComment(comment)} onActivate={() => setActiveComposerId(comment.id)} onToggle={() => onToggleComment(comment)} onReply={(content) => onReplyComment(comment, content)} onEdit={(content) => onEditComment(comment, content)} onDelete={() => onDeleteComment(comment)} onEditReply={(replyId, content) => onEditCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => onDeleteCommentReply(comment, replyId)} /></div></div>;
            })}
            {displayedComments.length === 0 && !commentsLoading && !commentsError && <p className="muted padded" role="status">{singleCommentMode
              ? t(comments.some((comment) => comment.id === singleCommentId && comment.resolved) ? "editor.currentCommentResolved" : "editor.currentCommentUnavailable")
              : comments.length ? t("editor.commentNoMatches") : t("editor.noComments")}</p>}
          </div>
        </>}
        {sidePanel === "settings" && <LazyPanel onClose={onClose}><ProjectSettings key={projectId} onClose={onClose} project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={onDictionaryChange} editorPreferences={editorPreferences} onEditorPreferences={onEditorPreferences} spellCheckCount={spellCheckCount} spellCheckUniqueCount={spellCheckUniqueCount} spellCheckIndex={spellCheckIndex} onSpellCheckNavigate={onSpellCheckNavigate} onProject={onProject} /></LazyPanel>}
      </aside>
    </Panel>
  </>;
}
