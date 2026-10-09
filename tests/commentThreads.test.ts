import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentThread } from "../src/client/workspace/Comments.js";
import type { Comment } from "../src/client/types.js";
import i18n from "../src/client/i18n.js";

const thread: Comment = {
  id: "thread", filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
  selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1,
  content: "Original comment", resolved: false, orphaned: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", editedAt: null,
  replies: ["reader", "other"].map((id) => ({
    id, authorId: id, authorUsername: id, authorDisplayName: id,
    content: `${id} reply`, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", editedAt: null
  }))
};

function render(props: Partial<ComponentProps<typeof CommentThread>> = {}): string {
  return renderToStaticMarkup(createElement(CommentThread, {
    projectId: "project", comment: thread, currentUserId: "viewer",
    onMarkMentionRead: async () => true, onFocus: () => {}, onToggle: () => {},
    onReply: async () => true, onEdit: async () => true, onDelete: async () => true,
    onEditReply: async () => true, onDeleteReply: async () => true,
    highlightReplyParticipants: true, ...props
  }));
}

describe("comment participant highlighting", () => {
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
