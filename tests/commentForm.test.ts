import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentForm } from "../src/client/workspace/CommentForm";
import { CommentActionsMenu } from "../src/client/workspace/CommentActionsMenu";
import i18n from "../src/client/i18n";

function render(props: Partial<ComponentProps<typeof CommentForm>> = {}): string {
  return renderToStaticMarkup(createElement(CommentForm, {
    projectId: "project", value: "Draft text", onChange: () => {}, onSubmit: async () => true,
    onCancel: () => {}, label: "Reply", ...props
  }));
}

describe("comment submission forms", () => {
  it("renders an accessible reply composer with the existing shortcut placeholder", () => {
    const html = render();
    expect(html).toContain('class="comment-reply-form" aria-busy="false"');
    expect(html).toContain('aria-label="Reply"');
    expect(html).toContain('placeholder="' + i18n.t("editor.replyPlaceholder") + '"');
    expect(html).toContain(i18n.t("editor.sendReply"));
    expect(html).toContain("Draft text</textarea>");
    expect(html).not.toContain('role="alert"');
  });

  it("uses save controls for comment and reply edits", () => {
    const html = render({ editing: true, label: "Edit comment" });
    expect(html).toContain('class="comment-reply-form comment-edit-form"');
    expect(html).toContain('aria-label="Edit comment"');
    expect(html).toContain(i18n.t("editor.saveChanges"));
    expect(html).not.toContain(i18n.t("editor.sendReply"));
  });

  it.each([false, true])("disables the editor, cancel and submit while a related request is pending (editing=%s)", (editing) => {
    const html = render({ editing, disabled: true });
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Draft text</textarea>");
    // A different form's request must not show this form as the submitting one.
    expect(html).toContain('aria-busy="false"');
  });

  it("restores pending feedback and inline errors supplied by the workspace", () => {
    const pending = render({ pending: true });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain(i18n.t("editor.commentSending"));
    expect(pending.match(/disabled=""/g)).toHaveLength(3);
    const failed = render({ error: "Please retry" });
    expect(failed).toContain('class="comment-form-error" role="alert">Please retry</p>');
    expect(failed).toContain('aria-invalid="true"');
    expect(failed).toContain("Draft text</textarea>");
  });

  it.each(["", " \n\t "])("rejects empty/whitespace drafts in the submit controls: %j", (value) => {
    const html = render({ value });
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toContain('type="button" disabled=""');
  });

  it.each(["comment", "reply"] as const)("disables the %s actions menu while submitting", (kind) => {
    const html = renderToStaticMarkup(createElement(CommentActionsMenu, {
      kind, disabled: true, onEdit: () => {}, onDelete: () => {}
    }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
