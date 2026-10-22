import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ApiRequestInit } from "../api";
import type { CommentMutationResult } from "../../shared/comments";
import { applyCommentAcknowledgement, refreshDiscussion } from "./discussionCache";

/** A successful write is complete once its acknowledgement is visible locally.
 * Background reconciliation has its own error/retry state and never re-sends it.
 */
export function useCommentMutations(projectId: string) {
  const client = useQueryClient();
  const mutation = useMutation({ retry: false,
    mutationFn: async ({ id, path, options }: { id: string; path: string; options: ApiRequestInit }) => {
      const result = await api<CommentMutationResult>(`/api/projects/${id}/comments${path}`, options);
      await applyCommentAcknowledgement(client, id, result);
      void refreshDiscussion(client, id);
      return result;
    }
  });
  return (path: string, options: ApiRequestInit) => mutation.mutateAsync({ id: projectId, path, options });
}
