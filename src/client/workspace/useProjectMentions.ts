import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { CommentMention } from "../types";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Personal, unread comment notifications for the current project. */
export function useProjectMentions(projectId: string, revision: string, onError: (message: string) => void) {
  const [unreadMentions, setUnreadMentions] = useState<CommentMention[]>([]);
  const request = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async (reportError = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ mentions: CommentMention[] }>(`/api/projects/${projectId}/mentions?unread=1&limit=100`, { signal: controller.signal });
      if (request.current === controller) setUnreadMentions(result.mentions);
    } catch (error) {
      if (request.current === controller && !isAbortError(error)) {
        setUnreadMentions([]);
        if (reportError) onErrorRef.current(errorMessage(error));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [projectId]);

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
      setUnreadMentions((current) => current.filter((mention) => mention.id !== mentionId));
      return true;
    } catch (error) {
      onErrorRef.current(errorMessage(error));
      return false;
    }
  };

  const markAllMentionsRead = async (): Promise<boolean> => {
    if (!unreadMentions.length) return true;
    try {
      await api(`/api/projects/${projectId}/mentions/read-all`, { method: "POST" });
      setUnreadMentions([]);
      return true;
    } catch (error) {
      onErrorRef.current(errorMessage(error));
      return false;
    }
  };

  return { unreadMentions, refresh, markMentionRead, markAllMentionsRead };
}
