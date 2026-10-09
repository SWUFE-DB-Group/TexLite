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
    ], selectedIds: new Set<string | null>(), topLevelOnly: false,
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
  });

  it("summarizes selected names, offers a distinct clear action, and exposes the root-only restriction", () => {
    const single = render({ selectedIds: new Set(["a"]) });
    expect(single).toContain('class="comment-participants-summary">Alice</span>');
    expect(single).toContain('aria-label="' + i18n.t("editor.commentParticipantsClear") + '"');
    const multiple = render({ selectedIds: new Set(["a", "b"]), topLevelOnly: true });
    expect(multiple).toContain(i18n.t("editor.commentParticipantsSelected", { name: "Alice", count: 1 }));
    expect(multiple).toContain('class="comment-participants-scope">' + i18n.t("editor.commentTopLevelOnly"));
  });

  it("keeps absent selected authors clearable and deleted authors identifiable", () => {
    expect(render({ selectedIds: new Set(["missing"]) })).toContain(i18n.t("editor.commentParticipantsCount", { count: 1 }));
    expect(render({ participants: [{ authorId: null, authorUsername: null, authorDisplayName: null }], selectedIds: new Set([null]) }))
      .toContain(i18n.t("editor.deletedUser"));
  });
});
