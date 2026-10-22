import { useCallback, useMemo, useState } from "react";
import type { Comment } from "../types";

export const RESOLVED_COMMENT_BATCH_SIZE = 50;

/** A presentation window over an already filtered/sorted queue, not API pagination. */
export function useCommentReviewWindow(
  queue: readonly Comment[], enabled: boolean, contextKey: string,
  pinnedIds: readonly (string | null | undefined)[]
) {
  const [state, setState] = useState(() => ({ contextKey, limit: RESOLVED_COMMENT_BATCH_SIZE }));
  let limit = state.contextKey === contextKey ? state.limit : RESOLVED_COMMENT_BATCH_SIZE;
  if (enabled) {
    for (const id of pinnedIds) {
      if (!id) continue;
      const position = queue.findIndex((comment) => comment.id === id) + 1;
      limit = Math.max(limit, Math.ceil(position / RESOLVED_COMMENT_BATCH_SIZE) * RESOLVED_COMMENT_BATCH_SIZE);
    }
  }
  // Reset before commit to avoid briefly mounting every previously loaded
  // batch after a filter change. Explicit navigation expands before scrolling.
  if (state.contextKey !== contextKey || state.limit !== limit) setState({ contextKey, limit });
  const shown = useMemo(() => enabled ? queue.slice(0, limit) : queue, [queue, enabled, limit]);
  const loadMore = useCallback(() => {
    setState((current) => ({ contextKey,
      limit: (current.contextKey === contextKey ? current.limit : RESOLVED_COMMENT_BATCH_SIZE) + RESOLVED_COMMENT_BATCH_SIZE }));
  }, [contextKey]);
  return { shown, hasMore: shown.length < queue.length, loadMore };
}
