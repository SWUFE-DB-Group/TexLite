// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentForm } from "../src/client/workspace/CommentForm";
import { CommentActionsMenu } from "../src/client/workspace/CommentActionsMenu";
import i18n from "../src/client/i18n";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";

let host: HTMLDivElement;
let root: Root;
let client: ReturnType<typeof discussionTestClient>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  client = discussionTestClient();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<ComponentProps<typeof CommentForm>> = {}) {
  await act(async () => root.render(withDiscussionQueries(createElement(CommentForm, {
    projectId: "project", value: "Draft text", onChange: () => {}, onSubmit: async () => true,
    onCancel: () => {}, label: "Reply", ...props
  }), client)));
  const form = host.querySelector("form")!;
  return {
    form, editor: form.querySelector("textarea")!,
    cancel: form.querySelector<HTMLButtonElement>('button[type="button"]')!,
    submit: form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  };
}

describe("comment submission forms", () => {
  it("renders an accessible reply composer with the existing shortcut placeholder", async () => {
    const { form, editor, cancel, submit } = await render();
    expect(form.getAttribute("aria-busy")).toBe("false");
    expect(editor.getAttribute("aria-label")).toBe("Reply");
    expect(editor.placeholder).toBe(i18n.t("editor.replyPlaceholder"));
    expect(editor.value).toBe("Draft text");
    expect(submit.textContent).toBe(i18n.t("editor.sendReply"));
    expect(editor.disabled).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(form.querySelector('[role="alert"]')).toBeNull();
  });

  it("uses save controls for comment and reply edits", async () => {
    const { editor, submit } = await render({ editing: true, label: "Edit comment" });
    expect(editor.getAttribute("aria-label")).toBe("Edit comment");
    expect(editor.hasAttribute("placeholder")).toBe(false);
    expect(submit.textContent).toBe(i18n.t("editor.saveChanges"));
  });

  it.each([false, true])("disables the editor, cancel and submit while a related request is pending (editing=%s)", async (editing) => {
    const onSubmit = vi.fn(async () => true);
    const { form, editor, cancel, submit } = await render({ editing, disabled: true, onSubmit });
    expect(editor.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(editor.value).toBe("Draft text");
    // A different form's request must not show this form as the submitting one.
    expect(form.getAttribute("aria-busy")).toBe("false");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("restores pending feedback and inline errors supplied by the workspace", async () => {
    const pending = await render({ pending: true });
    expect(pending.form.getAttribute("aria-busy")).toBe("true");
    expect(pending.submit.textContent).toBe(i18n.t("editor.commentSending"));
    expect(pending.editor.disabled).toBe(true);
    expect(pending.cancel.disabled).toBe(true);
    expect(pending.submit.disabled).toBe(true);
    const failed = await render({ error: "Please retry" });
    const error = failed.form.querySelector<HTMLElement>('[role="alert"]')!;
    expect(error.textContent).toBe("Please retry");
    expect(failed.editor.getAttribute("aria-invalid")).toBe("true");
    expect(failed.editor.getAttribute("aria-describedby")).toBe(error.id);
    expect(failed.editor.value).toBe("Draft text");
    expect(failed.editor.disabled).toBe(false);
    expect(failed.submit.disabled).toBe(false);
  });

  it.each(["", " \n\t "])("rejects empty/whitespace drafts in the submit controls: %j", async (value) => {
    const onSubmit = vi.fn(async () => true);
    const { form, editor, cancel, submit } = await render({ value, onSubmit });
    expect(submit.disabled).toBe(true);
    expect(cancel.disabled).toBe(false);
    expect(editor.disabled).toBe(false);
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([false, true])("wires submit and cancel actions for editing=%s", async (editing) => {
    const onSubmit = vi.fn(async () => true), onCancel = vi.fn();
    const { submit, cancel } = await render({ editing, onSubmit, onCancel });
    await act(async () => submit.click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each(["comment", "reply"] as const)("disables the %s actions menu while submitting", async (kind) => {
    await act(async () => root.render(createElement(CommentActionsMenu, {
      kind, disabled: true, onEdit: vi.fn(), onDelete: vi.fn()
    })));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe(i18n.t(kind === "comment" ? "editor.commentActions" : "editor.replyActions"));
    await act(async () => trigger.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
