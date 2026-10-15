import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import { sourceHash } from "../sourceHash";
import type { Comment, Project } from "../types";
import type { CommentReviewScope } from "./commentNavigation";

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

interface FileCommentResource {
  filePath: string;
  comments: Comment[];
  loading: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useProjectComments({
  projectId, activeFile, content, permission, revision, selection, save, saveFailureMessage, onError, onAdded, onChanged
}: UseProjectCommentsOptions) {
  // `comments` remains strictly scoped to the active file. LatexEditor uses
  // offsets from this list to decorate source, so project-wide results must
  // never be substituted here.
  const [fileCommentResource, setFileCommentResource] = useState<FileCommentResource>({ filePath: "", comments: [], loading: false });
  const [projectComments, setProjectComments] = useState<Comment[]>([]);
  const [projectCommentsLoading, setProjectCommentsLoading] = useState(false);
  const [projectCommentsError, setProjectCommentsError] = useState("");
  const [commentScope, setCommentScope] = useState<CommentReviewScope>("file");
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState("");
  const fileRequest = useRef<AbortController | null>(null);
  const projectRequest = useRef<AbortController | null>(null);
  const submittingComment = useRef(false);
  const activeFileRef = useRef(activeFile);
  const commentScopeRef = useRef(commentScope);
  const saveRef = useRef(save);
  const onErrorRef = useRef(onError);
  const onAddedRef = useRef(onAdded);
  const onChangedRef = useRef(onChanged);
  activeFileRef.current = activeFile;
  commentScopeRef.current = commentScope;
  saveRef.current = save;
  onErrorRef.current = onError;
  onAddedRef.current = onAdded;
  onChangedRef.current = onChanged;

  // The resource is explicitly tagged so a response for a previous tab can
  // never decorate or focus the editor currently on screen.
  const comments = fileCommentResource.filePath === activeFile ? fileCommentResource.comments : [];
  const commentsFilePath = fileCommentResource.filePath;
  const commentsReady = commentsFilePath === activeFile && !fileCommentResource.loading;

  const loadFileComments = async (file: string) => {
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;
    if (activeFileRef.current === file) {
      setFileCommentResource((current) => current.filePath === file
        ? { ...current, loading: true }
        : { filePath: "", comments: [], loading: true });
    }
    try {
      const result = await api<{ comments: Comment[] }>(
        `/api/projects/${projectId}/comments?path=${encodeURIComponent(file)}`,
        { signal: controller.signal }
      );
      if (fileRequest.current === controller && activeFileRef.current === file) {
        setFileCommentResource({ filePath: file, comments: result.comments, loading: false });
      }
    } catch (error) {
      if (!isAbortError(error) && fileRequest.current === controller && activeFileRef.current === file) {
        setFileCommentResource({ filePath: file, comments: [], loading: false });
      }
    } finally {
      if (fileRequest.current === controller) fileRequest.current = null;
    }
  };

  const loadProjectComments = async () => {
    projectRequest.current?.abort();
    const controller = new AbortController();
    projectRequest.current = controller;
    if (commentScopeRef.current === "project") {
      setProjectCommentsLoading(true);
      setProjectCommentsError("");
    }
    try {
      const result = await api<{ comments: Comment[] }>(
        `/api/projects/${projectId}/comments?scope=project`,
        { signal: controller.signal }
      );
      if (projectRequest.current === controller && commentScopeRef.current === "project") {
        setProjectComments(result.comments);
      }
    } catch (error) {
      if (!isAbortError(error) && projectRequest.current === controller && commentScopeRef.current === "project") {
        // Preserve a useful, previously loaded review queue. A transient
        // network error must not masquerade as an empty project.
        setProjectCommentsError(errorMessage(error));
      }
    } finally {
      if (projectRequest.current === controller) {
        projectRequest.current = null;
        if (commentScopeRef.current === "project") setProjectCommentsLoading(false);
      }
    }
  };

  useEffect(() => {
    fileRequest.current?.abort();
    fileRequest.current = null;
    projectRequest.current?.abort();
    projectRequest.current = null;
    setFocusComment(null);
    setFileCommentResource({ filePath: "", comments: [], loading: false });
    setProjectComments([]);
    setProjectCommentsLoading(false);
    setProjectCommentsError("");
    setCommentScope("file");
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentError("");
  }, [projectId]);

  // A composer belongs to its selected source. Do not accidentally carry a
  // partially written note to a different tab, but retain focused review
  // state while navigation opens another file.
  useEffect(() => {
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentError("");
  }, [activeFile]);

  useEffect(() => {
    if (activeFile) void loadFileComments(activeFile);
    else setFileCommentResource({ filePath: "", comments: [], loading: false });
    return () => {
      fileRequest.current?.abort();
      fileRequest.current = null;
    };
  }, [projectId, activeFile, revision]);

  useEffect(() => {
    if (commentScope !== "project") {
      projectRequest.current?.abort();
      projectRequest.current = null;
      setProjectComments([]);
      setProjectCommentsLoading(false);
      setProjectCommentsError("");
      return;
    }
    void loadProjectComments();
    return () => {
      projectRequest.current?.abort();
      projectRequest.current = null;
    };
  }, [projectId, commentScope, revision]);

  const refreshComments = async (filePath: string) => {
    const requests: Array<Promise<void>> = [];
    if (activeFileRef.current === filePath) requests.push(loadFileComments(filePath));
    if (commentScopeRef.current === "project") requests.push(loadProjectComments());
    await Promise.all(requests);
  };

  const openComment = (selectionOverride?: SourceSelection, sourceOverride?: string) => {
    if (!activeFile) return;
    setCommentError("");
    // Keep the source revision and selection that the user actually reviewed.
    // Remote edits while the composer is open must never silently retarget it.
    setCommentDraft({
      filePath: activeFile,
      selection: { ...(selectionOverride ?? selection) },
      sourceHash: sourceHash(sourceOverride ?? content)
    });
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
      await refreshComments(draft.filePath);
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
      await refreshComments(comment.filePath);
      onChangedRef.current?.();
    } catch (error) { onErrorRef.current(errorMessage(error)); }
  };

  const replyToComment = async (comment: Comment, content: string): Promise<boolean> => {
    // The inline composer owns request errors and retains its input for retry.
    await api(`/api/projects/${projectId}/comments/${comment.id}/replies`, {
      method: "POST", body: JSON.stringify({ content })
    });
    await refreshComments(comment.filePath);
    onChangedRef.current?.();
    return true;
  };

  const editComment = async (comment: Comment, content: string): Promise<boolean> => {
    await api(`/api/projects/${projectId}/comments/${comment.id}`, {
      method: "PATCH", body: JSON.stringify({ content })
    });
    await refreshComments(comment.filePath);
    onChangedRef.current?.();
    return true;
  };

  const deleteComment = async (comment: Comment): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" });
      await refreshComments(comment.filePath);
      setFocusComment((current) => current?.id === comment.id ? null : current);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  const editCommentReply = async (comment: Comment, replyId: string, content: string): Promise<boolean> => {
    await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, {
      method: "PATCH", body: JSON.stringify({ content })
    });
    await refreshComments(comment.filePath);
    onChangedRef.current?.();
    return true;
  };

  const deleteCommentReply = async (comment: Comment, replyId: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, { method: "DELETE" });
      await refreshComments(comment.filePath);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  return {
    comments,
    commentsFilePath,
    commentsReady,
    reviewComments: commentScope === "file" ? comments : projectComments,
    reviewCommentsLoading: commentScope === "project" && projectCommentsLoading,
    reviewCommentsError: commentScope === "project" ? projectCommentsError : "",
    retryReviewComments: loadProjectComments,
    commentScope,
    setCommentScope,
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
