import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel, PanelGroup } from "react-resizable-panels";
import { describe, expect, it } from "vitest";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import i18n from "../src/client/i18n";
import type { Comment, Project, SiteConfig } from "../src/client/types";
import { CommentDraftStore } from "../src/client/workspace/commentDrafts";
import { WorkspaceContextPanel, type WorkspaceContextPanelProps } from "../src/client/workspace/WorkspaceContextPanel";

function comment(id: string, filePath = "main.tex", resolved = false): Comment {
  return {
    id, filePath, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1,
    content: `Comment ${id}`, resolved, orphaned: false, resolvedById: null,
    resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", editedAt: null, replies: []
  };
}

function render(overrides: Partial<WorkspaceContextPanelProps> = {}) {
  const props: WorkspaceContextPanelProps = {
    sidePanel: "comments", onClose: () => {}, project: {} as Project, projectId: "project", site: {} as SiteConfig,
    files: [], currentUserId: "author", comments: [comment("first"), comment("second"), comment("chapter", "intro.tex")],
    commentDraftStore: new CommentDraftStore(), commentsLoading: false, commentsError: "", onRetryComments: async () => {},
    activeFile: "main.tex", hasProjectCommentsScope: true, commentScope: "file", onCommentScopeChange: () => {},
    onShowAllComments: () => {}, onClearFocusComment: () => {}, unreadMentions: [],
    onMarkMentionRead: async () => true, onMarkAllMentionsRead: async () => true,
    onFocusComment: () => {}, onToggleComment: async () => {}, onReplyComment: async () => true,
    onEditComment: async () => true, onDeleteComment: async () => true, onEditCommentReply: async () => true,
    onDeleteCommentReply: async () => true, dictionaryWords: [], onDictionaryChange: () => {},
    editorPreferences: defaultEditorPreferences, onEditorPreferences: () => {}, spellCheckCount: null,
    spellCheckUniqueCount: null, spellCheckIndex: -1, onSpellCheckNavigate: () => {}, onProject: () => {}, ...overrides
  };
  return renderToStaticMarkup(createElement(PanelGroup, { direction: "horizontal" },
    createElement(Panel, { defaultSize: 80 }, "Editor"), createElement(WorkspaceContextPanel, props)));
}

describe("comment drawer modes", () => {
  it("shows the full review controls by default", () => {
    const html = render();
    expect(html).toContain('data-comment-id="first"');
    expect(html).toContain('data-comment-id="second"');
    expect(html).not.toContain('data-comment-id="chapter"');
    expect(html).toContain('class="comment-review-controls"');
    expect(html).toContain('class="comment-review-sort"');
    expect(html).not.toContain('class="comment-current-controls"');
  });

  it("shows just the requested Open discussion and highlights it without review controls", () => {
    const html = render({ singleCommentId: "second", commentScope: "project" });
    expect(html).toContain('data-comment-id="second" class="comment-thread review-current"');
    expect(html).not.toContain('data-comment-id="first"');
    expect(html).not.toContain('data-comment-id="chapter"');
    expect(html).toContain(i18n.t("editor.currentComment"));
    expect(html).toContain(i18n.t("editor.viewAllComments"));
    expect(html).not.toContain('class="comment-review-controls"');
    expect(html).not.toContain('class="comment-review-navigation"');
    expect(html).not.toContain('class="comment-review-sort"');
    expect(html).not.toContain('class="comment-participant-filter"');
    expect(html).not.toContain('class="comment-unread-toggle');
    expect(html).not.toContain('class="drawer-mention-read-all"');
  });

  it("restores a reply draft in either view without duplicating it", () => {
    const commentDraftStore = new CommentDraftStore();
    commentDraftStore.open("second", "reply", "Unsent reply");
    for (const singleCommentId of ["second", null]) {
      const html = render({ singleCommentId, commentDraftStore, focusedCommentId: "second" });
      expect(html.match(/Unsent reply<\/textarea>/g)).toHaveLength(1);
      expect(html).toContain('data-comment-id="second" class="comment-thread review-current"');
    }
  });

  it("shows an empty current view after resolution or deletion without falling back to another comment", () => {
    const resolved = render({ singleCommentId: "first", comments: [comment("first", "main.tex", true), comment("second")] });
    expect(resolved).toContain(i18n.t("editor.currentCommentResolved"));
    expect(resolved).not.toContain('data-comment-id=');
    const deleted = render({ singleCommentId: "missing" });
    expect(deleted).toContain(i18n.t("editor.currentCommentUnavailable"));
    expect(deleted).not.toContain('data-comment-id=');
    expect(deleted).toContain(i18n.t("editor.viewAllComments"));
  });

  it("does not report a missing discussion while its resource is loading", () => {
    const html = render({ singleCommentId: "first", comments: [], commentsLoading: true });
    expect(html).toContain('class="comment-review-loading"');
    expect(html).not.toContain(i18n.t("editor.currentCommentUnavailable"));
  });

  it("keeps a cached current discussion and draft visible beside the load error and retry action", () => {
    const commentDraftStore = new CommentDraftStore();
    commentDraftStore.open("first", "reply", "Reply retained after refresh failure");
    const html = render({ singleCommentId: "first", commentsError: "Could not refresh comments", commentDraftStore });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not refresh comments");
    expect(html).toContain(i18n.t("common.retry"));
    expect(html).toContain('data-comment-id="first"');
    expect(html).toContain("Reply retained after refresh failure</textarea>");
    expect(html).not.toContain(i18n.t("editor.currentCommentUnavailable"));
    expect(html).not.toContain('class="comment-review-loading"');
  });

  it("does not interpret an initial load failure as a deleted discussion", () => {
    const html = render({ singleCommentId: "first", comments: [], commentsError: "Could not load comments" });
    expect(html).toContain('role="alert"');
    expect(html).toContain(i18n.t("common.retry"));
    expect(html).not.toContain(i18n.t("editor.currentCommentUnavailable"));
    expect(html).not.toContain(i18n.t("editor.currentCommentResolved"));
  });
});
