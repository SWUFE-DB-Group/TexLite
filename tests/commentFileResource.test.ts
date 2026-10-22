import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import type { Comment, CommentChange } from "../src/shared/comments";
import { accessRejected, applyCommentAcknowledgement, applyCommentChange, applyDiscussionSummary, createDiscussionQueryClient, discussionKeys, nextDiscussionRead } from "../src/client/workspace/discussionCache";
import { discussionTestClient } from "./discussionTestUtils";

const comment: Comment = {
  id: "thread", filePath: "main.tex", sourceOrder: 7, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
  selectedText: "Source", startOffset: 10, endOffset: 16, startLine: 2, endLine: 2,
  content: "Review", resolved: false, orphaned: false, resolvedById: null, resolvedByUsername: null,
  resolvedByDisplayName: null, resolvedAt: null, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", editedAt: null, replies: []
};
const summary = { totalCount: 1, unresolvedCount: 1, filePaths: ["main.tex"] };
const reply = { id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader", content: "Reply",
  createdAt: comment.createdAt, updatedAt: comment.updatedAt, editedAt: null };

describe("discussion cache acknowledgements", () => {
  it("retries transient reads but not writes or access rejections", async () => {
    const client = createDiscussionQueryClient();
    let attempts = 0;
    const value = await client.fetchQuery({ queryKey: ["read-retry"], retryDelay: 0, queryFn: async () => {
      if (++attempts < 3) throw new ApiError("Temporary", 503);
      return "recovered";
    } });
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(client.fetchQuery({ queryKey: ["read-forbidden"], retryDelay: 0, queryFn: async () => {
      attempts++; throw new ApiError("Forbidden", 403);
    } })).rejects.toThrow("Forbidden");
    expect(attempts).toBe(1);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    client.clear();
  });
  it.each([401, 403, 404])("recognizes an explicit access rejection (%s)", (status) => {
    expect(accessRejected(new ApiError("Access denied", status))).toBe(true);
  });
  it.each([0, 200, 503])("does not treat a transient read failure as lost access (%s)", (status) => {
    expect(accessRejected(new ApiError("Temporary", status))).toBe(false);
  });

  it("preserves source positions, reading order and other replies through edits and resolutions", () => {
    const original = { ...comment, replies: [reply] };
    const edited = applyCommentChange([original], { kind: "edited", comment: { id: comment.id, filePath: comment.filePath,
      content: "Edited", updatedAt: "later", editedAt: "later" } })[0];
    const resolved = applyCommentChange([edited], { kind: "resolved", resolution: { id: comment.id, filePath: comment.filePath,
      resolved: true, resolvedById: "reader", resolvedByUsername: "reader", resolvedByDisplayName: "Reader", resolvedAt: "later", updatedAt: "later" } })[0];
    expect(resolved).toMatchObject({ content: "Edited", startOffset: 10, endOffset: 16, sourceOrder: 7, selectedText: "Source", replies: [reply], resolved: true });
    expect(original.content).toBe("Review");
    expect(original.resolved).toBe(false);
  });

  it("upserts replies by id, preserving concurrent replies and avoiding duplicates", () => {
    const change: CommentChange = { kind: "reply-saved", commentId: comment.id, filePath: comment.filePath, reply };
    const first = applyCommentChange([{ ...comment, replies: [{ ...reply, id: "remote" }] }], change);
    const second = applyCommentChange(first, change);
    expect(second[0].replies.map((item) => item.id)).toEqual(["remote", "reply"]);
    expect(applyCommentChange(second, { kind: "reply-deleted", commentId: comment.id, filePath: comment.filePath, replyId: reply.id })[0].replies)
      .toEqual([{ ...reply, id: "remote" }]);
    expect(applyCommentChange(second, { kind: "deleted", commentId: comment.id, filePath: comment.filePath })).toEqual([]);
  });

  it("adds new comments only to matching, already-loaded lists, including empty lists", async () => {
    const client = discussionTestClient();
    client.setQueryData(discussionKeys.file("p", "main.tex"), { comments: [] });
    client.setQueryData(discussionKeys.file("p", "other.tex"), { comments: [] });
    client.setQueryData(discussionKeys.all("p"), { comments: [] });
    const ack = { change: { kind: "created", comment } as CommentChange, summary };
    await applyCommentAcknowledgement(client, "p", ack);
    await applyCommentAcknowledgement(client, "p", ack);
    expect(client.getQueryData(discussionKeys.file("p", "main.tex"))).toMatchObject({ comments: [comment] });
    expect(client.getQueryData(discussionKeys.all("p"))).toMatchObject({ comments: [comment] });
    expect(client.getQueryData(discussionKeys.file("p", "other.tex"))).toEqual({ comments: [] });
    await applyCommentAcknowledgement(client, "unloaded", ack);
    expect(client.getQueryData(discussionKeys.all("unloaded"))).toBeUndefined();
    expect(client.getQueryData(discussionKeys.summary("p"))).toEqual(summary);
    client.clear();
  });

  it("removes only the deleted reply's personal notifications", async () => {
    const client = discussionTestClient();
    client.setQueryData(discussionKeys.mentions("p"), { mentions: [{ id: "root", commentId: comment.id, replyId: null }, { id: "reply-notice", commentId: comment.id, replyId: "reply" }] });
    await applyCommentAcknowledgement(client, "p", { change: { kind: "reply-deleted", commentId: comment.id, filePath: comment.filePath, replyId: "reply" }, summary });
    expect(client.getQueryData(discussionKeys.mentions("p"))).toEqual({ mentions: [{ id: "root", commentId: comment.id, replyId: null }] });
    client.clear();
  });

  it("rejects old cross-resource summaries and keeps projects isolated", () => {
    const client = discussionTestClient();
    const old = nextDiscussionRead(client), fresh = nextDiscussionRead(client);
    applyDiscussionSummary(client, "p", { ...summary, unresolvedCount: 0 }, fresh);
    applyDiscussionSummary(client, "other", summary, old);
    applyDiscussionSummary(client, "p", summary, old);
    expect(client.getQueryData(discussionKeys.summary("p"))).toEqual({ ...summary, unresolvedCount: 0 });
    expect(client.getQueryData(discussionKeys.summary("other"))).toEqual(summary);
    client.clear();
  });
});
