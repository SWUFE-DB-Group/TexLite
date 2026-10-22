import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { errorMessage } from "../errors";
import { sourceHash } from "../sourceHash";
import type { Comment, Project, ProjectCommentSummary } from "../types";
import type { CommentReviewScope } from "./commentNavigation";
import { CommentDraftStore, type SourceSelection } from "./commentDrafts";
export type { SourceSelection } from "./commentDrafts";

interface UseProjectCommentsOptions {
  projectId: string;
  activeFile: string;
  content: string;
  permission: Project["permission"] | undefined;
  revision: string;
  /** Settings/tree changes can alter project reading order without changing a comment. */
  sourceOrderRevision?: string;
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
  error: string;
}

/** A failed refresh is not evidence that the discussion was deleted. */
export function fileCommentsAfterFailure(current: FileCommentResource, filePath: string, error: unknown): FileCommentResource {
  // Do not keep displaying cached project contents after an explicit access
  // rejection. Temporary network/server failures can retain the same file.
  const inaccessible = error instanceof ApiError && [401, 403, 404].includes(error.status);
  return {
    filePath,
    comments: !inaccessible && current.filePath === filePath ? current.comments : [],
    loading: false,
    error: errorMessage(error)
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useProjectComments({
  projectId, activeFile, content, permission, revision, sourceOrderRevision, selection, save, saveFailureMessage, onError, onAdded, onChanged
}: UseProjectCommentsOptions) {
  const commentDraftStore = useMemo(() => new CommentDraftStore(), [projectId]);
  // `comments` remains strictly scoped to the active file. LatexEditor uses
  // offsets from this list to decorate source, so project-wide results must
  // never be substituted here.
  const [fileCommentResource, setFileCommentResource] = useState<FileCommentResource>({ filePath: "", comments: [], loading: false, error: "" });
  const [projectComments, setProjectComments] = useState<Comment[]>([]);
  const [projectCommentsLoading, setProjectCommentsLoading] = useState(false);
  const [projectCommentsError, setProjectCommentsError] = useState("");
  const [commentSummary, setCommentSummary] = useState<{ projectId: string; summary: ProjectCommentSummary } | null>(null);
  const [commentScope, setCommentScope] = useState<CommentReviewScope>("file");
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentTextState] = useState("");
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentCandidate, setCommentCandidate] = useState<CommentDraft | null>(null);
  const [commentDraftRestored, setCommentDraftRestored] = useState(false);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState("");
  const fileRequest = useRef<AbortController | null>(null);
  const projectRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const appliedSummarySequence = useRef(0);
  const submittingComment = useRef(false);
  const activeFileRef = useRef(activeFile);
  const commentScopeRef = useRef(commentScope);
  const saveRef = useRef(save);
  const onErrorRef = useRef(onError);
  const onAddedRef = useRef(onAdded);
  const onChangedRef = useRef(onChanged);
  const commentDraftRef = useRef(commentDraft);
  const commentTextRef = useRef(commentText);
  commentDraftRef.current = commentDraft;
  commentTextRef.current = commentText;
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
  const fileCommentsError = commentsFilePath === activeFile ? fileCommentResource.error : "";
  const fileCommentsLoading = Boolean(activeFile) && (commentsFilePath !== activeFile || fileCommentResource.loading);
  const commentsReady = commentsFilePath === activeFile && !fileCommentResource.loading && !fileCommentsError;

  const updateCommentSummary = (summary: ProjectCommentSummary | undefined, sequence: number) => {
    if (!summary || sequence < appliedSummarySequence.current) return;
    appliedSummarySequence.current = sequence;
    setCommentSummary({ projectId, summary });
  };

  const loadFileComments = async (file: string) => {
    fileRequest.current?.abort();
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    fileRequest.current = controller;
    if (activeFileRef.current === file) {
      setFileCommentResource((current) => current.filePath === file
        ? { ...current, loading: true, error: "" }
        : { filePath: "", comments: [], loading: true, error: "" });
    }
    try {
      const result = await api<{ comments: Comment[]; summary?: ProjectCommentSummary }>(
        `/api/projects/${projectId}/comments?path=${encodeURIComponent(file)}`,
        { signal: controller.signal }
      );
      if (fileRequest.current === controller && activeFileRef.current === file) {
        setFileCommentResource({ filePath: file, comments: result.comments, loading: false, error: "" });
        updateCommentSummary(result.summary, sequence);
      }
    } catch (error) {
      if (!isAbortError(error) && fileRequest.current === controller && activeFileRef.current === file) {
        setFileCommentResource((current) => fileCommentsAfterFailure(current, file, error));
      }
    } finally {
      if (fileRequest.current === controller) fileRequest.current = null;
    }
  };

  const retryFileComments = () => activeFileRef.current ? loadFileComments(activeFileRef.current) : Promise.resolve();

  const loadProjectComments = async () => {
    projectRequest.current?.abort();
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    projectRequest.current = controller;
    if (commentScopeRef.current === "project") {
      setProjectCommentsLoading(true);
      setProjectCommentsError("");
    }
    try {
      const result = await api<{ comments: Comment[]; summary?: ProjectCommentSummary }>(
        `/api/projects/${projectId}/comments?scope=project`,
        { signal: controller.signal }
      );
      if (projectRequest.current === controller && commentScopeRef.current === "project") {
        setProjectComments(result.comments);
        updateCommentSummary(result.summary, sequence);
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
    setFileCommentResource({ filePath: "", comments: [], loading: false, error: "" });
    setProjectComments([]);
    setProjectCommentsLoading(false);
    setProjectCommentsError("");
    setCommentSummary(null);
    setCommentScope("file");
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentCandidate(null);
    setCommentTextState("");
    setCommentDraftRestored(false);
    setCommentError("");
  }, [projectId]);

  // A composer belongs to its selected source. Do not accidentally carry a
  // partially written note to a different tab, but retain focused review
  // state while navigation opens another file.
  useEffect(() => {
    setCommentOpen(false);
    setCommentDraft(null);
    setCommentCandidate(null);
    setCommentTextState("");
    setCommentDraftRestored(false);
    setCommentError("");
  }, [activeFile]);

  useEffect(() => {
    if (activeFile) void loadFileComments(activeFile);
    else setFileCommentResource({ filePath: "", comments: [], loading: false, error: "" });
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
  }, [projectId, commentScope, revision, sourceOrderRevision]);

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
    const candidate: CommentDraft = {
      filePath: activeFile,
      selection: { ...(selectionOverride ?? selection) },
      sourceHash: sourceHash(sourceOverride ?? content)
    };
    const saved = commentDraftStore.getNew(activeFile);
    // Restoring text must also restore its original source binding. Never
    // silently reuse a note on the newly selected (possibly unrelated) text.
    setCommentDraft(saved ?? candidate);
    setCommentTextState(saved?.content ?? "");
    setCommentCandidate(candidate);
    setCommentDraftRestored(Boolean(saved));
    setCommentOpen(true);
  };

  const setCommentText = (value: string) => {
    setCommentTextState(value);
    if (!commentDraft) return;
    if (value) commentDraftStore.setNew({ ...commentDraft, content: value });
    else commentDraftStore.discardNew(commentDraft.filePath);
  };

  const closeComment = () => {
    if (submittingComment.current) return;
    setCommentOpen(false);
    setCommentError("");
  };

  const cancelComment = () => {
    if (submittingComment.current) return;
    if (commentDraft) commentDraftStore.discardNew(commentDraft.filePath);
    setCommentTextState("");
    setCommentDraft(null);
    setCommentCandidate(null);
    setCommentDraftRestored(false);
    closeComment();
  };

  const useCurrentCommentSelection = () => {
    if (submittingComment.current || !commentCandidate || commentCandidate.filePath !== activeFileRef.current) return;
    setCommentDraft(commentCandidate);
    if (commentText) commentDraftStore.setNew({ ...commentCandidate, content: commentText });
    setCommentDraftRestored(false);
    setCommentError("");
  };

  const addComment = async () => {
    const draft = commentDraft;
    const submittedText = commentText;
    if (!commentText.trim() || !draft || submittingComment.current) return;
    const isCurrentDraft = () => {
      const current = commentDraftRef.current;
      return current?.filePath === draft.filePath && current.sourceHash === draft.sourceHash
        && current.selection.startOffset === draft.selection.startOffset && current.selection.endOffset === draft.selection.endOffset
        && commentTextRef.current === submittedText;
    };
    submittingComment.current = true;
    setCommentSubmitting(true);
    setCommentError("");
    try {
      if (permission !== "read" && !(await saveRef.current())) {
        if (isCurrentDraft()) setCommentError(saveFailureMessage);
        return;
      }
      await api(`/api/projects/${projectId}/comments`, {
        method: "POST",
        body: JSON.stringify({ path: draft.filePath, content: submittedText, ...draft.selection, sourceHash: draft.sourceHash })
      });
      await refreshComments(draft.filePath);
      const saved = commentDraftStore.getNew(draft.filePath);
      if (saved?.content === submittedText && saved.sourceHash === draft.sourceHash
        && saved.selection.startOffset === draft.selection.startOffset && saved.selection.endOffset === draft.selection.endOffset) {
        commentDraftStore.discardNew(draft.filePath);
      }
      if (isCurrentDraft()) {
        setCommentOpen(false);
        setCommentDraft(null);
        setCommentTextState("");
        setCommentDraftRestored(false);
      }
      onAddedRef.current();
      onChangedRef.current?.();
    } catch (error) {
      // Keep the composer and its draft visible so a source-revision conflict
      // can be resolved by reselecting the passage without losing the note.
      if (isCurrentDraft()) setCommentError(errorMessage(error));
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
      commentDraftStore.discard(comment.id);
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
      commentDraftStore.discard(comment.id, `edit-reply:${replyId}`);
      onChangedRef.current?.();
      return true;
    } catch (error) { onErrorRef.current(errorMessage(error)); return false; }
  };

  return {
    commentDraftStore,
    projectCommentSummary: commentSummary?.projectId === projectId ? commentSummary.summary : null,
    comments,
    commentsFilePath,
    commentsReady,
    fileCommentsLoading,
    fileCommentsError,
    retryFileComments,
    reviewComments: commentScope === "file" ? comments : projectComments,
    reviewCommentsLoading: commentScope === "project" ? projectCommentsLoading : fileCommentsLoading,
    reviewCommentsError: commentScope === "project" ? projectCommentsError : fileCommentsError,
    retryReviewComments: commentScope === "project" ? loadProjectComments : retryFileComments,
    commentScope,
    setCommentScope,
    focusComment,
    setFocusComment,
    commentOpen,
    openComment,
    closeComment,
    cancelComment,
    commentDraftRestored,
    commentDraftCanRetarget: Boolean(commentDraft && commentCandidate && (commentDraft.sourceHash !== commentCandidate.sourceHash
      || commentDraft.selection.startOffset !== commentCandidate.selection.startOffset || commentDraft.selection.endOffset !== commentCandidate.selection.endOffset)),
    useCurrentCommentSelection,
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
