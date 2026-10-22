// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment, ProjectCommentSummary } from "../src/client/types";
import { useProjectComments } from "../src/client/workspace/useProjectComments";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", async (original) => ({ ...await original<object>(), api: apiMock }));

const summary: ProjectCommentSummary = { totalCount: 3, unresolvedCount: 3, filePaths: ["custom.bib", "main.tex"] };
function comment(id: string, filePath = "main.tex"): Comment {
  return { id, filePath, resolved: false, replies: [] } as unknown as Comment;
}
const mainComments = [comment("main-1"), comment("main-2")];
const bibComment = comment("bib-1", "custom.bib");
let root: Root, host: HTMLDivElement;
let client = discussionTestClient();
let activeFile: string, projectId: string, revision: string;
let resource: ReturnType<typeof useProjectComments>;
function Probe() {
  resource = useProjectComments({ projectId, activeFile, revision, content: "", permission: "edit",
    selection: { selectedText: "", startOffset: 0, endOffset: 0 },
    save: async () => true, saveFailureMessage: "Save failed", onError: vi.fn(), onAdded: vi.fn() });
  return null;
}
const render = () => act(async () => root.render(withDiscussionQueries(createElement(Probe), client)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  apiMock.mockReset();
  client = discussionTestClient();
  apiMock.mockImplementation(async (url: string) => ({ summary,
    comments: url.includes("scope=project") ? [...mainComments, bibComment]
      : url.includes("path=custom.bib") ? [bibComment] : mainComments }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  activeFile = "main.tex"; projectId = "project"; revision = "1";
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe("project-wide comment totals", () => {
  it("loads project counts with file comments without eagerly downloading other discussions", async () => {
    await render();
    expect(resource.comments).toEqual(mainComments);
    expect(resource.projectCommentSummary).toEqual(summary);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toContain("path=main.tex");
    await act(async () => resource.setCommentScope("project"));
    expect(resource.reviewComments).toHaveLength(3);
    expect(resource.comments).toEqual(mainComments);
    expect(resource.projectCommentSummary?.unresolvedCount).toBe(3);
  });

  it("keeps the project count when switching files, including a file with no discussions", async () => {
    await render();
    activeFile = "custom.bib"; await render();
    expect(resource.comments).toEqual([bibComment]);
    expect(resource.projectCommentSummary).toEqual(summary);
    activeFile = "empty.tex";
    apiMock.mockResolvedValueOnce({ comments: [], summary }); await render();
    expect(resource.comments).toEqual([]);
    expect(resource.projectCommentSummary?.unresolvedCount).toBe(3);
  });

  it("refreshes totals after resolving a discussion in another file", async () => {
    await render(); await act(async () => resource.setCommentScope("project"));
    apiMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const updatedSummary = { ...summary, unresolvedCount: 2 };
      if (options?.method === "PATCH") return { ok: true,
        change: { kind: "resolved", resolution: { id: bibComment.id, filePath: bibComment.filePath, resolved: true, resolvedById: "reader",
          resolvedByUsername: "reader", resolvedByDisplayName: "Reader", resolvedAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" } },
        summary: updatedSummary };
      return { comments: url.includes("scope=project") ? [...mainComments, { ...bibComment, resolved: true }] : mainComments,
        summary: updatedSummary };
    });
    await act(async () => resource.toggleComment(bibComment));
    expect(resource.projectCommentSummary?.unresolvedCount).toBe(2);
    expect(resource.comments).toEqual(mainComments);
    expect(resource.reviewComments.find((item) => item.id === bibComment.id)?.resolved).toBe(true);
  });

  it("ignores a late file response's summary after a newer project refresh", async () => {
    let complete!: (value: { comments: Comment[]; summary: ProjectCommentSummary }) => void;
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await render();
    apiMock.mockResolvedValueOnce({ comments: mainComments, summary: { ...summary, unresolvedCount: 2 } });
    await act(async () => resource.setCommentScope("project"));
    await act(async () => complete({ comments: mainComments, summary }));
    expect(resource.comments).toEqual(mainComments);
    expect(resource.projectCommentSummary?.unresolvedCount).toBe(2);
  });

  it("clears project totals on a project switch and rejects the old request", async () => {
    await render();
    let complete!: (value: { comments: Comment[]; summary: ProjectCommentSummary }) => void;
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    revision = "2"; await render();
    projectId = "other-project";
    apiMock.mockResolvedValueOnce({ comments: [], summary: { totalCount: 0, unresolvedCount: 0, filePaths: [] } });
    await render();
    await act(async () => complete({ comments: mainComments, summary }));
    expect(resource.comments).toEqual([]);
    expect(resource.projectCommentSummary).toEqual({ totalCount: 0, unresolvedCount: 0, filePaths: [] });
  });
});
