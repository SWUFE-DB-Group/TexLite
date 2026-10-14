import { useCallback, useEffect, useState } from "react";
import type { Comment } from "../types";
import { commentMatchesReviewFilter, type CommentReviewFilter } from "./commentNavigation";

export const COMMENT_EXIT_DURATION_MS = 280;

export interface ReviewCommentEntry {
  comment: Comment;
  exitAt: number | null;
}

/** Retain only status-filter departures, not deletions or ordinary filter changes. */
export function reconcileReviewCommentEntries(
  previous: readonly ReviewCommentEntry[],
  visible: readonly Comment[],
  comments: readonly Comment[],
  filter: CommentReviewFilter,
  now: number
): ReviewCommentEntry[] {
  const entries = visible.map((comment) => ({ comment, exitAt: null } as ReviewCommentEntry));
  const visibleIds = new Set(visible.map((comment) => comment.id));
  const liveComments = new Map(comments.map((comment) => [comment.id, comment]));
  previous.forEach((entry, index) => {
    const live = liveComments.get(entry.comment.id);
    if (visibleIds.has(entry.comment.id) || !live || commentMatchesReviewFilter(live, filter)) return;
    entries.splice(Math.min(index, entries.length), 0, {
      comment: live,
      exitAt: entry.exitAt ?? now + COMMENT_EXIT_DURATION_MS + 50
    });
  });
  return entries;
}

/** Exiting threads are presentation only: counts and navigation use the live queue. */
export function useCommentReviewTransitions(
  visible: readonly Comment[], comments: readonly Comment[], filter: CommentReviewFilter, contextKey: string
) {
  const [state, setState] = useState(() => ({
    contextKey, visible, comments,
    entries: visible.map((comment) => ({ comment, exitAt: null } as ReviewCommentEntry))
  }));
  // Adjust before commit, so the removed card never flashes out before its
  // exit animation. Changing tabs/scope/filters clears all transient cards.
  if (state.contextKey !== contextKey || state.visible !== visible || state.comments !== comments) {
    setState({ contextKey, visible, comments, entries: state.contextKey !== contextKey
      ? visible.map((comment) => ({ comment, exitAt: null }))
      : reconcileReviewCommentEntries(state.entries, visible, comments, filter, Date.now()) });
  }
  const finishExit = useCallback((id: string) => {
    setState((current) => ({ ...current, entries: current.entries.filter((entry) => entry.comment.id !== id || entry.exitAt === null) }));
  }, []);
  useEffect(() => {
    const deadlines = state.entries.flatMap((entry) => entry.exitAt === null ? [] : [entry.exitAt]);
    if (!deadlines.length) return;
    // Fallback for interrupted/missing animationend; keep the original
    // deadline through comment refreshes instead of restarting the animation.
    const timeout = window.setTimeout(() => {
      const now = Date.now();
      setState((current) => ({ ...current, entries: current.entries.filter((entry) => entry.exitAt === null || entry.exitAt > now) }));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [state.entries]);
  return { entries: state.entries, finishExit };
}
