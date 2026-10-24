// @vitest-environment happy-dom
import { act, createElement, Fragment, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentThread } from "../src/client/workspace/Comments";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import i18n from "../src/client/i18n";
import type { Comment } from "../src/client/types";
import { withDiscussionQueries } from "./discussionTestUtils";

const now = Date.parse("2026-10-21T12:00:00Z");
const comment: Comment = {
  id: "thread", filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
  selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1,
  content: "Original comment", resolved: false, orphaned: false,
  resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null,
  createdAt: "2026-10-15T12:41:53Z", updatedAt: "2026-10-15T12:41:53Z", editedAt: null,
  replies: [{ id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader",
    content: "A reply", createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z", editedAt: null }]
};
let root: Root;
let host: HTMLDivElement;
let props: ComponentProps<typeof CommentThread>;
const render = () => act(async () => {
  root.render(withDiscussionQueries(createElement(Fragment, null, createElement(CommentThread, props), createElement(GlobalTooltip))));
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(now);
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  // Essential date and resolve tooltips must survive disabled interface tips.
  host.dataset.texliteTooltips = "off";
  document.body.append(host);
  root = createRoot(host);
  props = {
    projectId: "project", comment, currentUserId: "viewer", draftStore: new CommentDraftStore(),
    onFocus: vi.fn(), onActivate: vi.fn(), onReplyExpansionChange: vi.fn(), onToggle: vi.fn(async () => {}),
    onMarkMentionRead: async () => true, onReply: async () => true, onEdit: async () => true,
    onDelete: async () => true, onEditReply: async () => true, onDeleteReply: async () => true
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("comment reading and actions", () => {
  it("groups an initial avatar and strong author identity with a smaller relative date and full hover date", async () => {
    await render();
    expect(host.querySelector(".comment-avatar")?.textContent).toBe("A");
    expect(host.querySelector(".comment-avatar")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".comment-author strong")?.textContent).toBe("Author");
    for (const identity of host.querySelectorAll(".comment-author-details")) {
      expect(identity.querySelector(".comment-author")?.nextElementSibling?.className).toBe("comment-times");
    }
    const time = host.querySelector<HTMLElement>(".comment-times time")!;
    expect(time.textContent).toBe("5d ago");
    expect(time.getAttribute("datetime")).toBe(comment.createdAt);
    expect(time.hasAttribute("title")).toBe(false);
    expect(time.dataset.tooltip).toBe(new Date(comment.createdAt).toLocaleString("en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    }));
    await act(async () => { time.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe(time.dataset.tooltip);
    await act(async () => { time.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("updates relative dates and translated labels when the language changes", async () => {
    props.comment = { ...comment, orphaned: true, editedAt: "2026-10-16T12:00:00Z" };
    await render();
    expect(host.querySelector(".comment-location")?.textContent).toBe("Source deleted");
    expect(host.querySelector(".comment-times small")?.textContent).toBe("edited");
    await act(async () => { await i18n.changeLanguage("zh"); });
    expect(host.querySelector(".comment-times time")?.textContent).toBe("5 天前");
    expect(host.querySelector(".comment-location")?.textContent).toBe("源码已删除");
    expect(host.querySelector(".comment-times small")?.textContent).toBe("已编辑");
  });

  it("opens the reply placeholder without moving the source cursor, and resumes an existing hidden draft", async () => {
    props.draftStore.open("thread", "reply", "Unsent reply");
    props.draftStore.hide("thread", "reply");
    await render();
    const placeholder = host.querySelector<HTMLButtonElement>(".reply-action")!;
    expect(placeholder.textContent).toBe(i18n.t("editor.resumeReply"));
    await act(async () => placeholder.click());
    expect(props.onActivate).toHaveBeenCalled();
    expect(props.onFocus).not.toHaveBeenCalled();
    expect(props.onReplyExpansionChange).toHaveBeenCalledWith(true);
    expect(host.querySelector(".reply-action")).toBeNull();
    expect(host.querySelector("textarea")?.value).toBe("Unsent reply");
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    const cancel = host.querySelector<HTMLButtonElement>('.comment-reply-form button[type="button"]')!;
    await act(async () => cancel.click());
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".reply-action")?.textContent).toBe("Reply…");
  });

  it("keeps resolve in the header, accessible to readers and protected while pending", async () => {
    let finish!: () => void;
    props.onToggle = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    const resolve = host.querySelector<HTMLButtonElement>(".comment-header .resolve")!;
    expect(resolve.textContent).toBe("");
    expect(resolve.getAttribute("aria-label")).toBe("Resolve");
    expect(resolve.dataset.tooltip).toBe("Resolve");
    expect(resolve.hasAttribute("data-texlite-tooltip-always")).toBe(true);
    await act(async () => resolve.click());
    expect(resolve.disabled).toBe(true);
    expect(resolve.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>(".reply-action")?.disabled).toBe(true);
    await act(async () => resolve.click());
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    expect(props.onFocus).not.toHaveBeenCalled();
    await act(async () => finish());
    props.comment = { ...comment, resolved: true };
    await render();
    expect(resolve.getAttribute("aria-label")).toBe("Reopen");
    expect(resolve.disabled).toBe(false);
  });

  it("retains focusable author menus and a file-independent reply action", async () => {
    props.currentUserId = "reader";
    await render();
    expect(host.querySelector(".comment-header .comment-actions-menu-trigger")).toBeNull();
    const menu = host.querySelector<HTMLButtonElement>(".comment-reply .comment-actions-menu-trigger")!;
    expect(menu.tabIndex).toBe(0);
    expect(menu.getAttribute("aria-label")).toBe(i18n.t("editor.replyActions"));
    expect(menu.getAttribute("aria-haspopup")).toBe("menu");
    expect(host.querySelector(".reply-action")?.textContent).toBe("Reply…");
  });

  it.each([[false, "comment"], [true, "comment"], [false, "reply"], [true, "reply"]] as const)("plays the deletion effect only after success (success=%s, target=%s)", async (success, kind) => {
    props.currentUserId = kind === "reply" ? "reader" : "author";
    let finish!: (deleted: boolean) => void;
    const remove = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    if (kind === "reply") props.onDeleteReply = remove;
    else props.onDelete = remove;
    await render();
    const article = host.querySelector<HTMLElement>(kind === "reply" ? ".comment-reply" : ".comment-thread")!;
    const rect = kind === "reply" ? new DOMRect(80, 120, 190, 70) : new DOMRect(50, 50, 240, 150);
    vi.spyOn(article, "getBoundingClientRect").mockReturnValue(rect);
    const menu = article.querySelector<HTMLButtonElement>(".comment-actions-menu-trigger")!;
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const deleteAction = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === (kind === "reply" ? "Delete reply" : "Delete comment"))!;
    await act(async () => deleteAction.click());
    const confirm = document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!;
    expect(document.querySelector(".dialog-header p")?.textContent).toBe(kind === "reply" ? "Delete this reply? This cannot be undone." : "Delete this comment and its replies? This cannot be undone.");
    await act(async () => confirm.click());
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(remove).toHaveBeenCalledTimes(1);
    if (kind === "reply") expect(remove).toHaveBeenCalledWith("reply");
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    await act(async () => finish(success));
    expect(Boolean(document.querySelector(".comment-paper-shred"))).toBe(success);
    expect(Boolean(document.querySelector(".dialog-content"))).toBe(!success);
    if (!success) expect(document.querySelector('.dialog-content [class~="dialog-error"]')?.textContent).toBe(i18n.t("editor.commentDeleteFailed"));
    if (success) {
      const layer = document.querySelector<HTMLElement>(".comment-paper-shred")!;
      expect(layer.style.left).toBe(`${rect.left}px`);
      expect(layer.style.width).toBe(`${rect.width}px`);
      layer.dispatchEvent(new Event("animationend"));
    }
  });

  it("keeps a thrown deletion error inside the confirmation dialog", async () => {
    props.currentUserId = "author";
    props.onDelete = vi.fn(async () => { throw new Error("The server is unavailable. Please retry."); });
    await render();
    const menu = host.querySelector<HTMLButtonElement>(".comment-header .comment-actions-menu-trigger")!;
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete comment")!;
    await act(async () => action.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".dialog-footer .danger")!.click());
    expect(document.querySelector('.dialog-content .dialog-error')?.textContent).toBe("The server is unavailable. Please retry.");
    expect(document.querySelector<HTMLButtonElement>(".dialog-footer .danger")?.disabled).toBe(false);
  });
});
