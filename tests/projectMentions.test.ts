// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import type { CommentMention } from "../src/client/types";
import { useProjectMentions } from "../src/client/workspace/useProjectMentions";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

let root: Root, host: HTMLDivElement, projectId: string, revision: string;
let mentions: ReturnType<typeof useProjectMentions>;
const onError = vi.fn();
function Harness() { mentions = useProjectMentions(projectId, revision, onError); return null; }
async function render() { await act(async () => root.render(createElement(Harness))); }
function notification(id: string, commentId = "comment"): CommentMention {
  return { id, projectId: "project", commentId, replyId: null, filePath: "main.tex", content: "@reader",
    resolved: false, createdAt: "2026-10-22T00:00:00Z", readAt: null, readReason: null };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset(); onError.mockReset();
  vi.mocked(api).mockResolvedValue({ mentions: [notification("first")] });
  projectId = "project"; revision = "initial";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render(); vi.mocked(api).mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("project mention cache", () => {
  it("automatically fetches new mentions on collaboration revisions without changing the 100 limit", async () => {
    vi.mocked(api).mockResolvedValue({ mentions: [notification("first"), notification("new")] });
    revision = "remote-reply";
    await render();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/project/mentions?unread=1&limit=100", expect.any(Object));
    expect(mentions.unreadMentions.map((item) => item.id)).toEqual(["first", "new"]);
  });

  it("retains same-project notifications on transient failure but clears access rejections", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("Unavailable", 503));
    await act(async () => mentions.refresh(true));
    expect(mentions.unreadMentions).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("Unavailable");
    vi.mocked(api).mockRejectedValue(new ApiError("Forbidden", 403));
    await act(async () => mentions.refresh());
    expect(mentions.unreadMentions).toEqual([]);
  });

  it("does not carry notifications into another project when its initial request fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Offline"));
    projectId = "other";
    await render();
    expect(mentions.unreadMentions).toEqual([]);
  });

  it("removes resolved mentions and prevents an older GET from resurrecting them", async () => {
    let finish!: (value: { mentions: CommentMention[] }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = mentions.refresh(); });
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    await act(async () => mentions.clearResolvedMentions("comment"));
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ mentions: [notification("first")] }); await pending; });
    expect(mentions.unreadMentions).toEqual([]);
  });

  it.each([false, true])("keeps confirmed read state if reconciliation fails (all=%s)", async (all) => {
    let finish!: (value: { mentions: CommentMention[] }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = mentions.refresh(); });
    vi.mocked(api).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") return { ok: true };
      throw new Error("Offline");
    });
    await act(async () => expect(all ? await mentions.markAllMentionsRead() : await mentions.markMentionRead("first")).toBe(true));
    await act(async () => { finish({ mentions: [notification("first")] }); await pending; });
    expect(mentions.unreadMentions).toEqual([]);
  });

  it("ignores a completed read operation after changing projects", async () => {
    let finish!: (value: { ok: boolean }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<boolean>;
    await act(async () => { pending = mentions.markMentionRead("first"); });
    projectId = "other";
    vi.mocked(api).mockResolvedValue({ mentions: [{ ...notification("other"), projectId }] });
    await render();
    await act(async () => { finish({ ok: true }); expect(await pending).toBe(false); });
    expect(mentions.unreadMentions.map((item) => item.id)).toEqual(["other"]);
  });
});
