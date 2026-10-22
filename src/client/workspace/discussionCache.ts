import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import type { Comment, CommentMention, CommentChange, CommentMutationResult, ProjectCommentSummary } from "../../shared/comments";

export const discussionKeys = {
  lists: (id: string) => ["discussion", id, "comments"] as const,
  file: (id: string, file: string) => ["discussion", id, "comments", "file", file] as const,
  all: (id: string) => ["discussion", id, "comments", "project"] as const,
  summary: (id: string) => ["discussion", id, "summary"] as const,
  mentions: (id: string) => ["discussion", id, "mentions"] as const,
  candidates: (id: string) => ["discussion", id, "candidates"] as const
};

export interface CommentList { comments: Comment[]; summary?: ProjectCommentSummary }
export const EMPTY_COMMENTS: Comment[] = [];
export const EMPTY_MENTIONS: CommentMention[] = [];
export const accessRejected = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);

export function createDiscussionQueryClient() {
  return new QueryClient({ defaultOptions: {
    queries: {
      staleTime: 30_000, gcTime: 5 * 60_000,
      retry: (failures, error) => !accessRejected(error) && failures < 2
        && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === "INVALID_RESPONSE"),
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2_000),
      refetchOnReconnect: "always"
    },
    mutations: { retry: false }
  } });
}

// Different list keys carry the same project summary. Order those shared
// summaries by request start, not completion, without another HTTP endpoint.
const clocks = new WeakMap<QueryClient, { next: number; summaries: Map<string, number> }>();
export function nextDiscussionRead(client: QueryClient): number {
  let clock = clocks.get(client);
  if (!clock) { clock = { next: 0, summaries: new Map() }; clocks.set(client, clock); }
  return ++clock.next;
}
export function applyDiscussionSummary(client: QueryClient, projectId: string, summary: ProjectCommentSummary | undefined, sequence: number) {
  const clock = clocks.get(client);
  if (!summary || !clock || sequence < (clock.summaries.get(projectId) ?? 0)) return;
  clock.summaries.set(projectId, sequence);
  client.setQueryData(discussionKeys.summary(projectId), summary);
}

/** Apply only confirmed fields. Never replace source anchors or other replies. */
export function applyCommentChange(comments: Comment[], change: CommentChange): Comment[] {
  if (change.kind === "created") return comments.some((item) => item.id === change.comment.id)
    ? comments : [...comments, change.comment];
  const id = change.kind === "edited" ? change.comment.id : change.kind === "resolved" ? change.resolution.id : change.commentId;
  if (change.kind === "deleted") return comments.filter((item) => item.id !== id);
  return comments.map((item) => {
    if (item.id !== id) return item;
    if (change.kind === "edited") return { ...item, ...change.comment };
    if (change.kind === "resolved") return { ...item, ...change.resolution };
    if (change.kind === "reply-deleted") return { ...item, replies: item.replies.filter((reply) => reply.id !== change.replyId) };
    const exists = item.replies.some((reply) => reply.id === change.reply.id);
    return { ...item, replies: exists ? item.replies.map((reply) => reply.id === change.reply.id ? change.reply : reply) : [...item.replies, change.reply] };
  });
}

/** Stop pre-acknowledgement reads before modifying any overlapping resource. */
export async function applyCommentAcknowledgement(client: QueryClient, projectId: string, result: CommentMutationResult) {
  await Promise.all([
    client.cancelQueries({ queryKey: discussionKeys.lists(projectId) }),
    client.cancelQueries({ queryKey: discussionKeys.mentions(projectId) })
  ]);
  const change = result.change;
  const file = change.kind === "created" || change.kind === "edited" ? change.comment.filePath
    : change.kind === "resolved" ? change.resolution.filePath : change.filePath;
  client.setQueriesData<CommentList>({ queryKey: discussionKeys.lists(projectId) }, (current) => {
    if (!current) return current; // Never turn an unloaded list into a partial one.
    const queryComments = current.comments;
    // Empty cached file lists need their key to decide whether to add a new thread.
    return change.kind === "created" ? current : { ...current, comments: applyCommentChange(queryComments, change), summary: result.summary };
  });
  if (change.kind === "created") {
    for (const key of [discussionKeys.file(projectId, file), discussionKeys.all(projectId)]) {
      client.setQueryData<CommentList>(key, (current) => current ? { ...current, comments: applyCommentChange(current.comments, change), summary: result.summary } : current);
    }
  }
  applyDiscussionSummary(client, projectId, result.summary, nextDiscussionRead(client));
  client.setQueryData<{ mentions: CommentMention[] }>(discussionKeys.mentions(projectId), (current) => {
    if (!current) return current;
    return { mentions: current.mentions.filter((mention) => {
      if (change.kind === "deleted") return mention.commentId !== change.commentId;
      if (change.kind === "resolved" && change.resolution.resolved) return mention.commentId !== change.resolution.id;
      if (change.kind === "reply-deleted") return mention.replyId !== change.replyId;
      return true;
    }) };
  });
}

export async function refreshDiscussion(client: QueryClient, projectId: string) {
  await Promise.all([discussionKeys.lists(projectId), discussionKeys.mentions(projectId)].map(async (queryKey) => {
    await client.cancelQueries({ queryKey });
    await client.invalidateQueries({ queryKey });
  }));
}
