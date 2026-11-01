// @vitest-environment happy-dom
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestionAttachment, type SuggestionSourceTarget } from "../src/client/workspace/SuggestionAttachment";
import { SuggestionEditor } from "../src/client/workspace/SuggestionEditor";
import { CommentThread } from "../src/client/workspace/Comments";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";
import { api } from "../src/client/api";
import type { Comment, SuggestionDraft } from "../src/shared/comments";
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

function EditorProbe({ authorId = "owner" }: { authorId?: string }) {
  const [value, setValue] = useState<SuggestionDraft | null>(null);
  return createElement(SuggestionEditor, { projectId: "project", ownerId: "owner", authorId, original: "prove", value, onChange: setValue, variant: "composer" });
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
    await act(async () => root.render(createElement(EditorProbe)));
    await click(".suggestion-add");
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
    await act(async () => root.render(createElement(EditorProbe)));
    await click(".suggestion-add");
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.disabled).toBe(true); expect(select.value).toBe("");
    expect([...select.options].map((option) => option.value)).toEqual([""]);
    expect(host.textContent).toContain("No other project members have write access");
  });

  it("blocks self-review from stale data and excludes the original author when the owner reassigns", async () => {
    comment.authorId = "owner";
    await render(); await click(".suggestion-toggle");
    expect(host.querySelector(".suggestion-actions")).toBeNull();
    expect(host.textContent).toContain("The comment author cannot review their own suggestion.");
    await click(".suggestion-assignment .suggestion-text-action");
    expect([...host.querySelectorAll("option")].map((option) => option.value)).toEqual(["", "writer"]);
    expect(host.querySelector<HTMLButtonElement>(".suggestion-assignment .suggestion-actions button")?.disabled).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/projects/project/suggestion-reviewers?commentId=c", expect.any(Object));
  });

  it("still offers the owner as reviewer when they reassign someone else's suggestion", async () => {
    comment.authorId = "writer";
    await render(); await click(".suggestion-toggle");
    await click(".suggestion-assignment .suggestion-text-action");
    expect([...host.querySelectorAll("option")].map((option) => option.value)).toEqual(["", "owner"]);
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("owner");
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
    expect(host.querySelector<HTMLButtonElement>(".suggestion-actions button:last-child")!.disabled).toBe(true);
    comment = { ...comment, suggestion: { ...comment.suggestion!, status: "accepted", decidedById: "owner", decidedByDisplayName: "Owner", decidedAt: "2026-11-01" } };
    await act(async () => finish({ change: { kind: "suggestion", commentId: "c", filePath: "main.tex", suggestion: comment.suggestion }, summary }));
    await render();
    expect(host.textContent).toContain("Accepted"); expect(host.textContent).toContain("Reviewed by Owner");
    expect(comment.resolved).toBe(false); expect(host.querySelector(".suggestion-actions")).toBeNull();
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
    await act(async () => root.render(createElement(EditorProbe, { authorId: "reader" })));
    await click(".suggestion-add");
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
