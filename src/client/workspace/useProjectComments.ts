import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import { sourceHash } from "../sourceHash";
import type { Comment, Project } from "../types";

export interface SourceSelection {
  selectedText: string;
  startOffset: number;
  endOffset: number;
}

interface UseProjectCommentsOptions {
  projectId: string;
  activeFile: string;
  content: string;
  permission: Project["permission"] | undefined;
  revision: string;
  selection: SourceSelection;
  save: () => Promise<boolean>;
  saveFailureMessage: string;
  onError: (message: string) => void;
  onAdded: () => void;
  onChanged?: () => void;
}

interface CommentDraft {
  filePath: string;
  selection: SourceSelection;
  sourceHash: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useProjectComments({
  projectId, activeFile, content, permission, revision, selection, save, saveFailureMessage, onError, onAdded, onChanged
}: UseProjectCommentsOptions) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState("");
  const request = useRef<AbortController | null>(null);
  const submittingComment = useRef(false);
  const activeFileRef = useRef(activeFile);
  const saveRef = useRef(save);
  const onErrorRef = useRef(onError);
  const onAddedRef = useRef(onAdded);
  const onChangedRef = useRef(onChanged);
  activeFileRef.current = activeFile;
  saveRef.current = save;
  onErrorRef.current = onError;
  onAddedRef.current = onAdded;
  onChangedRef.current = onChanged;

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
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentError("");
  }, [projectId, activeFile]);

  useEffect(() => {
    if (activeFile) void loadComments(activeFile);
    else setComments([]);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [projectId, activeFile, revision]);

  const openComment = () => {
    if (!activeFile) return;
    setCommentError("");
    // Keep the source revision and selection that the user actually reviewed.
    // Remote edits while the composer is open must never silently retarget it.
    setCommentDraft({ filePath: activeFile, selection: { ...selection }, sourceHash: sourceHash(content) });
    setCommentOpen(true);
  };

  const closeComment = () => {
    if (submittingComment.current) return;
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentError("");
  };

  const addComment = async () => {
    const draft = commentDraft;
    if (!commentText.trim() || !draft || submittingComment.current) return;
    submittingComment.current = true;
    setCommentSubmitting(true);
    setCommentError("");
    try {
      if (permission !== "read" && !(await saveRef.current())) {
        setCommentError(saveFailureMessage);
        return;
      }
      await api(`/api/projects/${projectId}/comments`, {
        method: "POST",
        body: JSON.stringify({ path: draft.filePath, content: commentText, ...draft.selection, sourceHash: draft.sourceHash })
      });
      await loadComments(draft.filePath);
      setCommentOpen(false);
      setCommentDraft(null);
      setCommentText("");
      onAddedRef.current();
      onChangedRef.current?.();
    } catch (error) {
      // Keep the composer and its draft visible so a source-revision conflict
      // can be resolved by reselecting the passage without losing the note.
      setCommentError(errorMessage(error));
    } finally {
      submittingComment.current = false;
      setCommentSubmitting(false);
    }
  };

  const toggleComment = async (comment: Comment) => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !Boolean(comment.resolved) })
      });
      await loadComments(activeFile);
      onChangedRef.current?.();
    } catch (error) { onErrorRef.current(errorMessage(error)); }
  };

  const replyToComment = async (comment: Comment, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies`, {
        method: "POST", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const editComment = async (comment: Comment, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const deleteComment = async (comment: Comment): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" });
      await loadComments(activeFile);
      setFocusComment((current) => current?.id === comment.id ? null : current);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const editCommentReply = async (comment: Comment, replyId: string, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const deleteCommentReply = async (comment: Comment, replyId: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, { method: "DELETE" });
      await loadComments(activeFile);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  return {
    comments,
    focusComment,
    setFocusComment,
    commentOpen,
    openComment,
    closeComment,
    commentText,
    setCommentText,
    commentSelection: commentDraft?.selection ?? selection,
    commentSubmitting,
    commentError,
    addComment,
    toggleComment,
    replyToComment,
    editComment,
    deleteComment,
    editCommentReply,
    deleteCommentReply
  };
}
