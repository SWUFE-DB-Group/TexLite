// @vitest-environment happy-dom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import i18n from "../src/client/i18n";
import type { Comment, Project, SiteConfig } from "../src/client/types";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";
import { WorkspaceContextPanel, type WorkspaceContextPanelProps } from "../src/client/workspace/WorkspaceContextPanel";

// Panel sizing is unrelated to the real drawer/thread interactions tested here.
vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children: ReactNode }) => createElement("div", null, children), Separator: () => null
}));

let root: Root, host: HTMLDivElement, props: WorkspaceContextPanelProps;
const network = vi.fn(async () => new Response(JSON.stringify({ users: [] }), { headers: { "content-type": "application/json" } }));
function comment(index: number, resolved = true): Comment {
  const createdAt = new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
  return { id: `comment-${index}`, filePath: "main.tex", sourceOrder: index,
    authorId: "author", authorUsername: "author", authorDisplayName: "Author", selectedText: `Source ${index}`,
    startOffset: index * 10, endOffset: index * 10 + 6, startLine: index, endLine: index,
    content: `Comment ${index}`, resolved, orphaned: false, resolvedById: "author", resolvedByUsername: "author",
    resolvedByDisplayName: "Author", resolvedAt: resolved ? createdAt : null, createdAt, updatedAt: createdAt, editedAt: null, replies: [] };
}
function Harness() {
  const [focus, setFocus] = useState<string | null>(null);
  return createElement(WorkspaceContextPanel, { ...props, focusedCommentId: props.focusedCommentId ?? focus,
    onFocusComment: (comment) => { props.onFocusComment(comment); setFocus(comment.id); },
    onClearFocusComment: () => { props.onClearFocusComment(); setFocus(null); } });
}
async function render() { await act(async () => root.render(createElement(Harness))); }
const threads = () => [...host.querySelectorAll<HTMLElement>('.comment-thread-slot:not(.is-exiting) .comment-thread')];
const loadMore = () => host.querySelector<HTMLButtonElement>(".comment-review-pagination button");
async function showResolved() {
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".comment-review-group button")]
    .find((button) => button.textContent?.startsWith("Resolved"))!.click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", network); network.mockClear();
  // Keep scheduled scrolling deterministic and independent from DOM geometry.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = {
    sidePanel: "comments", onClose: vi.fn(), project: {} as Project, projectId: "project", site: {} as SiteConfig,
    files: [], currentUserId: "author", comments: Array.from({ length: 126 }, (_, index) => comment(index + 1)),
    commentDraftStore: new CommentDraftStore(), commentsLoading: false, commentsError: "", onRetryComments: async () => {},
    activeFile: "main.tex", hasProjectCommentsScope: true, commentScope: "project", onCommentScopeChange: vi.fn(),
    onShowAllComments: vi.fn(), onClearFocusComment: vi.fn(), unreadMentions: [], onMarkMentionRead: async () => true,
    onMarkAllMentionsRead: async () => true, onFocusComment: vi.fn(), onToggleComment: async () => {},
    onReplyComment: async () => true, onEditComment: async () => true, onDeleteComment: async () => true,
    onEditCommentReply: async () => true, onDeleteCommentReply: async () => true, dictionaryWords: [], onDictionaryChange: vi.fn(),
    editorPreferences: defaultEditorPreferences, onEditorPreferences: vi.fn(), spellCheckCount: null, spellCheckUniqueCount: null,
    spellCheckIndex: -1, onSpellCheckNavigate: vi.fn(), onProject: vi.fn()
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("resolved comment Load more", () => {
  it("keeps status totals scoped to file/project while unread only narrows the active status queue", async () => {
    props.commentScope = "file";
    props.comments = [comment(1, false), comment(2, false), { ...comment(3, false), filePath: "other.tex" },
      comment(4), comment(5), { ...comment(6), filePath: "other.tex" }];
    props.unreadMentions = [1, 3, 4, 6].map((index) => ({ id: `mention-${index}`, projectId: "project",
      commentId: `comment-${index}`, replyId: null, filePath: props.comments[index - 1].filePath, content: "@author",
      resolved: props.comments[index - 1].resolved, createdAt: props.comments[index - 1].createdAt, readAt: null, readReason: null }));
    await render();
    const statusLabels = () => [...host.querySelectorAll<HTMLButtonElement>('.comment-review-group[aria-label="Comment filter"] button')]
      .map((button) => button.textContent);
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    expect(threads()).toHaveLength(2);
    await act(async () => host.querySelector<HTMLButtonElement>(".comment-unread-toggle")!.click());
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-1"]);
    expect(host.querySelector(".comment-unread-toggle span")?.textContent).toBe("1");
    await showResolved();
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-4"]);
    props.commentScope = "project"; await render();
    expect(statusLabels()).toEqual(["Open 3", "Resolved 3"]);
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-4", "comment-6"]);
    expect(host.querySelector(".comment-unread-toggle span")?.textContent).toBe("2");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.comment-review-group[aria-label="Comment filter"] button')]
      .find((button) => button.textContent?.startsWith("Open"))!.click());
    expect(statusLabels()).toEqual(["Open 3", "Resolved 3"]);
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-1", "comment-3"]);
  });

  it("keeps status totals unchanged when filtering by an author or including reply participants", async () => {
    const reviewer = { authorId: "reviewer", authorUsername: "reviewer", authorDisplayName: "Reviewer" };
    props.comments = [comment(1, false), { ...comment(2, false), ...reviewer }, comment(3), { ...comment(4), ...reviewer }];
    props.comments[0].replies = [{ ...reviewer, id: "reviewer-reply", content: "A reviewer reply",
      createdAt: props.comments[0].createdAt, updatedAt: props.comments[0].createdAt, editedAt: null }];
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>(".comment-participants-toggle")!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>(".comment-participant-option")]
      .find((option) => option.querySelector("strong")?.textContent === "Reviewer")!.querySelector<HTMLInputElement>("input")!.click());
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-2"]);
    const statusLabels = () => [...host.querySelectorAll<HTMLButtonElement>('.comment-review-group[aria-label="Comment filter"] button')]
      .map((button) => button.textContent);
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    await act(async () => document.querySelector<HTMLInputElement>(".comment-participants-root-only input")!.click());
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-1", "comment-2"]);
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    await showResolved();
    expect(threads().map((thread) => thread.dataset.commentId)).toEqual(["comment-4"]);
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
    await act(async () => host.querySelector<HTMLButtonElement>(".comment-participants-clear")!.click());
    expect(threads()).toHaveLength(2);
    expect(statusLabels()).toEqual(["Open 2", "Resolved 2"]);
  });

  it("shows 50, then 100, then the remaining threads, with correct totals and no requests", async () => {
    const first = props.comments[0];
    first.replies = Array.from({ length: 8 }, (_, index) => ({ id: `reply-${index}`, authorId: "author",
      authorUsername: "author", authorDisplayName: "Author", content: "Reply", createdAt: first.createdAt,
      updatedAt: first.createdAt, editedAt: null }));
    await render(); await showResolved();
    expect(threads()).toHaveLength(50);
    expect(host.querySelector(".comment-review-pagination")?.textContent).toContain("Showing 50 of 126 comments");
    expect(host.textContent).toContain("Resolved 126");
    await act(async () => loadMore()!.click());
    expect(threads()).toHaveLength(100);
    await act(async () => loadMore()!.click());
    expect(threads()).toHaveLength(126);
    expect(loadMore()).toBeNull();
    expect(host.textContent).toContain("No more resolved comments.");
    expect(network).not.toHaveBeenCalled();
  });

  it("leaves Open unlimited and resets to 50 after changing sorting", async () => {
    props.comments = props.comments.map((item) => ({ ...item, resolved: false }));
    await render();
    expect(threads()).toHaveLength(126);
    expect(host.querySelector(".comment-review-pagination")).toBeNull();
    props.comments = props.comments.map((item) => ({ ...item, resolved: true }));
    await render(); await showResolved();
    await act(async () => loadMore()!.click());
    props.comments = props.comments.map((item) => ({ ...item }));
    await render();
    expect(threads()).toHaveLength(100);
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(".comment-review-sort select")!;
      select.value = "time"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(threads()).toHaveLength(50);
    expect(threads()[0].dataset.commentId).toBe("comment-126");
  });

  it("applies filters to the whole queue before taking the first batch", async () => {
    props.unreadMentions = props.comments.slice(66).map((item) => ({ id: `mention-${item.id}`, projectId: "project",
      commentId: item.id, replyId: null, filePath: item.filePath, content: "@author", resolved: true,
      createdAt: item.createdAt, readAt: null, readReason: null }));
    await render(); await showResolved(); await act(async () => loadMore()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".comment-unread-toggle")!.click());
    expect(threads()).toHaveLength(50);
    expect(threads()[0].dataset.commentId).toBe("comment-67");
    expect(host.querySelector(".comment-review-pagination")?.textContent).toContain("Showing 50 of 60 comments");
    await act(async () => loadMore()!.click());
    expect(threads()).toHaveLength(60);
  });

  it("automatically reveals a notification's older reply beyond the initial 50 threads", async () => {
    props.comments[119].replies = Array.from({ length: 4 }, (_, index) => ({ id: `target-reply-${index}`, authorId: "author",
      authorUsername: "author", authorDisplayName: "Author", content: `Reply ${index}`, createdAt: props.comments[119].createdAt,
      updatedAt: props.comments[119].createdAt, editedAt: null }));
    await render(); await showResolved();
    props = { ...props, targetCommentId: "comment-120", targetReplyId: "target-reply-0" };
    await render();
    expect(threads()).toHaveLength(126);
    expect(host.querySelector('[data-comment-id="comment-120"] [data-comment-reply-id="target-reply-0"]')).not.toBeNull();
    props = { ...props, targetCommentId: null, targetReplyId: null }; await render();
    expect(threads()).toHaveLength(126);
  });

  it("extends the window when next/previous navigation crosses a batch boundary", async () => {
    props.focusedCommentId = "comment-50";
    await render(); await showResolved();
    props.focusedCommentId = undefined; await render();
    // Select the last thread in the first batch through the real source-focus action.
    await act(async () => threads()[49].click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Next comment"]')!.click());
    expect(threads()).toHaveLength(100);
    expect(host.querySelector(".comment-review-navigation output")?.textContent).toBe("51 / 126");
    expect(host.querySelector('[data-comment-id="comment-51"]')?.classList.contains("review-current")).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Previous comment"]')!.click());
    expect(threads()).toHaveLength(100);
    expect(host.querySelector(".comment-review-navigation output")?.textContent).toBe("50 / 126");
  });

  it("does not scroll back to an older focused thread when Load more is clicked", async () => {
    props.focusedCommentId = "comment-1";
    await render(); await showResolved();
    vi.mocked(requestAnimationFrame).mockClear();
    await act(async () => loadMore()!.click());
    expect(threads()).toHaveLength(100);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("keeps an active reply and its draft visible when refreshed source order moves it past the initial batch", async () => {
    await render(); await showResolved();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-comment-id="comment-10"] .reply-action')!.click());
    await act(async () => props.commentDraftStore.change("comment-10", "reply", "Unsent reply"));
    props.comments = props.comments.map((item) => item.id === "comment-10" ? { ...item, sourceOrder: 200 } : item);
    await render();
    expect(threads()).toHaveLength(126);
    expect(host.querySelector<HTMLTextAreaElement>('[data-comment-id="comment-10"] textarea')?.value).toBe("Unsent reply");
    expect(props.commentDraftStore.getThread("comment-10").reply?.content).toBe("Unsent reply");
  });

  it("fills a reopened thread's place while retaining its exit animation and accurate shown count", async () => {
    await render(); await showResolved();
    props.comments = props.comments.map((item) => item.id === "comment-1" ? { ...item, resolved: false } : item);
    await render();
    expect(threads()).toHaveLength(50);
    expect(host.querySelector('[data-comment-id="comment-51"]')).not.toBeNull();
    expect(host.querySelector(".comment-thread-slot.is-exiting")).not.toBeNull();
    expect(host.querySelector(".comment-review-pagination")?.textContent).toContain("Showing 50 of 125 comments");
    await act(async () => host.querySelector(".comment-thread-slot.is-exiting")!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(host.querySelector('[data-comment-id="comment-1"]')).toBeNull();
  });

  it("does not claim the end of the list during loading or after a refresh error", async () => {
    props.comments = props.comments.slice(0, 20);
    await render(); await showResolved();
    expect(host.textContent).toContain("No more resolved comments.");
    props.commentsLoading = true; await render();
    expect(host.textContent).not.toContain("No more resolved comments.");
    props.commentsLoading = false; props.commentsError = "Could not refresh"; await render();
    expect(host.textContent).not.toContain("No more resolved comments.");
    expect(threads()).toHaveLength(20);
  });
});
