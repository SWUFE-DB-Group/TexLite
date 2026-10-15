import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentThread } from "../src/client/workspace/Comments.js";
import type { Comment } from "../src/client/types.js";
import i18n from "../src/client/i18n.js";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";

const thread: Comment = {
  id: "thread", filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
  selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1,
  content: "Original comment", resolved: false, orphaned: false,
  resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", editedAt: null,
  replies: ["reader", "other"].map((id) => ({
    id, authorId: id, authorUsername: id, authorDisplayName: id,
    content: `${id} reply`, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", editedAt: null
  }))
};

const longThread: Comment = {
  ...thread,
  replies: Array.from({ length: 5 }, (_, index) => ({ ...thread.replies[0]!,
    id: `reply-${index}`, authorId: index === 0 ? "reader" : "other", content: `Reply content ${index}`
  }))
};

function render(props: Partial<ComponentProps<typeof CommentThread>> = {}): string {
  return renderToStaticMarkup(createElement(CommentThread, {
    projectId: "project", comment: thread, draftStore: new CommentDraftStore(), currentUserId: "viewer",
    onMarkMentionRead: async () => true, onFocus: () => {}, onToggle: async () => {},
    onReply: async () => true, onEdit: async () => true, onDelete: async () => true,
    onEditReply: async () => true, onDeleteReply: async () => true,
    onReplyExpansionChange: () => {},
    highlightReplyParticipants: true, ...props
  }));
}

describe("comment participant highlighting", () => {
  it("keeps long source quotes intact alongside the reply composer and submit controls", () => {
    const source = "\\cite{" + "longCitationKey".repeat(500) + "}";
    const draftStore = new CommentDraftStore();
    draftStore.open(thread.id, "reply", "Reply to the long source");
    const html = render({ comment: { ...thread, selectedText: source }, draftStore });
    expect(html).toContain('<blockquote class="comment-selected-text">' + source + '</blockquote>');
    expect(html).toContain("Reply to the long source</textarea>");
    expect(html).toContain(i18n.t("editor.sendReply"));
    expect(html).toContain('type="submit"');
  });

  it("shows who resolved the thread and when, separately from its author", () => {
    const resolvedAt = "2026-01-03T12:00:00Z";
    const html = render({ comment: { ...thread, resolved: true, resolvedAt,
      resolvedById: "reader", resolvedByUsername: "reader", resolvedByDisplayName: "Reader Name" } });
    expect(html).toContain('<strong class="comment-resolution-user">Reader Name</strong>');
    expect(html).not.toContain("<user>");
    expect(html).toContain('class="comment-resolution"');
    expect(html).toContain('dateTime="' + resolvedAt + '"');
    expect(html).toContain('<small class="comment-resolution-user"> @reader</small>');
  });

  it("keeps the resolution time after the resolver is deleted without guessing legacy metadata", () => {
    const resolvedAt = "2026-01-03T12:00:00Z";
    const deleted = render({ comment: { ...thread, resolved: true, resolvedAt } });
    expect(deleted).toContain('<strong class="comment-resolution-user">' + i18n.t("editor.deletedUser") + '</strong>');
    expect(deleted).toContain('dateTime="' + resolvedAt + '"');
    expect(render({ comment: { ...thread, resolved: true } })).not.toContain('class="comment-resolution"');
    expect(render({ comment: { ...thread, resolvedAt } })).not.toContain('class="comment-resolution"');
  });

  it("collapses old replies behind an accessible earlier-replies toggle", () => {
    const html = render({ comment: longThread });
    expect(html).not.toContain('data-comment-reply-id="reply-0"');
    expect(html).toContain('data-comment-reply-id="reply-3"');
    expect(html).toContain('data-comment-reply-id="reply-4"');
    expect(html).toContain(i18n.t("editor.showEarlierReplies", { count: 3 }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
  });

  it("keeps explicit expansion and collapse independent from reading focus", () => {
    const expanded = render({ comment: longThread, replyExpansion: true });
    expect(expanded).toContain('data-comment-reply-id="reply-0"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain(i18n.t("editor.hideEarlierReplies"));
    const collapsed = render({ comment: longThread, currentComment: true, replyExpansion: false });
    expect(collapsed).not.toContain('data-comment-reply-id="reply-0"');
  });

  it("renders a target reply and its highlight in the initial markup, before scrolling", () => {
    const html = render({ comment: longThread, replyExpansion: false, highlightedReplyId: "reply-0" });
    expect(html).toContain('data-comment-reply-id="reply-0" class="comment-reply mention-target"');
    expect(html).not.toContain('class="comment-replies-toggle"');
  });

  it("exposes older matching participant and unread reply controls", () => {
    const matching = render({ comment: longThread, selectedParticipantIds: new Set(["reader"]) });
    expect(matching).toContain('data-comment-reply-id="reply-0"');
    expect(matching).toContain("participant-match");
    const unread = render({ comment: longThread, unreadReplyMentionIds: new Map([["reply-0", "mention"]]) });
    expect(unread).toContain('data-comment-reply-id="reply-0"');
    expect(unread).toContain(i18n.t("editor.markMentionRead"));
    expect(render({ comment: longThread, selectedParticipantIds: new Set(["reader"]), highlightReplyParticipants: false }))
      .not.toContain('data-comment-reply-id="reply-0"');
  });

  it("does not fold away a restored edit to an older reply", () => {
    const draftStore = new CommentDraftStore();
    draftStore.open("thread", "edit-reply:reply-0", "Unsent older reply edit");
    const html = render({ comment: longThread, draftStore, currentUserId: "reader", replyExpansion: false });
    expect(html).toContain("Unsent older reply edit</textarea>");
    expect(html).not.toContain('class="comment-replies-toggle"');
  });

  it("restores a reply after the thread unmounts without stealing editor focus", () => {
    const draftStore = new CommentDraftStore();
    draftStore.open("thread", "reply", "Unsent reply");
    const first = render({ draftStore });
    expect(first).toContain("Unsent reply</textarea>");
    expect(first).not.toContain("autofocus");
    const restored = render({ draftStore });
    expect(restored).toContain("Unsent reply</textarea>");
    draftStore.hide("thread", "reply");
    const hidden = render({ draftStore });
    expect(hidden).toContain(i18n.t("editor.resumeReply"));
    expect(hidden).not.toContain("Unsent reply</textarea>");
  });

  it("restores comment and reply edits without replacing them with refreshed server text", () => {
    const draftStore = new CommentDraftStore();
    draftStore.open("thread", "edit-comment", "Unsent comment edit");
    draftStore.open("thread", "edit-reply:reader", "Unsent reply edit");
    expect(render({ draftStore, currentUserId: "author" })).toContain("Unsent comment edit</textarea>");
    expect(render({ draftStore, currentUserId: "reader" })).toContain("Unsent reply edit</textarea>");
  });

  it("highlights only selected reply authors while preserving the whole discussion", () => {
    const html = render({ selectedParticipantIds: new Set(["reader"]) });
    expect(html).toContain('class="comment-thread"');
    expect(html).toContain('data-comment-reply-id="reader" class="comment-reply"');
    expect(html).toContain('class="comment-author participant-match"><strong>reader</strong><small>@reader</small>');
    expect(html).toContain('data-comment-reply-id="other" class="comment-reply"');
    expect(html).toContain("Original comment");
    expect(html).toContain("other reply");
  });

  it("supports multiple selected authors and root-only highlighting", () => {
    const html = render({ selectedParticipantIds: new Set(["author", "reader"]), highlightReplyParticipants: false });
    expect(html).toContain('class="comment-thread"');
    expect(html).toContain('class="comment-author participant-match"><strong>Author</strong><small>@author</small>');
    expect(html).toContain('class="comment-author"><strong>reader</strong><small>@reader</small>');
    expect(html).toContain('data-comment-reply-id="reader" class="comment-reply"');
    expect(render({ selectedParticipantIds: new Set() })).not.toContain("participant-match");
  });

  it("retains independent mention and focused-thread indicators", () => {
    const html = render({ selectedParticipantIds: new Set(["author", "reader"]),
      highlightedComment: true, highlightedReplyId: "reader", currentComment: true });
    expect(html).toContain('class="comment-thread mention-target review-current"');
    expect(html).toContain('data-comment-reply-id="reader" class="comment-reply mention-target"');
    expect(html.match(/class="comment-author participant-match"/g)).toHaveLength(2);
  });

  it("puts author actions in their own menus without hiding reply and resolution actions", () => {
    const root = render({ currentUserId: "author" });
    expect(root).toContain('aria-label="' + i18n.t("editor.commentActions") + '"');
    expect(root).toContain('aria-haspopup="menu"');
    expect(root).not.toContain('aria-label="' + i18n.t("editor.replyActions") + '"');
    expect(root).not.toContain("comment-owner-actions");
    const reply = render({ currentUserId: "reader" });
    expect(reply).toContain('aria-label="' + i18n.t("editor.replyActions") + '"');
    expect(reply).not.toContain('aria-label="' + i18n.t("editor.commentActions") + '"');
    const viewer = render();
    expect(viewer).not.toContain("comment-actions-menu-trigger");
    expect(viewer).toContain('class="resolve"');
    expect(viewer).toContain('class="reply-action"');
    expect(viewer).toContain('class="comment-selected-text"');
  });
});
