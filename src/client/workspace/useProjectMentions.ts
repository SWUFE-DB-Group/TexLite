import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { errorMessage } from "../errors";
import type { CommentMention } from "../types";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Personal, unread comment notifications for the current project. */
export function useProjectMentions(projectId: string, revision: string, onError: (message: string) => void) {
  const [resource, setResource] = useState<{ projectId: string; mentions: CommentMention[] }>({ projectId, mentions: [] });
  const unreadMentions = resource.projectId === projectId ? resource.mentions : [];
  const lifecycle = useMemo(() => ({ active: false }), [projectId]);
  useEffect(() => {
    lifecycle.active = true;
    return () => { lifecycle.active = false; };
  }, [lifecycle]);
  const request = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async (reportError = false) => {
    if (!lifecycle.active) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ mentions: CommentMention[] }>(`/api/projects/${projectId}/mentions?unread=1&limit=100`, { signal: controller.signal });
      if (request.current === controller) setResource({ projectId, mentions: result.mentions });
    } catch (error) {
      if (request.current === controller && !isAbortError(error)) {
        // A temporary failure is not evidence that all notifications were read.
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setResource({ projectId, mentions: [] });
        if (reportError) onErrorRef.current(errorMessage(error));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [projectId, lifecycle]);

  const removeConfirmed = (matches: (mention: CommentMention) => boolean) => {
    if (!lifecycle.active) return;
    // An older GET must not resurrect notifications just acknowledged as read.
    request.current?.abort();
    request.current = null;
    setResource((current) => current.projectId === projectId
      ? { projectId, mentions: current.mentions.filter((mention) => !matches(mention)) }
      : current);
  };

  const clearResolvedMentions = (commentId: string) => removeConfirmed((mention) => mention.commentId === commentId);

  useEffect(() => {
    void refresh();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [refresh, revision]);

  const markMentionRead = async (mentionId: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/mentions/${encodeURIComponent(mentionId)}/read`, { method: "POST" });
      if (!lifecycle.active) return false;
      removeConfirmed((mention) => mention.id === mentionId);
      void refresh();
      return true;
    } catch (error) {
      if (lifecycle.active) onErrorRef.current(errorMessage(error));
      return false;
    }
  };

  const markAllMentionsRead = async (): Promise<boolean> => {
    if (!unreadMentions.length) return true;
    try {
      await api(`/api/projects/${projectId}/mentions/read-all`, { method: "POST" });
      if (!lifecycle.active) return false;
      removeConfirmed(() => true);
      void refresh();
      return true;
    } catch (error) {
      if (lifecycle.active) onErrorRef.current(errorMessage(error));
      return false;
    }
  };

  return { unreadMentions, refresh, markMentionRead, markAllMentionsRead, clearResolvedMentions };
}
