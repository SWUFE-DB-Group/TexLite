// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import type { Comment } from "../src/client/types";
import { useProjectComments } from "../src/client/workspace/useProjectComments";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

let root: Root, host: HTMLDivElement;
let comments: ReturnType<typeof useProjectComments>;
let activeFile: string, sourceOrderRevision: string;
function Harness() {
  comments = useProjectComments({
    projectId: "project", activeFile, sourceOrderRevision, content: "", permission: "owner", revision: "comments-1",
    selection: { startOffset: 0, endOffset: 0, selectedText: "" },
    save: async () => true, saveFailureMessage: "Save failed", onError: vi.fn(), onAdded: vi.fn()
  });
  return null;
}
async function render() { await act(async () => root.render(createElement(Harness))); }
function note(id: string, sourceOrder: number): Comment {
  return { id, filePath: "child.tex", sourceOrder, authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1, content: id,
    resolved: false, orphaned: false, resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null,
    resolvedAt: null, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", editedAt: null, replies: [] };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ comments: [] });
  activeFile = "main.tex"; sourceOrderRevision = "main.tex:tree-1";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render(); vi.mocked(api).mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

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
