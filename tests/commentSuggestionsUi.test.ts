// @vitest-environment happy-dom
import { act, createElement, Fragment, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionAttachment, type SuggestionSourceTarget } from "../src/client/workspace/SuggestionAttachment";
import { CommentThread } from "../src/client/workspace/Comments";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import { api, ApiError } from "../src/client/api";
import { discussionKeys } from "../src/client/workspace/discussionCache";
import type { Comment } from "../src/shared/comments";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
let root: Root, host: HTMLDivElement, client: ReturnType<typeof discussionTestClient>, comment: Comment;
const summary = { totalCount: 1, unresolvedCount: 1, filePaths: ["main.tex"] };
const users = [{ id: "owner", displayName: "Owner", username: "owner" }, { id: "writer", displayName: "Writer", username: "writer" }];
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  comment = { id: "c", filePath: "main.tex", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader", selectedText: "prove", startOffset: 0, endOffset: 5,
    startLine: 1, endLine: 1, anchorSourceHash: "a".repeat(64), content: "Please be cautious.", resolved: false, orphaned: false,
    resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null,
    createdAt: "2026-11-01", updatedAt: "2026-11-01", editedAt: null, replies: [],
    suggestion: { originalText: "prove", replacementText: "suggest", reviewerId: "owner", reviewerDisplayName: "Owner", reviewerUsername: "owner", reviewerAvailable: true,
      status: "pending", applicable: true, applying: false, decidedById: null, decidedByDisplayName: null, decidedByUsername: null, decidedAt: null } };
  vi.mocked(api).mockReset().mockImplementation(async (url) => {
    if (url.includes("suggestion-reviewers")) return { users, ownerId: "owner" } as never;
    if (url.includes("/mentions")) return { mentions: [] } as never;
    return { comments: [comment], summary } as never;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = discussionTestClient();
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
const render = (userId = "owner", canEdit = true, draftTarget?: SuggestionSourceTarget) => act(async () => root.render(withDiscussionQueries(createElement(SuggestionAttachment, {
  projectId: "project", ownerId: "owner", currentUserId: userId, canEdit, comment, draftTarget
}), client)));
const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
function change(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const renderThread = (overrides: Partial<ComponentProps<typeof CommentThread>> = {}) => act(async () => root.render(withDiscussionQueries(createElement(CommentThread, {
  projectId: "project", comment, projectOwnerId: "owner", canEditSource: true, currentUserId: "owner", draftStore: new CommentDraftStore(),
  onMarkMentionRead: async () => true, onFocus: vi.fn(), onActivate: vi.fn(), onToggle: async () => {}, onReply: async () => true,
  onEdit: async () => true, onDelete: async () => true, onEditReply: async () => true, onDeleteReply: async () => true, onReplyExpansionChange: vi.fn(), ...overrides
}), client)));
const openThreadMenu = () => act(async () => {
  host.querySelector<HTMLButtonElement>(".comment-header .comment-actions-menu-trigger")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
});

describe("suggestions as comment attachments", () => {
  it.each([["en", "Awaiting Owner"], ["zh", "待 Owner 审核"], ["zh-Hant", "待 Owner 審核"]])("emphasizes only the waiting reviewer and shows their username with interface tooltips off (%s)", async (language, label) => {
    await i18n.changeLanguage(language);
    host.dataset.texliteTooltips = "off";
    await act(async () => root.render(withDiscussionQueries(createElement(Fragment, null,
      createElement(SuggestionAttachment, { projectId: "project", ownerId: "owner", currentUserId: "reader", canEdit: false, comment }),
      createElement(GlobalTooltip)
    ), client)));
    const name = host.querySelector<HTMLElement>(".suggestion-reviewer-name")!;
    expect(name.tagName).toBe("STRONG"); expect(name.textContent).toBe("Owner");
    expect(name.parentElement?.textContent).toBe(label);
    expect(name.dataset.tooltip).toBe("@owner"); expect(name.hasAttribute("title")).toBe(false);
    await act(async () => name.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe("@owner");
    expect(host.querySelector(".suggestion-toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["accepted", "rejected"] as const)("emphasizes the deciding user's name with a username tooltip after %s", async (status) => {
    comment.suggestion = { ...comment.suggestion!, status, decidedById: "owner", decidedByDisplayName: "Owner", decidedByUsername: "owner", decidedAt: "2026-11-01T12:00:00Z" };
    for (const [language, label] of [["en", "Reviewed by Owner"], ["zh", "由 Owner 审核"], ["zh-Hant", "由 Owner 審核"]]) {
      await i18n.changeLanguage(language);
      await render("reader", false);
      if (!host.querySelector(".suggestion-details")) await click(".suggestion-toggle");
      const name = host.querySelector<HTMLElement>(".suggestion-decision .suggestion-reviewer-name")!;
      expect(name.tagName).toBe("STRONG"); expect(name.textContent).toBe("Owner");
      expect(name.parentElement?.textContent).toBe(label);
      expect(name.dataset.tooltip).toBe("@owner"); expect(name.hasAttribute("data-texlite-tooltip-always")).toBe(true);
      expect(name.hasAttribute("title")).toBe(false);
      expect(host.querySelector(".suggestion-decision time")?.getAttribute("datetime")).toBe("2026-11-01T12:00:00Z");
    }
  });

  it("does not invent a username for a deleted reviewer or render display-name markup as HTML", async () => {
    comment.suggestion!.reviewerDisplayName = "Owner <team>";
    comment.suggestion!.reviewerUsername = null;
    await render("reader", false);
    const name = host.querySelector<HTMLElement>(".suggestion-reviewer-name")!;
    expect(name.textContent).toBe("Owner <team>");
    expect(name.hasAttribute("data-tooltip")).toBe(false); expect(name.querySelector("team")).toBeNull();
  });

  it("opens the later-suggestion composer from the author menu without a separate inline action or source jump", async () => {
    comment.suggestion = null;
    const onFocus = vi.fn(), onActivate = vi.fn();
    await renderThread({ currentUserId: "reader", canEditSource: false, onFocus, onActivate });
    expect(host.querySelector(".suggestion-add")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    await openThreadMenu();
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === "Attach a suggested change")!;
    expect(action).toBeTruthy();
    await act(async () => action.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector("textarea")?.value).toBe("prove");
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("owner");
    expect(onActivate).toHaveBeenCalled(); expect(onFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    await click('[aria-label="Remove suggested change"]');
    expect(host.querySelector("textarea")).toBeNull();
    await openThreadMenu();
    expect([...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toContain("Attach a suggested change");
  });

  it.each(["resolved", "orphaned", "existing suggestion"])("hides the menu attachment action for a %s discussion", async (state) => {
    if (state !== "existing suggestion") { comment.suggestion = null; comment[state as "resolved" | "orphaned"] = true; }
    await renderThread({ currentUserId: "reader" });
    await openThreadMenu();
    const actions = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
    expect(actions).not.toContain("Attach a suggested change");
    expect(actions).toEqual(["Edit comment", "Delete comment"]);
  });
  it("does not default an owner's own suggestion to themselves and only offers other writers", async () => {
    comment.authorId = "owner"; comment.suggestion = null;
    await render("owner", true, { original: comment.selectedText, sourceHash: comment.anchorSourceHash! });
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("");
    expect([...select.options].map((option) => option.value)).toEqual(["", "writer"]);
    await act(async () => { select.value = "writer"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => change(host.querySelector("textarea")!, "suggest"));
    expect(select.value).toBe("writer");
    expect(host.querySelector("textarea")?.value).toBe("suggest");
  });

  it("explains when no other writable reviewer exists without offering self-review", async () => {
    vi.mocked(api).mockResolvedValueOnce({ users: [users[0]], ownerId: "owner" });
    comment.authorId = "owner"; comment.suggestion = null;
    await render("owner", true, { original: comment.selectedText, sourceHash: comment.anchorSourceHash! });
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.disabled).toBe(true); expect(select.value).toBe("");
    expect([...select.options].map((option) => option.value)).toEqual([""]);
    expect(host.textContent).toContain("No other project members have write access");
  });

  it("blocks self-review from stale data without exposing a change-reviewer control", async () => {
    comment.authorId = "owner";
    await render(); await click(".suggestion-toggle");
    expect(host.querySelector(".suggestion-actions")).toBeNull();
    expect(host.textContent).toContain("The comment author cannot review their own suggestion.");
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).not.toContain("Change reviewer");
    expect(api).not.toHaveBeenCalled();
  });

  it("does not let an owner or another collaborator edit someone else's suggestion", async () => {
    for (const user of ["owner", "writer"]) {
      await render(user);
      expect(host.querySelector(".suggestion-revision-action")).toBeNull();
    }
  });
  it("keeps the diff collapsed, lets everyone read it and limits decisions to the assigned writable reviewer", async () => {
    await render("reader", false);
    expect(host.textContent).toContain("Awaiting Owner"); expect(host.querySelector(".suggestion-diff")).toBeNull();
    await click(".suggestion-toggle");
    expect(host.querySelector("del")?.textContent).toBeTruthy(); expect(host.querySelector("ins")?.textContent).toBeTruthy();
    expect(host.querySelector(".suggestion-actions")).toBeNull();
    await click(".suggestion-toggle"); expect(host.querySelector(".suggestion-diff")).toBeNull();
    await render("writer"); await click(".suggestion-toggle");
    expect(host.querySelector(".suggestion-actions")).toBeNull();
  });

  it("prevents duplicate reviews, retains errors and updates the cache without closing the discussion", async () => {
    await render(); await click(".suggestion-toggle");
    vi.mocked(api).mockRejectedValueOnce(new Error("Review failed"));
    await click(".suggestion-actions button:first-child");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Review failed");
    let finish!: (result: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>(".suggestion-actions button:first-child")!;
      button.click(); button.click();
    });
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
    for (const [, options] of vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST")) {
      expect(JSON.parse(options!.body as string)).toEqual({ action: "accept", expectedReplacementText: "suggest" });
    }
    expect(host.querySelector<HTMLButtonElement>(".suggestion-actions button:last-child")!.disabled).toBe(true);
    comment = { ...comment, suggestion: { ...comment.suggestion!, status: "accepted", decidedById: "owner", decidedByDisplayName: "Owner", decidedAt: "2026-11-01" } };
    await act(async () => finish({ change: { kind: "suggestion", commentId: "c", filePath: "main.tex", suggestion: comment.suggestion }, summary }));
    await render();
    expect(host.textContent).toContain("Accepted"); expect(host.textContent).toContain("Reviewed by Owner");
    expect(comment.resolved).toBe(false); expect(host.querySelector(".suggestion-actions")).toBeNull();
  });

  it("lets the author revise without selecting a reviewer, preserves failed drafts and prevents duplicate saves", async () => {
    await render("reader", false); await click(".suggestion-toggle");
    await click(".suggestion-revision-action button");
    expect(host.querySelector("textarea")?.value).toBe("suggest");
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".save-button")!.disabled).toBe(true);
    expect([...host.querySelectorAll(".suggestion-revision-editor .comment-form-actions > button")].map((button) => button.textContent)).toEqual(["Cancel", "Save"]);
    await act(async () => change(host.querySelector("textarea")!, "indicate"));
    expect(host.querySelector(".suggestion-diff ins")?.textContent).toBe("indicate");
    vi.mocked(api).mockRejectedValueOnce(new Error("Save failed"));
    await click(".save-button");
    expect(host.querySelector("textarea")?.value).toBe("indicate");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
    let finish!: (result: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>(".save-button")!;
      button.click(); button.click();
    });
    const calls = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe("/api/projects/project/comments/c/suggestion");
    expect(JSON.parse(calls[1][1]!.body as string)).toEqual({ replacementText: "indicate", expectedReplacementText: "suggest" });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
    comment = { ...comment, suggestion: { ...comment.suggestion!, replacementText: "indicate" } };
    await act(async () => finish({ change: { kind: "suggestion", commentId: "c", filePath: "main.tex", suggestion: comment.suggestion }, summary }));
    await render("reader", false);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".suggestion-diff ins")?.textContent).toBe("indicate");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Saved");
    expect(comment.content).toBe("Please be cautious.");
    expect(comment.suggestion?.reviewerId).toBe("owner");
  });

  it("keeps a local revision during remote refreshes, blocks overwriting it and can cancel to the latest version", async () => {
    await render("reader", false); await click(".suggestion-toggle");
    await click(".suggestion-revision-action button");
    await act(async () => change(host.querySelector("textarea")!, "my local draft"));
    comment = { ...comment, suggestion: { ...comment.suggestion!, replacementText: "from another tab" } };
    await render("reader", false);
    expect(host.querySelector("textarea")?.value).toBe("my local draft");
    expect(host.querySelector<HTMLButtonElement>(".save-button")!.disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    await click(".suggestion-revision-editor .comment-form-actions button:first-child");
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".suggestion-diff")?.textContent).toContain("from another tab");
    await click(".suggestion-revision-action button");
    expect(host.querySelector("textarea")?.value).toBe("from another tab");
    expect(api).not.toHaveBeenCalled();
  });

  it("refreshes stale suggestion data after a rejected save but retains the typed replacement", async () => {
    client.setQueryData(discussionKeys.file("project", "main.tex"), { comments: [comment] });
    client.setQueryData(discussionKeys.all("project"), { comments: [comment] });
    await render("reader", false); await click(".suggestion-toggle");
    await click(".suggestion-revision-action button");
    await act(async () => change(host.querySelector("textarea")!, "my draft"));
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Check the latest suggestion", 409, "SUGGESTION_UPDATED"));
    await click(".save-button");
    expect(host.querySelector("textarea")?.value).toBe("my draft");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Check the latest suggestion");
    expect(client.getQueryState(discussionKeys.file("project", "main.tex"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(discussionKeys.all("project"))?.isInvalidated).toBe(true);
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["accepted", "rejected", "applying"])("removes the editing controls when the suggestion becomes %s", async (state) => {
    await render("reader", false); await click(".suggestion-toggle");
    await click(".suggestion-revision-action button");
    await act(async () => change(host.querySelector("textarea")!, "unsaved text"));
    comment = { ...comment, suggestion: { ...comment.suggestion!, ...(state === "applying" ? { applying: true } : { status: state as "accepted" | "rejected" }) } };
    await render("reader", false);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".suggestion-revision-action")).toBeNull();
    expect(host.querySelector(".save-button")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("shows deletion intent in the revision editor and prevents saving the unchanged original", async () => {
    await render("reader", false); await click(".suggestion-toggle");
    await click(".suggestion-revision-action button");
    await act(async () => change(host.querySelector("textarea")!, "prove"));
    expect(host.querySelector<HTMLButtonElement>(".save-button")!.disabled).toBe(true);
    await act(async () => change(host.querySelector("textarea")!, ""));
    expect(host.textContent).toContain("This suggestion deletes the selected text.");
    expect(host.querySelector<HTMLButtonElement>(".save-button")!.disabled).toBe(false);
  });

  it("disables accepting stale source but still allows rejection", async () => {
    comment.suggestion!.applicable = false;
    await render(); await click(".suggestion-toggle");
    const buttons = host.querySelectorAll<HTMLButtonElement>(".suggestion-actions button");
    expect(buttons[0].disabled).toBe(true); expect(buttons[1].disabled).toBe(false);
    expect(host.textContent).toContain("The original text has changed.");
  });

  it("preserves every changed fragment while compacting long unchanged context", async () => {
    comment.suggestion!.originalText = "same ".repeat(80) + "FIRST" + " middle ".repeat(80) + "LAST" + " tail ".repeat(80);
    comment.suggestion!.replacementText = comment.suggestion!.originalText.replace("FIRST", "NEWFIRST").replace("LAST", "NEWLAST");
    await render(); await click(".suggestion-toggle");
    expect(host.querySelector(".suggestion-diff")?.textContent).toContain("NEWFIRST");
    expect(host.querySelector(".suggestion-diff")?.textContent).toContain("NEWLAST");
    expect(host.querySelector(".suggestion-diff")?.textContent?.length).toBeLessThan(600);
    await click(".suggestion-text-action");
    expect(host.querySelector(".suggestion-diff")?.textContent?.length).toBeGreaterThan(1500);
  });

  it("attaches later using the original source binding instead of silently retargeting a refreshed comment", async () => {
    comment.suggestion = null;
    const target = { original: comment.selectedText, sourceHash: comment.anchorSourceHash! };
    await render("reader", false, target);
    expect(host.querySelector(".suggestion-add")).toBeNull();
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("owner");
    expect([...host.querySelectorAll("option")].map((node) => node.textContent)).toContain("Owner (@owner)");
    await act(async () => change(host.querySelector("textarea")!, "suggest"));
    comment = { ...comment, anchorSourceHash: "b".repeat(64), selectedText: "new passage", orphaned: true };
    await render("reader", false, target);
    vi.mocked(api).mockRejectedValueOnce(new Error("The original changed"));
    await click(".suggestion-submit");
    const post = vi.mocked(api).mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ replacementText: "suggest", reviewerId: "owner", sourceHash: "a".repeat(64) });
    expect(host.querySelector("textarea")?.value).toBe("suggest");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The original changed");
  });

  it("labels an empty replacement as deletion and can remove an unsubmitted attachment", async () => {
    comment.suggestion = null;
    await render("reader", false, { original: comment.selectedText, sourceHash: comment.anchorSourceHash! });
    await act(async () => change(host.querySelector("textarea")!, ""));
    expect(host.textContent).toContain("This suggestion deletes the selected text.");
    await click('[aria-label="Remove suggested change"]');
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("keeps the normal comment and unread controls while blocking resolution of a pending attachment", async () => {
    await renderThread({ unreadCommentMentionId: "m", unreadCommentMentionKind: "review" });
    expect(host.textContent).toContain("Please be cautious.");
    expect(host.textContent).toContain("Your review was requested");
    expect(host.querySelector<HTMLButtonElement>("button.resolve")!.disabled).toBe(true);
    expect(host.querySelector(".suggestion-diff")).toBeNull();
  });
});
