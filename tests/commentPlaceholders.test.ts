import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionTextarea } from "../src/client/workspace/MentionTextarea";
import i18n from "../src/client/i18n";

describe("comment composer placeholders", () => {
  it.each([
    ["en", "commentPlaceholder"], ["zh", "commentPlaceholder"],
    ["en", "replyPlaceholder"], ["zh", "replyPlaceholder"]
  ])("includes the submission shortcut inside the %s %s placeholder", (lng, key) => {
    const placeholder = i18n.t(`editor.${key}`, { lng });
    expect(placeholder).toContain("⌘/Ctrl+Enter");
    expect(placeholder).toContain(lng === "en" ? "to send" : "发送");
    const html = renderToStaticMarkup(createElement(MentionTextarea, {
      projectId: "project", value: "", onChange: () => {}, placeholder
    }));
    expect(html).toContain(`placeholder="${placeholder}"`);
    expect(html).not.toContain("comment-submit-hint");
  });
});
