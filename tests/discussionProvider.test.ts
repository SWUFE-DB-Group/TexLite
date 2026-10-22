// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { DiscussionQueryProvider } from "../src/client/workspace/DiscussionQueryProvider";
import { useProjectComments } from "../src/client/workspace/useProjectComments";
import { useProjectMentions } from "../src/client/workspace/useProjectMentions";
import "./discussionTestUtils";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let root: Root, host: HTMLDivElement, client: QueryClient;
let comments: ReturnType<typeof useProjectComments>, mentions: ReturnType<typeof useProjectMentions>;
function Harness() {
  client = useQueryClient();
  comments = useProjectComments({ projectId: "project", activeFile: "main.tex", content: "", permission: "read", revision: "revision",
    selection: { startOffset: 0, endOffset: 0, selectedText: "" }, save: async () => true, saveFailureMessage: "Failed", onError: vi.fn(), onAdded: vi.fn() });
  mentions = useProjectMentions("project", "revision", vi.fn());
  return null;
}
async function render(user = "reader") {
  await act(async () => root.render(createElement(StrictMode, null,
    createElement(DiscussionQueryProvider, { key: `${user}:project`, children: createElement(Harness) }))));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (url) => url.includes("/mentions") ? { mentions: [] }
    : { comments: [], summary: { totalCount: 0, unresolvedCount: 0, filePaths: [] } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe("workspace-scoped discussion provider", () => {
  it("finishes reads and accepts later writes under StrictMode's setup/cleanup cycle", async () => {
    await render();
    expect(comments.commentsReady).toBe(true);
    expect(comments.fileCommentsError).toBe("");
    expect(mentions.mentionsError).toBe("");
    vi.mocked(api).mockResolvedValueOnce({ changed: true });
    await act(async () => expect(await mentions.markMentionRead("notice")).toBe(true));
    expect(mentions.mentionsError).toBe("");
    expect(comments.projectCommentSummary?.totalCount).toBe(0);
  });

  it("replaces the cache when the account changes and discards the old user's pending reads", async () => {
    const oldRequests: Array<(value: unknown) => void> = [];
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { oldRequests.push(resolve); }));
    await render();
    const oldClient = client;
    const oldSignals = vi.mocked(api).mock.calls.map(([, options]) => options?.signal);
    vi.mocked(api).mockImplementation(async (url) => url.includes("/mentions") ? { mentions: [] }
      : { comments: [], summary: { totalCount: 0, unresolvedCount: 0, filePaths: [] } });
    await render("another-reader");
    expect(client).not.toBe(oldClient);
    expect(oldSignals.every((signal) => signal?.aborted)).toBe(true);
    await act(async () => oldRequests.forEach((finish) => finish({ mentions: [{ id: "private-old-notice" }], comments: [],
      summary: { totalCount: 99, unresolvedCount: 99, filePaths: ["private.tex"] } })));
    expect(mentions.unreadMentions).toEqual([]);
    expect(comments.projectCommentSummary?.totalCount).toBe(0);
    oldClient.clear();
  });
});
