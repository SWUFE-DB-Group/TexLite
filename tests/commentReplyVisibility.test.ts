import { describe, expect, it } from "vitest";
import type { CommentReply } from "../src/client/types";
import { commentReplyVisibility } from "../src/client/workspace/commentReplyVisibility";

const replies: CommentReply[] = Array.from({ length: 5 }, (_, index) => ({
  id: `reply-${index}`, authorId: index === 0 ? "early-author" : "later-author", authorUsername: "author", authorDisplayName: "Author",
  content: `Reply ${index}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", editedAt: null
}));

describe("long comment reply visibility", () => {
  it.each([0, 1, 2])("leaves a short discussion of %s replies unchanged", (count) => {
    const source = replies.slice(0, count);
    const result = commentReplyVisibility(source);
    expect(result.replies).toBe(source);
    expect(result.hiddenCount).toBe(0);
    expect(result.canToggle).toBe(false);
  });

  it("shows the last two replies in chronological order without mutating the full discussion", () => {
    const result = commentReplyVisibility(replies);
    expect(result.replies.map((reply) => reply.id)).toEqual(["reply-3", "reply-4"]);
    expect(result).toMatchObject({ hiddenCount: 3, expanded: false, canToggle: true });
    expect(replies.map((reply) => reply.id)).toEqual(["reply-0", "reply-1", "reply-2", "reply-3", "reply-4"]);
  });

  it("keeps a deliberate expand choice when replies arrive or the resource is replaced", () => {
    const refreshed = [...replies.map((reply) => ({ ...reply })), { ...replies[0]!, id: "new-reply" }];
    expect(commentReplyVisibility(refreshed, { expansion: true }).replies).toBe(refreshed);
    expect(commentReplyVisibility(refreshed, { expansion: true }).hiddenCount).toBe(0);
  });

  it("expands a reading focus but honors a deliberate collapse", () => {
    expect(commentReplyVisibility(replies, { current: true }).replies).toBe(replies);
    expect(commentReplyVisibility(replies, { current: true, expansion: false }).hiddenCount).toBe(3);
  });

  it("never hides active forms or in-flight submissions, even after a deliberate collapse", () => {
    const result = commentReplyVisibility(replies, { expansion: false, activeDraft: true });
    expect(result.replies).toBe(replies);
    expect(result).toMatchObject({ expanded: true, canToggle: false, hiddenCount: 0 });
  });

  it.each(["reply-0", "reply-4"])("renders a notification target immediately for DOM lookup: %s", (targetReplyId) => {
    const result = commentReplyVisibility(replies, { expansion: false, targetReplyId });
    expect(result.replies).toBe(replies);
    expect(result.canToggle).toBe(false);
  });

  it("ignores targets and notifications for deleted/nonexistent replies", () => {
    expect(commentReplyVisibility(replies, {
      targetReplyId: "deleted", unreadReplyMentionIds: new Map([["deleted", "mention"]])
    }).hiddenCount).toBe(3);
  });

  it("reveals older unread mentions but does not expand unnecessarily for a visible recent mention", () => {
    expect(commentReplyVisibility(replies, { expansion: false, unreadReplyMentionIds: new Map([["reply-0", "mention"]]) }).replies).toBe(replies);
    expect(commentReplyVisibility(replies, { unreadReplyMentionIds: new Map([["reply-4", "mention"]]) }).hiddenCount).toBe(3);
  });

  it("reveals older matching participants, respecting top-level-only filtering", () => {
    const options = { expansion: false, selectedParticipantIds: new Set(["early-author"]), highlightReplyParticipants: true };
    expect(commentReplyVisibility(replies, options).replies).toBe(replies);
    expect(commentReplyVisibility(replies, { ...options, highlightReplyParticipants: false }).hiddenCount).toBe(3);
    expect(commentReplyVisibility(replies, { ...options, selectedParticipantIds: new Set() }).hiddenCount).toBe(3);
  });

  it("also exposes older matching deleted-user replies", () => {
    const source = [{ ...replies[0]!, authorId: null }, ...replies.slice(1)];
    expect(commentReplyVisibility(source, { selectedParticipantIds: new Set([null]), highlightReplyParticipants: true }).replies).toBe(source);
  });
});
