// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import type { Comment } from "../src/client/types";
import { useProjectComments } from "../src/client/workspace/useProjectComments";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

let root: Root, host: HTMLDivElement;
let comments: ReturnType<typeof useProjectComments>;
let activeFile: string, sourceOrderRevision: string, projectId: string, revision: string;
const onError = vi.fn();
let client = discussionTestClient();
function Harness() {
  comments = useProjectComments({
    projectId, activeFile, sourceOrderRevision, content: "", permission: "owner", revision,
    selection: { startOffset: 0, endOffset: 0, selectedText: "" },
    save: async () => true, saveFailureMessage: "Save failed", onError, onAdded: vi.fn()
  });
  return null;
}
async function render() { await act(async () => root.render(withDiscussionQueries(createElement(Harness), client))); }
function note(id: string, sourceOrder: number): Comment {
  return { id, filePath: "child.tex", sourceOrder, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1, content: id,
    resolved: false, orphaned: false, resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null,
    resolvedAt: null, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", editedAt: null, replies: [] };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ comments: [] });
  activeFile = "main.tex"; sourceOrderRevision = "main.tex:tree-1"; projectId = "project"; revision = "comments-1";
  client = discussionTestClient(); onError.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render(); vi.mocked(api).mockClear();
});

describe("confirmed comment cache updates", () => {
  const summary = { totalCount: 1, unresolvedCount: 0, filePaths: ["child.tex"] };
  function acknowledgement(resolved = true) {
    const resolution = { id: "first", filePath: "child.tex", resolved,
      resolvedById: resolved ? "reader" : null, resolvedByUsername: resolved ? "reader" : null,
      resolvedByDisplayName: resolved ? "Reader" : null, resolvedAt: resolved ? "2026-10-22T01:00:00Z" : null,
      updatedAt: "2026-10-22T01:00:00Z" };
    return { resolution, change: { kind: "resolved", resolution }, summary: { ...summary, unresolvedCount: resolved ? 0 : 1 } };
  }
  async function seed() {
    activeFile = "child.tex";
    vi.mocked(api).mockResolvedValue({ comments: [note("first", 3)] });
    await render();
    await act(async () => comments.setCommentScope("project"));
    vi.mocked(api).mockClear();
  }

  it("applies resolve and reopen to both caches even if reconciliation fails", async () => {
    await seed();
    for (const resolved of [true, false]) {
      const ack = acknowledgement(resolved);
      vi.mocked(api).mockImplementation(async (_url, options) => {
        if (options?.method === "PATCH") return ack;
        throw new ApiError("Refresh failed", 503);
      });
      await act(async () => comments.toggleComment(comments.reviewComments[0]));
      expect(comments.comments[0]).toMatchObject({ ...ack.resolution, sourceOrder: 3, startOffset: 0, endOffset: 6 });
      expect(comments.reviewComments[0]).toEqual(comments.comments[0]);
      expect(comments.projectCommentSummary).toEqual(ack.summary);
      expect(comments.fileCommentsError).toBe("Refresh failed");
      expect(comments.reviewCommentsError).toBe("Refresh failed");
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores pre-mutation reads even when they finish after the acknowledgement", async () => {
    await seed();
    const pending: Array<(result: { comments: Comment[] }) => void> = [];
    const signals: AbortSignal[] = [];
    vi.mocked(api).mockImplementation((_url, options) => {
      signals.push(options!.signal as AbortSignal);
      return new Promise((resolve) => pending.push(resolve));
    });
    let refresh!: Promise<void>;
    await act(async () => { refresh = comments.retryReviewComments(); });
    expect(pending).toHaveLength(2);
    vi.mocked(api).mockImplementation(async (_url, options) => {
      if (options?.method === "PATCH") return acknowledgement();
      throw new Error("Offline");
    });
    await act(async () => comments.toggleComment(comments.comments[0]));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      pending.forEach((finish) => finish({ comments: [note("first", 0)] }));
      await refresh;
    });
    expect(comments.comments[0].resolved).toBe(true);
    expect(comments.reviewComments[0].resolved).toBe(true);
    expect(comments.projectCommentSummary).toEqual(summary);
  });

  it("retries both the file and project resources and refreshes on remote revisions", async () => {
    await seed();
    const updated = { ...note("first", 0), ...acknowledgement().resolution };
    vi.mocked(api).mockResolvedValue({ comments: [updated] });
    await act(async () => comments.retryReviewComments());
    expect(api).toHaveBeenCalledWith("/api/projects/project/comments?path=child.tex", expect.any(Object));
    expect(api).toHaveBeenCalledWith("/api/projects/project/comments?scope=project", expect.any(Object));
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValue({ comments: [note("first", 0), note("remote", 1)] });
    revision = "remote-comment-added";
    await render();
    expect(api).toHaveBeenCalledTimes(2);
    expect(comments.comments.map((item) => item.id)).toEqual(["first", "remote"]);
    expect(comments.reviewComments).toEqual(comments.comments);
  });

  it("does not alter caches when the mutation fails", async () => {
    await seed();
    vi.mocked(api).mockRejectedValue(new Error("Permission denied"));
    await act(async () => comments.toggleComment(comments.comments[0]));
    expect(comments.comments[0].resolved).toBe(false);
    expect(comments.reviewComments[0].resolved).toBe(false);
    expect(onError).toHaveBeenCalledWith("Permission denied");
  });

  it("retains both lists on transient read errors but hides them on explicit access rejection", async () => {
    await seed();
    vi.mocked(api).mockRejectedValue(new ApiError("Temporary", 503));
    await act(async () => comments.retryReviewComments());
    expect(comments.comments).toHaveLength(1);
    expect(comments.reviewComments).toHaveLength(1);
    expect(comments.commentsReady).toBe(false);
    vi.mocked(api).mockRejectedValue(new ApiError("Forbidden", 403));
    await act(async () => comments.retryReviewComments());
    expect(comments.comments).toEqual([]);
    expect(comments.reviewComments).toEqual([]);
    expect(comments.projectCommentSummary).toBeNull();
  });

  it("never decorates a newly selected file with another file's cached comments after a failed load", async () => {
    await seed();
    vi.mocked(api).mockRejectedValue(new Error("Offline"));
    activeFile = "another.tex";
    await render();
    expect(comments.comments).toEqual([]);
    expect(comments.commentsFilePath).toBe("another.tex");
    expect(comments.fileCommentsError).toBe("Offline");
    expect(comments.commentsReady).toBe(false);
    expect(comments.reviewComments[0].filePath).toBe("child.tex");
  });

  it("ignores an acknowledgement from a project that has been left", async () => {
    await seed();
    let finish!: (value: ReturnType<typeof acknowledgement>) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let mutation!: Promise<void>;
    await act(async () => { mutation = comments.toggleComment(comments.comments[0]); });
    vi.mocked(api).mockResolvedValue({ comments: [] });
    projectId = "other";
    await render();
    await act(async () => { finish(acknowledgement()); await mutation; });
    expect(comments.comments).toEqual([]);
    expect(comments.projectCommentSummary).toBeNull();
  });

  it("shows a confirmed reply and clears its draft even if subsequent reads fail", async () => {
    await seed();
    const reply = { id: "reply", authorId: "reader", authorUsername: "reader", authorDisplayName: "Reader", content: "My reply",
      createdAt: "2026-10-22T02:00:00Z", updatedAt: "2026-10-22T02:00:00Z", editedAt: null };
    vi.mocked(api).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") return { change: { kind: "reply-saved", commentId: "first", filePath: "child.tex", reply }, summary: { ...summary, unresolvedCount: 1 } };
      throw new ApiError("Refresh failed", 503);
    });
    const store = comments.commentDraftStore;
    store.open("first", "reply", "My reply");
    await act(async () => expect(await store.submit("first", "reply", (value) => comments.replyToComment(comments.comments[0], value), "Failed")).toBe(true));
    expect(comments.comments[0].replies).toEqual([reply]);
    expect(comments.reviewComments[0].replies).toEqual([reply]);
    expect(store.getThread("first").reply).toBeUndefined();
    expect(comments.reviewCommentsError).toBe("Refresh failed");
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("keeps a rejected reply draft and never retries the write automatically", async () => {
    await seed();
    vi.mocked(api).mockRejectedValue(new ApiError("Try again later", 503));
    const store = comments.commentDraftStore;
    store.open("first", "reply", "Unsent reply");
    await act(async () => expect(await store.submit("first", "reply", (value) => comments.replyToComment(comments.comments[0], value), "Failed")).toBe(false));
    expect(store.getThread("first").reply).toMatchObject({ content: "Unsent reply", pending: false, error: "Try again later" });
    expect(comments.comments[0].replies).toEqual([]);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("adds a confirmed new comment to the file and project before clearing the composer", async () => {
    await seed();
    const created = { ...note("new", 4), content: "New comment" };
    vi.mocked(api).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") return { change: { kind: "created", comment: created }, summary: { ...summary, totalCount: 2, unresolvedCount: 2 } };
      throw new Error("Offline");
    });
    await act(async () => comments.openComment());
    await act(async () => comments.setCommentText("New comment"));
    await act(async () => comments.addComment());
    expect(comments.comments.map((item) => item.id)).toEqual(["first", "new"]);
    expect(comments.reviewComments).toEqual(comments.comments);
    expect(comments.commentOpen).toBe(false);
    expect(comments.commentText).toBe("");
    expect(comments.commentDraftStore.getNew("child.tex")).toBeUndefined();
    expect(comments.projectCommentSummary?.totalCount).toBe(2);
  });

  it("edits and deletes confirmed records in both lists despite failed reconciliation", async () => {
    await seed();
    vi.mocked(api).mockImplementation(async (_url, options) => {
      if (options?.method === "PATCH") return { change: { kind: "edited", comment: { id: "first", filePath: "child.tex", content: "Edited", updatedAt: "later", editedAt: "later" } }, summary };
      if (options?.method === "DELETE") return { change: { kind: "deleted", commentId: "first", filePath: "child.tex" }, summary: { totalCount: 0, unresolvedCount: 0, filePaths: [] } };
      throw new Error("Offline");
    });
    await act(async () => comments.editComment(comments.comments[0], "Edited"));
    expect(comments.comments[0]).toMatchObject({ content: "Edited", startOffset: 0, endOffset: 6, sourceOrder: 3 });
    expect(comments.reviewComments[0].content).toBe("Edited");
    await act(async () => comments.deleteComment(comments.comments[0]));
    expect(comments.comments).toEqual([]);
    expect(comments.reviewComments).toEqual([]);
    expect(comments.projectCommentSummary?.totalCount).toBe(0);
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe("project comment reading-order refresh", () => {
  it("does not load project discussions for source-order changes while only reviewing the current file", async () => {
    sourceOrderRevision = "alternate.tex:tree-2";
    await render();
    expect(api).not.toHaveBeenCalled();
    await act(async () => comments.setCommentScope("project"));
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/project/comments?scope=project", expect.any(Object));
  });

  it("does not refetch or reorder the project resource when another editor file is selected", async () => {
    vi.mocked(api).mockResolvedValueOnce({ comments: [note("first", 0), note("second", 1)] });
    await act(async () => comments.setCommentScope("project"));
    vi.mocked(api).mockClear();
    activeFile = "child.tex";
    await render();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/project/comments?path=child.tex", expect.any(Object));
    expect(comments.reviewComments.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("reloads after root/tree changes and ignores the obsolete request's source ranks", async () => {
    let finishOld!: (result: { comments: Comment[] }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await act(async () => comments.setCommentScope("project"));
    const oldSignal = vi.mocked(api).mock.calls[0][1]?.signal;
    vi.mocked(api).mockResolvedValueOnce({ comments: [note("second", 0), note("first", 1)] });
    sourceOrderRevision = "alternate.tex:tree-2";
    await render();
    expect(oldSignal?.aborted).toBe(true);
    expect(comments.reviewComments.map(({ id }) => id)).toEqual(["second", "first"]);
    await act(async () => finishOld({ comments: [note("first", 0), note("second", 1)] }));
    expect(comments.reviewComments.map(({ id }) => id)).toEqual(["second", "first"]);
    expect(comments.reviewCommentsLoading).toBe(false);
    expect(comments.reviewCommentsError).toBe("");
  });
});
