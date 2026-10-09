import type { Comment, CommentMention, CommentReply } from "../types";

/** The source range represented by the comments review drawer. */
export type CommentReviewScope = "file" | "project";

/** Resolution status is independent from the unread-mention filter. */
export type CommentReviewFilter = "unresolved" | "resolved";
export type CommentReviewSort = "source" | "time";
export type CommentParticipant = Pick<CommentReply, "authorId" | "authorUsername" | "authorDisplayName">;

export interface CommentReviewOptions {
  activeFile: string;
  scope: CommentReviewScope;
  filter: CommentReviewFilter;
  unreadMentions: readonly CommentMention[];
  sort?: CommentReviewSort;
  participantIds?: ReadonlySet<string | null>;
  topLevelOnly?: boolean;
  unreadMentionsOnly?: boolean;
}

/** Null authors are grouped as Deleted User, consistently with thread display. */
export function collectCommentParticipants(comments: readonly Comment[]): CommentParticipant[] {
  const participants = new Map<string | null, CommentParticipant>();
  for (const comment of comments) {
    for (const author of [comment, ...comment.replies]) {
      if (!participants.has(author.authorId)) {
        participants.set(author.authorId, {
          authorId: author.authorId,
          authorUsername: author.authorUsername,
          authorDisplayName: author.authorDisplayName
        });
      }
    }
  }
  return [...participants.values()].sort((a, b) =>
    (a.authorDisplayName ?? a.authorUsername ?? "").localeCompare(b.authorDisplayName ?? b.authorUsername ?? ""));
}

/** Multi-select is OR within participants, AND with scope and status. */
export function commentMatchesParticipants(comment: Comment, options: Pick<CommentReviewOptions, "participantIds" | "topLevelOnly">): boolean {
  const selected = options.participantIds;
  if (!selected?.size) return true;
  return selected.has(comment.authorId)
    || (!options.topLevelOnly && comment.replies.some((reply) => selected.has(reply.authorId)));
}

/** Sort threads only; never reorder or mutate replies (or the input resource). */
export function sortReviewComments(comments: readonly Comment[], sort: CommentReviewSort = "source"): Comment[] {
  return [...comments].sort((a, b) => {
    if (sort === "time") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return a.filePath.localeCompare(b.filePath, "en", { numeric: true })
      || a.startLine - b.startLine || a.startOffset - b.startOffset;
  });
}

/** Whether a thread belongs to the source range currently being reviewed. */
export function commentMatchesReviewScope(comment: Comment, options: Pick<CommentReviewOptions, "activeFile" | "scope">): boolean {
  return options.scope === "project" || comment.filePath === options.activeFile;
}

/** Whether a thread belongs in the selected status queue. */
export function commentMatchesReviewFilter(
  comment: Comment,
  filter: CommentReviewFilter
): boolean {
  return filter === "unresolved" ? !comment.resolved : comment.resolved;
}

/** Notifications, not textual @ tokens or all past mentions. */
export function commentHasUnreadMention(comment: Comment, unreadMentions: readonly CommentMention[]): boolean {
  return unreadMentions.some((mention) => mention.commentId === comment.id && mention.readAt === null);
}

/**
 * Keep the review queue deterministic and independent from the drawer UI.
 * The unread-only toggle intersects with status, scope and participant filters.
 */
export function filterCommentsForReview(comments: readonly Comment[], options: CommentReviewOptions): Comment[] {
  return comments.filter((comment) => {
    return commentMatchesReviewScope(comment, options)
      && commentMatchesParticipants(comment, options)
      && commentMatchesReviewFilter(comment, options.filter)
      && (!options.unreadMentionsOnly || commentHasUnreadMention(comment, options.unreadMentions));
  });
}

/**
 * Preserve the selected review filter, while allowing an explicitly opened
 * thread to remain visible. This is used for source-marker clicks, @-mention
 * links, and a thread which has just been resolved. Extra ids are still
 * constrained by the chosen file/project scope.
 */
export function buildVisibleReviewQueue(
  comments: readonly Comment[],
  options: CommentReviewOptions,
  revealedCommentIds: readonly (string | null | undefined)[] = []
): Comment[] {
  const revealed = new Set(revealedCommentIds.filter((id): id is string => Boolean(id)));
  return sortReviewComments(comments.filter((comment) => {
    if (!commentMatchesReviewScope(comment, options)) return false;
    return revealed.has(comment.id)
      || (commentMatchesParticipants(comment, options)
        && commentMatchesReviewFilter(comment, options.filter)
        && (!options.unreadMentionsOnly || commentHasUnreadMention(comment, options.unreadMentions)));
  }), options.sort);
}

/** Keep source decorations strictly tied to the editor's current file. */
export function commentsForEditorFile(comments: readonly Comment[], filePath: string): Comment[] {
  return comments.filter((comment) => comment.filePath === filePath);
}

/** A source selection is valid only after the target editor has loaded. */
export function focusCommentForEditorFile(
  comment: Comment | null | undefined,
  filePath: string,
  loadedFile: string
): Comment | null {
  if (!comment || comment.filePath !== filePath || loadedFile !== filePath) return null;
  return comment;
}

/**
 * Resolve a cross-file focus request only from a loaded, path-tagged comment
 * resource. In particular, an older response for another editor tab cannot
 * provide offsets for the new tab.
 */
export function resolvePendingCommentFocus(
  pending: Comment | null | undefined,
  activeFile: string,
  loadedFile: string,
  commentsFilePath: string,
  commentsReady: boolean,
  comments: readonly Comment[]
): Comment | null {
  if (!pending || pending.filePath !== activeFile || loadedFile !== activeFile || commentsFilePath !== activeFile || !commentsReady) return null;
  return comments.find((comment) => comment.id === pending.id && comment.filePath === activeFile) ?? null;
}

/** Whether toggling a thread would make it disappear from the active queue. */
export function shouldRevealAfterCommentToggle(
  comment: Comment,
  filter: CommentReviewFilter
): boolean {
  return !commentMatchesReviewFilter({ ...comment, resolved: !comment.resolved }, filter);
}

/** Return the one-based visual position of a focused thread, or zero if none is visible. */
export function commentReviewPosition(comments: readonly Comment[], commentId: string | null | undefined): number {
  if (!commentId) return 0;
  const index = comments.findIndex((comment) => comment.id === commentId);
  return index < 0 ? 0 : index + 1;
}

/**
 * Select an adjacent item without wrapping. If the current item disappeared
 * because a filter changed or a collaborator deleted it, start at the first
 * available thread for a predictable recovery path.
 */
export function adjacentReviewComment(
  comments: readonly Comment[],
  commentId: string | null | undefined,
  direction: -1 | 1
): Comment | null {
  if (!comments.length) return null;
  const index = commentId ? comments.findIndex((comment) => comment.id === commentId) : -1;
  if (index < 0) return direction === 1 ? comments[0] : null;
  const next = index + direction;
  return next >= 0 && next < comments.length ? comments[next] : null;
}
