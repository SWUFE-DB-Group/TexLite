// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposerDialog } from "../src/client/workspace/CommentComposerDialog";
import { commentSubmission } from "../src/client/workspace/commentSubmission";
import type { SuggestionDraft } from "../src/shared/comments";
import { api } from "../src/client/api";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<object>(), api: vi.fn() }));
let root: Root, host: HTMLDivElement, client: ReturnType<typeof discussionTestClient>;
const original = "The method outperforms existing approaches.";
const onSubmit = vi.fn(async () => {}), onCancel = vi.fn(), onClose = vi.fn();
function Harness({ busy = false }: { busy?: boolean }) {
  const [text, setText] = useState("");
  const [suggestion, setSuggestion] = useState<SuggestionDraft | null>(null);
  return createElement(CommentComposerDialog, { open: true, projectId: "project", ownerId: "owner", authorId: "author",
    selection: { selectedText: original, startOffset: 0, endOffset: original.length }, text, onText: setText,
    suggestion, onSuggestion: setSuggestion,
    submitting: busy, error: "", onSubmit, onCancel, onClose, draftRestored: false, canRetarget: false, onRetarget: () => {} });
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const render = (busy = false) => act(async () => root.render(withDiscussionQueries(createElement(Harness, { busy }), client)));
const click = (selector: string) => act(async () => dialog().querySelector<HTMLButtonElement>(selector)!.click());
function change(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  onSubmit.mockClear(); onCancel.mockClear(); onClose.mockClear();
  vi.mocked(api).mockReset().mockResolvedValue({ users: [{ id: "owner", displayName: "Owner", username: "owner" }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = discussionTestClient();
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe("comment composer presentation", () => {
  it("starts with a read-only original and hides the reviewer until edit mode is enabled", async () => {
    await render();
    const sections = [...dialog().querySelector(".dialog-body")!.children];
    expect(sections[0].className).toBe("comment-compose-original");
    expect(sections[0].querySelector("blockquote")?.textContent).toBe(original);
    expect(dialog().querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    expect(dialog().querySelectorAll("textarea")).toHaveLength(1);
    expect(dialog().querySelector(".comment-compose-reviewer")).toBeNull();
    expect(api).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Add a comment or edit the text");
  });

  it("reports an empty submission only after attempting to send and updates feedback while typing", async () => {
    await render(); await click(".comment-compose-actions .primary");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Add a comment or edit the text");
    await act(async () => change(dialog().querySelector("textarea")!, "Please add more evidence."));
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Comment");
    await click(".comment-compose-actions .primary"); expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("previews actual edits, preserves them through toggling and treats unchanged edit controls as a comment", async () => {
    await render(); await act(async () => change(dialog().querySelector("textarea")!, "Please qualify this claim."));
    await click('[role="switch"]');
    expect(dialog().querySelector<HTMLSelectElement>("select")!.value).toBe("owner");
    expect(dialog().querySelector(".dialog-body")!.lastElementChild?.className).toBe("comment-compose-reviewer");
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Comment");
    let editor = dialog().querySelector<HTMLTextAreaElement>(".comment-compose-edit-fields textarea")!;
    await act(async () => change(editor, "The method can outperform existing approaches."));
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Comment + suggested edit · Review requested");
    expect(dialog().querySelector(".suggestion-diff del")?.textContent).toContain("outperforms");
    await click('[role="switch"]'); expect(dialog().querySelector(".comment-compose-edit-fields")).toBeNull();
    expect(dialog().querySelector("select")).toBeNull();
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Comment");
    await click('[role="switch"]'); editor = dialog().querySelector<HTMLTextAreaElement>(".comment-compose-edit-fields textarea")!;
    expect(editor.value).toBe("The method can outperform existing approaches.");
    expect(dialog().querySelector<HTMLSelectElement>("select")!.value).toBe("owner");
  });

  it("supports an edit without a handwritten note and keeps all controls locked during submission", async () => {
    await render(); await click('[role="switch"]');
    await act(async () => change(dialog().querySelector(".comment-compose-edit-fields textarea")!, ""));
    expect(dialog().querySelector(".comment-compose-status")?.textContent).toBe("Suggested edit · Review requested");
    await render(true);
    expect(dialog().querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true);
    expect([...dialog().querySelectorAll("textarea")].every((node) => node.disabled)).toBe(true);
    expect(dialog().querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
    await click(".comment-compose-actions .primary"); expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("comment payload classification", () => {
  it("drops an unchanged replacement and only requires a reviewer for actual edits", () => {
    expect(commentSubmission("Note", original, null, "author")).toMatchObject({ edit: null, issue: null, kind: "commentOnly" });
    expect(commentSubmission("Note", original, { replacementText: original, reviewerId: "author" }, "author")).toMatchObject({ edit: null, issue: null, kind: "commentOnly" });
    expect(commentSubmission("", original, { replacementText: "New", reviewerId: "" })).toMatchObject({ issue: "reviewer", kind: "editOnly" });
    expect(commentSubmission("", original, { replacementText: "", reviewerId: "owner" }, "author")).toMatchObject({ issue: null, edit: { replacementText: "" } });
    expect(commentSubmission("", original, { replacementText: "New", reviewerId: "author" }, "author")).toMatchObject({ issue: "selfReview" });
  });
});
