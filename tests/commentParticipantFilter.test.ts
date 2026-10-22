import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentParticipantFilter } from "../src/client/workspace/CommentParticipantFilter.js";
import i18n from "../src/client/i18n.js";

function render(props: Partial<ComponentProps<typeof CommentParticipantFilter>> = {}): string {
  return renderToStaticMarkup(createElement(CommentParticipantFilter, {
    participants: [
      { authorId: "a", authorUsername: "alice", authorDisplayName: "Alice" },
      { authorId: "b", authorUsername: "bob", authorDisplayName: "Bob" }
    ], selectedIds: new Set<string | null>(), topLevelOnly: true,
    onToggle: () => {}, onClear: () => {}, onTopLevelOnlyChange: () => {}, ...props
  }));
}

describe("comment participant selector", () => {
  it("shows an unfiltered default and keeps the list out of the closed toolbar", () => {
    const html = render();
    expect(html).toContain(i18n.t("editor.commentParticipantsAll"));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("comment-participants-list");
    expect(html).not.toContain("comment-participants-clear");
    expect(html).not.toContain("comment-participants-scope");
    expect(html).not.toContain("data-tooltip=");
  });

  it("summarizes selected names without repeating the root-only option outside the dropdown", () => {
    const single = render({ selectedIds: new Set(["a"]) });
    expect(single).toContain('class="comment-participants-summary">Alice</span>');
    expect(single).toContain('aria-label="' + i18n.t("editor.commentParticipantsClear") + '"');
    expect(single).toContain(`aria-label="${i18n.t("editor.commentParticipants")}: Alice"`);
    expect(single).not.toContain("data-tooltip=");
    expect(single).not.toContain("title=");
    expect(single).not.toContain(i18n.t("editor.commentTopLevelOnly"));
    expect(single).not.toContain("comment-participants-scope");
    expect(single).not.toContain("data-texlite-tooltip-always");
    const multiple = render({ selectedIds: new Set(["a", "b"]), topLevelOnly: true });
    expect(multiple).toContain(i18n.t("editor.commentParticipantsSelected", { name: "Alice", count: 1 }));
    expect(multiple).not.toContain("data-tooltip=");
    expect(multiple).not.toContain(i18n.t("editor.commentTopLevelOnly"));
    expect(multiple).not.toContain("comment-participants-scope");
  });

  it("hides the root-only restriction when reply authors are explicitly included", () => {
    const html = render({ selectedIds: new Set(["a"]), topLevelOnly: false });
    expect(html).toContain('class="comment-participants-summary">Alice</span>');
    expect(html).not.toContain("comment-participants-scope");
    expect(html).not.toContain("data-tooltip=");
    expect(html).not.toContain(i18n.t("editor.commentTopLevelOnly"));
  });

  it("keeps absent selected authors clearable and deleted authors identifiable", () => {
    expect(render({ selectedIds: new Set(["missing"]) })).toContain(i18n.t("editor.commentParticipantsCount", { count: 1 }));
    expect(render({ participants: [{ authorId: null, authorUsername: null, authorDisplayName: null }], selectedIds: new Set([null]) }))
      .toContain(i18n.t("editor.deletedUser"));
  });
});
