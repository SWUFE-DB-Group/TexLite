import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errors";
import { sourceHash } from "../sourceHash";
import type { Comment, Project } from "../types";
import type { CommentReviewScope } from "./commentNavigation";
import { CommentDraftStore, type SourceSelection } from "./commentDrafts";
import { useDiscussionQueries } from "./useDiscussionQueries";
import { useCommentMutations } from "./useCommentMutations";
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
}

interface CommentDraft {
  filePath: string;
  selection: SourceSelection;
  sourceHash: string;
}

export function useProjectComments({
  projectId, activeFile, content, permission, revision, sourceOrderRevision, selection, save, saveFailureMessage, onError, onAdded
}: UseProjectCommentsOptions) {
  const commentDraftStore = useMemo(() => new CommentDraftStore(), [projectId]);
  const lifecycle = useMemo(() => ({ active: false }), [projectId]);
  useEffect(() => {
    lifecycle.active = true;
    return () => { lifecycle.active = false; };
  }, [lifecycle]);
  const [commentScope, setCommentScope] = useState<CommentReviewScope>("file");
  const queries = useDiscussionQueries(projectId, activeFile, commentScope, revision, sourceOrderRevision);
  const write = useCommentMutations(projectId);
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentTextState] = useState("");
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentCandidate, setCommentCandidate] = useState<CommentDraft | null>(null);
  const [commentDraftRestored, setCommentDraftRestored] = useState(false);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState("");
  const submittingComment = useRef(false);
  const activeFileRef = useRef(activeFile);
  const saveRef = useRef(save);
  const onErrorRef = useRef(onError);
  const onAddedRef = useRef(onAdded);
  const commentDraftRef = useRef(commentDraft);
  const commentTextRef = useRef(commentText);
  commentDraftRef.current = commentDraft;
  commentTextRef.current = commentText;
  activeFileRef.current = activeFile;
  saveRef.current = save;
  onErrorRef.current = onError;
  onAddedRef.current = onAdded;

  useEffect(() => {
    setFocusComment(null);
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
      await write("", {
        method: "POST",
        body: JSON.stringify({ path: draft.filePath, content: submittedText, ...draft.selection, sourceHash: draft.sourceHash })
      });
      const saved = commentDraftStore.getNew(draft.filePath);
      if (saved?.content === submittedText && saved.sourceHash === draft.sourceHash
        && saved.selection.startOffset === draft.selection.startOffset && saved.selection.endOffset === draft.selection.endOffset) {
        commentDraftStore.discardNew(draft.filePath);
      }
      if (!lifecycle.active) return;
      if (isCurrentDraft()) {
        setCommentOpen(false);
        setCommentDraft(null);
        setCommentTextState("");
        setCommentDraftRestored(false);
      }
      onAddedRef.current();
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
      await write(`/${comment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !Boolean(comment.resolved) })
      });
    } catch (error) { if (lifecycle.active) onErrorRef.current(errorMessage(error)); }
  };

  const replyToComment = async (comment: Comment, content: string): Promise<boolean> => {
    // The inline composer owns request errors and retains its input for retry.
    await write(`/${comment.id}/replies`, {
      method: "POST", body: JSON.stringify({ content })
    });
    return true;
  };

  const editComment = async (comment: Comment, content: string): Promise<boolean> => {
    await write(`/${comment.id}`, {
      method: "PATCH", body: JSON.stringify({ content })
    });
    return true;
  };

  const deleteComment = async (comment: Comment): Promise<boolean> => {
    await write(`/${comment.id}`, { method: "DELETE" });
    if (!lifecycle.active) return true;
    setFocusComment((current) => current?.id === comment.id ? null : current);
    commentDraftStore.discard(comment.id);
    return true;
  };

  const editCommentReply = async (comment: Comment, replyId: string, content: string): Promise<boolean> => {
    await write(`/${comment.id}/replies/${replyId}`, {
      method: "PATCH", body: JSON.stringify({ content })
    });
    return true;
  };

  const deleteCommentReply = async (comment: Comment, replyId: string): Promise<boolean> => {
    await write(`/${comment.id}/replies/${replyId}`, { method: "DELETE" });
    commentDraftStore.discard(comment.id, `edit-reply:${replyId}`);
    return true;
  };

  return {
    commentDraftStore,
    ...queries,
    retryFileComments: queries.refreshComments,
    retryReviewComments: queries.refreshComments,
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
