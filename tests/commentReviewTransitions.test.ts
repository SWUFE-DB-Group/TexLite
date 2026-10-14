import { describe, expect, it } from "vitest";
import type { Comment } from "../src/client/types";
import { COMMENT_EXIT_DURATION_MS, reconcileReviewCommentEntries } from "../src/client/workspace/useCommentReviewTransitions";

function comment(id: string, resolved = false): Comment {
  return {
    id, filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "Text", startOffset: 0, endOffset: 4, startLine: 1, endLine: 1,
    content: "Review", resolved, orphaned: false, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", editedAt: null, replies: []
  };
}

describe("comment status exit transitions", () => {
  it.each([false, true])("animates a successful status change out of its original tab (resolved=%s)", (resolved) => {
    const before = comment("first", resolved);
    const next = comment("next", resolved);
    const changed = { ...before, resolved: !resolved };
    const entries = reconcileReviewCommentEntries([{ comment: before, exitAt: null }, { comment: next, exitAt: null }],
      [next], [changed, next], resolved ? "resolved" : "unresolved", 100);
    expect(entries.map((entry) => entry.comment.id)).toEqual(["first", "next"]);
    expect(entries[0]).toEqual({ comment: changed, exitAt: 100 + COMMENT_EXIT_DURATION_MS + 50 });
    expect(entries[1]?.exitAt).toBeNull();
  });

  it("does not animate a failed operation which leaves the status unchanged", () => {
    const before = comment("first");
    expect(reconcileReviewCommentEntries([{ comment: before, exitAt: null }], [before], [before], "unresolved", 100))
      .toEqual([{ comment: before, exitAt: null }]);
  });

  it("preserves exit deadlines across refreshes and supports multiple departures", () => {
    const first = comment("first");
    const second = comment("second");
    const firstResolved = { ...first, resolved: true };
    const secondResolved = { ...second, resolved: true };
    const initial = reconcileReviewCommentEntries([{ comment: first, exitAt: null }, { comment: second, exitAt: null }],
      [second], [firstResolved, second], "unresolved", 100);
    const refreshed = reconcileReviewCommentEntries(initial, [], [firstResolved, secondResolved], "unresolved", 200);
    expect(refreshed.map((entry) => entry.exitAt)).toEqual([100 + COMMENT_EXIT_DURATION_MS + 50, 200 + COMMENT_EXIT_DURATION_MS + 50]);
  });

  it("cancels an exit when the thread returns to the current queue", () => {
    const before = comment("first");
    const reopened = { ...before, resolved: false };
    expect(reconcileReviewCommentEntries([{ comment: { ...before, resolved: true }, exitAt: 300 }],
      [reopened], [reopened], "unresolved", 200)).toEqual([{ comment: reopened, exitAt: null }]);
  });

  it("does not preserve deleted comments or departures due to participants/unread filters", () => {
    const before = comment("first");
    const previous = [{ comment: before, exitAt: null }];
    expect(reconcileReviewCommentEntries(previous, [], [], "unresolved", 100)).toEqual([]);
    expect(reconcileReviewCommentEntries(previous, [], [before], "unresolved", 100)).toEqual([]);
    expect(reconcileReviewCommentEntries([{ comment: before, exitAt: 300 }], [], [], "unresolved", 100)).toEqual([]);
  });

  it("retains visible source order while inserting an exiting card at its prior position", () => {
    const first = comment("first");
    const second = comment("second");
    const third = comment("third");
    const entries = reconcileReviewCommentEntries([first, second, third].map((item) => ({ comment: item, exitAt: null })),
      [third, first], [first, { ...second, resolved: true }, third], "unresolved", 100);
    expect(entries.map((entry) => entry.comment.id)).toEqual(["third", "second", "first"]);
  });
});
