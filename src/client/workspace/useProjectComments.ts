import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { Comment, Project } from "../types";

export interface SourceSelection {
  selectedText: string;
  startOffset: number;
  endOffset: number;
}

interface UseProjectCommentsOptions {
  projectId: string;
  activeFile: string;
  permission: Project["permission"] | undefined;
  revision: string;
  selection: SourceSelection;
  save: () => Promise<boolean>;
  onError: (message: string) => void;
  onAdded: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useProjectComments({
  projectId, activeFile, permission, revision, selection, save, onError, onAdded
}: UseProjectCommentsOptions) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const request = useRef<AbortController | null>(null);
  const activeFileRef = useRef(activeFile);
  const saveRef = useRef(save);
  const onErrorRef = useRef(onError);
  const onAddedRef = useRef(onAdded);
  activeFileRef.current = activeFile;
  saveRef.current = save;
  onErrorRef.current = onError;
  onAddedRef.current = onAdded;

  const loadComments = async (file: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ comments: Comment[] }>(
        `/api/projects/${projectId}/comments?path=${encodeURIComponent(file)}`,
        { signal: controller.signal }
      );
      if (activeFileRef.current === file) setComments(result.comments);
    } catch (error) {
      if (!isAbortError(error) && activeFileRef.current === file) setComments([]);
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  useEffect(() => {
    setFocusComment(null);
  }, [projectId, activeFile]);

  useEffect(() => {
    if (activeFile) void loadComments(activeFile);
    else setComments([]);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [projectId, activeFile, revision]);

  const addComment = async () => {
    if (!commentText.trim() || !activeFile) return;
    try {
      if (permission !== "read" && !(await saveRef.current())) return;
      await api(`/api/projects/${projectId}/comments`, {
        method: "POST",
        body: JSON.stringify({ path: activeFile, content: commentText, ...selection })
      });
      await loadComments(activeFile);
      setCommentOpen(false);
      setCommentText("");
      onAddedRef.current();
    } catch (error) {
      onErrorRef.current(errorMessage(error));
    }
  };

  const toggleComment = async (comment: Comment) => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !Boolean(comment.resolved) })
      });
      await loadComments(activeFile);
    } catch (error) { onErrorRef.current(errorMessage(error)); }
  };

  const replyToComment = async (comment: Comment, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies`, {
        method: "POST", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const editComment = async (comment: Comment, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const deleteComment = async (comment: Comment): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" });
      await loadComments(activeFile);
      setFocusComment((current) => current?.id === comment.id ? null : current);
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const editCommentReply = async (comment: Comment, replyId: string, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const deleteCommentReply = async (comment: Comment, replyId: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, { method: "DELETE" });
      await loadComments(activeFile);
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  return {
    comments,
    focusComment,
    setFocusComment,
    commentOpen,
    setCommentOpen,
    commentText,
    setCommentText,
    addComment,
    toggleComment,
    replyToComment,
    editComment,
    deleteComment,
    editCommentReply,
    deleteCommentReply
  };
}
