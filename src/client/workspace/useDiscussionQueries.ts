import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ProjectCommentSummary } from "../../shared/comments";
import type { CommentReviewScope } from "./commentNavigation";
import { accessRejected, applyDiscussionSummary, discussionKeys, EMPTY_COMMENTS, nextDiscussionRead, refreshDiscussion, type CommentList } from "./discussionCache";
import { errorMessage } from "../errors";

/** Read ownership stays here; the composer and review UI do not own requests. */
export function useDiscussionQueries(projectId: string, activeFile: string, scope: CommentReviewScope, revision: string, sourceOrderRevision?: string) {
  const client = useQueryClient();
  const read = async (url: string, signal: AbortSignal) => {
    const sequence = nextDiscussionRead(client);
    const result = await api<CommentList>(url, { signal });
    if (!signal.aborted) applyDiscussionSummary(client, projectId, result.summary, sequence);
    return result;
  };
  const file = useQuery({ queryKey: discussionKeys.file(projectId, activeFile), enabled: Boolean(activeFile),
    queryFn: ({ signal }) => read(`/api/projects/${projectId}/comments?path=${encodeURIComponent(activeFile)}`, signal) });
  const project = useQuery({ queryKey: discussionKeys.all(projectId), enabled: scope === "project",
    queryFn: ({ signal }) => read(`/api/projects/${projectId}/comments?scope=project`, signal) });
  const summary = useQuery<ProjectCommentSummary>({ queryKey: discussionKeys.summary(projectId), enabled: false });
  const previous = useRef({ projectId, revision, sourceOrderRevision });
  useEffect(() => {
    const old = previous.current;
    previous.current = { projectId, revision, sourceOrderRevision };
    if (old.projectId !== projectId) return;
    const key = old.revision !== revision ? discussionKeys.lists(projectId)
      : old.sourceOrderRevision !== sourceOrderRevision ? discussionKeys.all(projectId) : null;
    if (key) void client.cancelQueries({ queryKey: key }).then(() => client.invalidateQueries({ queryKey: key }));
  }, [client, projectId, revision, sourceOrderRevision]);
  const review = scope === "project" ? project : file;
  const fileError = file.error ? errorMessage(file.error) : "";
  return {
    comments: accessRejected(file.error) ? EMPTY_COMMENTS : file.data?.comments ?? EMPTY_COMMENTS,
    commentsFilePath: activeFile && (file.data || file.error) ? activeFile : "",
    commentsReady: Boolean(activeFile && file.data && !file.isFetching && !file.error),
    fileCommentsLoading: Boolean(activeFile && file.isFetching), fileCommentsError: fileError,
    reviewComments: accessRejected(review.error) ? EMPTY_COMMENTS : review.data?.comments ?? EMPTY_COMMENTS,
    reviewCommentsLoading: Boolean((scope === "project" || activeFile) && review.isFetching),
    reviewCommentsError: review.error ? errorMessage(review.error) : "",
    projectCommentSummary: accessRejected(file.error) || accessRejected(project.error) ? null : summary.data ?? null,
    refreshComments: () => refreshDiscussion(client, projectId)
  };
}
