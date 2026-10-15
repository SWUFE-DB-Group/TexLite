import type { CommentReply } from "../types";

export const RECENT_COMMENT_REPLIES = 2;

interface ReplyVisibilityOptions {
  expansion?: boolean;
  current?: boolean;
  activeDraft?: boolean;
  targetReplyId?: string | null;
  unreadReplyMentionIds?: ReadonlyMap<string, string>;
  selectedParticipantIds?: ReadonlySet<string | null>;
  highlightReplyParticipants?: boolean;
}

/** Display-only: filtering, notifications and counts always use the full thread. */
export function commentReplyVisibility(replies: readonly CommentReply[], options: ReplyVisibilityOptions = {}) {
  const older = replies.slice(0, Math.max(0, replies.length - RECENT_COMMENT_REPLIES));
  const forced = Boolean(options.activeDraft
    || options.targetReplyId && replies.some((reply) => reply.id === options.targetReplyId)
    || older.some((reply) => options.unreadReplyMentionIds?.has(reply.id)
      || options.highlightReplyParticipants && options.selectedParticipantIds?.has(reply.authorId)));
  // A deliberate collapse beats ordinary reading focus, but never hides a
  // form, a notification target, or a filtered/unread reply requiring attention.
  const expanded = forced || (options.expansion ?? Boolean(options.current));
  const hiddenCount = expanded ? 0 : older.length;
  return {
    replies: hiddenCount ? replies.slice(-RECENT_COMMENT_REPLIES) : replies,
    hiddenCount,
    expanded,
    canToggle: older.length > 0 && !forced
  };
}
