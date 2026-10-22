import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { CommentMention } from "../types";
import { accessRejected, discussionKeys, EMPTY_MENTIONS } from "./discussionCache";

/** Personal notifications share request/cache ownership with the discussion queries. */
export function useProjectMentions(projectId: string, revision: string, onError: (message: string) => void,
  onRead?: (count: number, all: boolean) => void) {
  const client = useQueryClient();
  const key = discussionKeys.mentions(projectId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) =>
    api<{ mentions: CommentMention[] }>(`/api/projects/${projectId}/mentions?unread=1&limit=100`, { signal }) });
  const unreadMentions = accessRejected(query.error) ? EMPTY_MENTIONS : query.data?.mentions ?? EMPTY_MENTIONS;
  const callbacks = useRef({ onError, onRead });
  callbacks.current = { onError, onRead };
  const lifecycle = useMemo(() => ({ active: false, pending: new Map<string, Promise<boolean>>() }), [projectId]);
  useEffect(() => { lifecycle.active = true; return () => { lifecycle.active = false; }; }, [lifecycle]);
  const previous = useRef({ projectId, revision });
  const refresh = async (reportError = false) => {
    if (!lifecycle.active) return;
    await client.cancelQueries({ queryKey: key });
    const result = await query.refetch();
    if (reportError && result.error && lifecycle.active) callbacks.current.onError(errorMessage(result.error));
  };
  useEffect(() => {
    const old = previous.current;
    previous.current = { projectId, revision };
    if (old.projectId === projectId && old.revision !== revision) void refresh();
  }, [projectId, revision]);

  const markRead = (mentionId?: string): Promise<boolean> => {
    const operationKey = mentionId ?? "all";
    const pending = lifecycle.pending.get(operationKey);
    if (pending) return pending;
    const operation = (async () => {
      try {
        const result = await api<{ changed: boolean | number }>(`/api/projects/${projectId}/mentions/${mentionId ? `${encodeURIComponent(mentionId)}/read` : "read-all"}`, { method: "POST" });
        if (!lifecycle.active) return false;
        await client.cancelQueries({ queryKey: key });
        if (!lifecycle.active) return false;
        client.setQueryData<{ mentions: CommentMention[] }>(key, (current) => current
          ? { mentions: mentionId ? current.mentions.filter((item) => item.id !== mentionId) : [] } : current);
        const count = Number(result.changed) || 0;
        if (count || !mentionId) callbacks.current.onRead?.(count, !mentionId);
        void client.invalidateQueries({ queryKey: key });
        return true;
      } catch (error) {
        if (lifecycle.active) callbacks.current.onError(errorMessage(error));
        return false;
      } finally { lifecycle.pending.delete(operationKey); }
    })();
    lifecycle.pending.set(operationKey, operation);
    return operation;
  };
  return { unreadMentions, mentionsError: query.error ? errorMessage(query.error) : "", refresh,
    markMentionRead: (id: string) => markRead(id), markAllMentionsRead: () => markRead() };
}
