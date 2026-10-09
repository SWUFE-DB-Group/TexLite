import { describe, expect, it } from "vitest";
import {
  adjacentReviewComment,
  buildVisibleReviewQueue,
  collectCommentParticipants,
  commentMatchesParticipants,
  commentsForEditorFile,
  commentReviewPosition,
  filterCommentsForReview,
  focusCommentForEditorFile,
  resolvePendingCommentFocus,
  sortReviewComments,
  shouldRevealAfterCommentToggle
} from "../src/client/workspace/commentNavigation.js";
import type { Comment, CommentMention } from "../src/client/types.js";

function comment(id: string, filePath: string, resolved = false): Comment {
  return {
    id, filePath, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: id, startOffset: 0, endOffset: id.length, startLine: 1, endLine: 1,
    content: id, resolved, orphaned: false, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", editedAt: null, replies: []
  };
}

function mention(commentId: string, replyId: string | null = null): CommentMention {
  return {
    id: `mention-${commentId}-${replyId ?? "root"}`, projectId: "project", commentId, replyId,
    filePath: "main.tex", content: "@reader", resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z", readAt: null, readReason: null
  };
}

describe("comment review navigation", () => {
  const comments = [
    comment("main-open", "main.tex"),
    comment("chapter-open", "chapters/intro.tex"),
    comment("chapter-resolved", "chapters/intro.tex", true)
  ];

  it("filters file and project review queues by status", () => {
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "file", filter: "unresolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["main-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "unresolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["main-open", "chapter-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "resolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["chapter-resolved"]);
  });

  it("treats root and reply notifications as one unread @-me thread", () => {
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "unresolved", unreadMentionsOnly: true,
      unreadMentions: [mention("chapter-open", "reply-1"), mention("main-open")]
    }).map((item) => item.id)).toEqual(["main-open", "chapter-open"]);
    expect(filterCommentsForReview(comments, {
      activeFile: "main.tex", scope: "project", filter: "unresolved", unreadMentionsOnly: true, unreadMentions: []
    })).toEqual([]);
  });

  it("moves through the visible queue without wrapping", () => {
    const visible = comments.slice(0, 2);
    expect(commentReviewPosition(visible, "chapter-open")).toBe(2);
    expect(commentReviewPosition(visible, "removed")).toBe(0);
    expect(adjacentReviewComment(visible, "main-open", 1)?.id).toBe("chapter-open");
    expect(adjacentReviewComment(visible, "chapter-open", 1)).toBeNull();
    expect(adjacentReviewComment(visible, "main-open", -1)).toBeNull();
    expect(adjacentReviewComment(visible, "removed", 1)?.id).toBe("main-open");
    expect(adjacentReviewComment(visible, "removed", -1)).toBeNull();
  });

  it("keeps an explicitly opened thread visible without weakening ordinary filters", () => {
    const unresolvedOptions = {
      activeFile: "main.tex", scope: "project" as const, filter: "unresolved" as const, unreadMentions: []
    };
    expect(buildVisibleReviewQueue(comments, unresolvedOptions).map((item) => item.id))
      .toEqual(["chapter-open", "main-open"]);
    expect(buildVisibleReviewQueue(comments, unresolvedOptions, ["chapter-resolved"]).map((item) => item.id))
      .toEqual(["chapter-open", "chapter-resolved", "main-open"]);
    expect(buildVisibleReviewQueue(comments, {
      ...unresolvedOptions, scope: "file"
    }, ["chapter-resolved"]).map((item) => item.id)).toEqual(["main-open"]);
  });

  it("reveals a resolved thread with a fresh @ reply and retains a resolved current item until navigation", () => {
    const options = {
      activeFile: "main.tex", scope: "project" as const, filter: "unresolved" as const,
      unreadMentions: [mention("chapter-resolved", "new-reply")]
    };
    expect(buildVisibleReviewQueue(comments, options, ["chapter-resolved"]).map((item) => item.id))
      .toEqual(["chapter-open", "chapter-resolved", "main-open"]);

    const resolvedCurrent = { ...comments[1], resolved: true };
    const later = comment("later-open", "chapters/intro.tex");
    const queue = buildVisibleReviewQueue([comments[0], resolvedCurrent, later], options, [resolvedCurrent.id]);
    expect(shouldRevealAfterCommentToggle(comments[1], "unresolved")).toBe(true);
    expect(commentReviewPosition(queue, resolvedCurrent.id)).toBe(1);
    expect(adjacentReviewComment(queue, resolvedCurrent.id, 1)?.id).toBe("later-open");
  });

  it("does not give a newly mounted editor offsets from another file", () => {
    const target = comments[1];
    expect(commentsForEditorFile(comments, "main.tex").map((item) => item.id)).toEqual(["main-open"]);
    expect(focusCommentForEditorFile(target, "main.tex", "main.tex")).toBeNull();
    expect(focusCommentForEditorFile(target, "chapters/intro.tex", "main.tex")).toBeNull();
    expect(focusCommentForEditorFile(target, "chapters/intro.tex", "chapters/intro.tex")).toBe(target);
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "chapters/intro.tex", "chapters/intro.tex", true, [target])).toBe(target);
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "main.tex", "chapters/intro.tex", true, [target])).toBeNull();
    expect(resolvePendingCommentFocus(target, "chapters/intro.tex", "chapters/intro.tex", "chapters/intro.tex", false, [target])).toBeNull();
  });

  it("defaults to source position, grouping files and breaking same-line ties by offset", () => {
    const source = [
      { ...comment("last", "main.tex"), startLine: 30, startOffset: 300 },
      { ...comment("middle", "main.tex"), startLine: 2, startOffset: 20 },
      { ...comment("other", "chapter.tex"), startLine: 100, startOffset: 1000 },
      { ...comment("first", "main.tex"), startLine: 2, startOffset: 10 }
    ];
    expect(buildVisibleReviewQueue(source, {
      activeFile: "main.tex", scope: "project", filter: "unresolved", unreadMentions: []
    }).map((item) => item.id)).toEqual(["other", "first", "middle", "last"]);
    expect(source.map((item) => item.id)).toEqual(["last", "middle", "other", "first"]);
  });

  it("sorts by root creation time descending, unaffected by new replies or edits", () => {
    const older = { ...comment("older", "main.tex"), updatedAt: "2026-03-01T00:00:00Z", replies: [
      { id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader",
        content: "Reply", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", editedAt: null }
    ] };
    const newer = { ...comment("newer", "main.tex"), createdAt: "2026-02-01T00:00:00Z" };
    expect(sortReviewComments([older, newer], "time").map((item) => item.id)).toEqual(["newer", "older"]);
    expect(older.replies.map((reply) => reply.id)).toEqual(["reply"]);
    expect(sortReviewComments([older, { ...older, id: "same-time" }], "time").map((item) => item.id)).toEqual(["older", "same-time"]);
  });

  it("matches multiple participants in roots or replies, with root-only opt-in", () => {
    const thread = { ...comment("thread", "main.tex"), replies: [
      { id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader",
        content: "Reply", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", editedAt: null }
    ] };
    expect(commentMatchesParticipants(thread, { participantIds: new Set(["reader"]) })).toBe(true);
    expect(commentMatchesParticipants(thread, { participantIds: new Set(["reader"]), topLevelOnly: true })).toBe(false);
    expect(commentMatchesParticipants(thread, { participantIds: new Set(["reader", "author"]), topLevelOnly: true })).toBe(true);
    expect(commentMatchesParticipants(thread, { participantIds: new Set(["other"]) })).toBe(false);
    expect(commentMatchesParticipants(thread, { participantIds: new Set(), topLevelOnly: true })).toBe(true);
    const options = { activeFile: "main.tex", scope: "file" as const, filter: "unresolved" as const,
      unreadMentions: [], participantIds: new Set(["reader"]) };
    const resolved = { ...thread, id: "resolved", resolved: true };
    const anotherFile = { ...thread, id: "another-file", filePath: "other.tex" };
    expect(filterCommentsForReview([thread, resolved, anotherFile], options).map((item) => item.id)).toEqual(["thread"]);
    expect(filterCommentsForReview([thread], { ...options, unreadMentionsOnly: true, unreadMentions: [mention(thread.id, "reply")] })).toEqual([thread]);
    expect(filterCommentsForReview([thread], { ...options, unreadMentionsOnly: true })).toEqual([]);
    expect(buildVisibleReviewQueue([thread], { ...options, topLevelOnly: true }, [thread.id])).toEqual([thread]);
    expect(buildVisibleReviewQueue([anotherFile], options, [anotherFile.id])).toEqual([]);
  });

  it("collects distinct authors including reply-only participants and deleted users", () => {
    const deleted = { ...comment("deleted", "main.tex"), authorId: null, authorUsername: null, authorDisplayName: null };
    const thread = { ...comment("thread", "main.tex"), replies: [
      { id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader",
        content: "Reply", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", editedAt: null },
      { id: "deleted-reply", authorId: null, authorUsername: null, authorDisplayName: null,
        content: "Reply", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", editedAt: null }
    ] };
    expect(collectCommentParticipants([thread, deleted, comment("same-author", "main.tex")]).map((p) => p.authorId)).toEqual([null, "author", "reader"]);
    expect(commentMatchesParticipants(deleted, { participantIds: new Set([null]) })).toBe(true);
    expect(commentMatchesParticipants(thread, { participantIds: new Set([null]) })).toBe(true);
    expect(commentMatchesParticipants(thread, { participantIds: new Set([null]), topLevelOnly: true })).toBe(false);
    expect(collectCommentParticipants([])).toEqual([]);
  });

  it("intersects unread notifications with resolution status instead of replacing it", () => {
    const source = [comment("open-mentioned", "main.tex"), comment("open-other", "main.tex"),
      comment("resolved-mentioned", "main.tex", true), comment("resolved-other", "main.tex", true)];
    const options = { activeFile: "main.tex", scope: "file" as const, filter: "unresolved" as const,
      unreadMentionsOnly: true, unreadMentions: [mention("open-mentioned"), mention("resolved-mentioned", "reply")] };
    expect(buildVisibleReviewQueue(source, options).map((item) => item.id)).toEqual(["open-mentioned"]);
    expect(buildVisibleReviewQueue(source, { ...options, filter: "resolved" }).map((item) => item.id)).toEqual(["resolved-mentioned"]);
    expect(buildVisibleReviewQueue(source, { ...options, unreadMentionsOnly: false }).map((item) => item.id)).toEqual(["open-mentioned", "open-other"]);
    expect(buildVisibleReviewQueue(source, { ...options, unreadMentions: [] })).toEqual([]);
    const read = { ...mention("open-mentioned"), readAt: "2026-02-01T00:00:00.000Z" };
    expect(buildVisibleReviewQueue(source, { ...options, unreadMentions: [read] })).toEqual([]);
    expect(buildVisibleReviewQueue(source, { ...options, participantIds: new Set(["another-author"]) })).toEqual([]);
    expect(buildVisibleReviewQueue(source, { ...options, unreadMentions: [] }, ["open-mentioned"]).map((item) => item.id)).toEqual(["open-mentioned"]);
  });
});
