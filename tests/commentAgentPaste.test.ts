// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../src/shared/agentProtocol";
import type { Comment, CommentReply } from "../src/shared/comments";
import { commentAgentPrompt } from "../src/client/agents/commentAgentPrompt";

const terminal = vi.hoisted(() => ({ paste: vi.fn(), focus: vi.fn() }));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {}; cols = 80; rows = 24;
    paste = terminal.paste; focus = terminal.focus;
    loadAddon() {} open() {} attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    hasSelection() { return false; }
    refresh() {} reset() {} write() {} dispose() {}
  }
}));

const { AgentTerminalSurface } = await import("../src/client/agents/AgentTerminalSurface");
const { CommentThread } = await import("../src/client/workspace/Comments");
const { CommentDraftStore } = await import("../src/client/workspace/commentDrafts");
const { discussionTestClient, withDiscussionQueries } = await import("./discussionTestUtils");
const { default: i18n } = await import("../src/client/i18n");

const reply = (content: string, name = "Bob") => ({ authorDisplayName: name, authorUsername: "bob", content }) as CommentReply;
const comment = (changes: Partial<Comment> = {}) => ({
  filePath: "sections/intro.tex", orphaned: false, startLine: 12, endLine: 14, resolved: false,
  selectedText: "We show $x < y$.", authorDisplayName: "Alice", authorUsername: "alice",
  content: "Is this proved?", replies: [], suggestion: null, ...changes
}) as Comment;
const payload = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf("{")));

describe("comment agent prompt", () => {
  it("carries the location, quote and discussion on one line", () => {
    const prompt = commentAgentPrompt(comment({ content: "Line one\nLine two", replies: [reply("Yes,\nin \\S 3.")] }));
    expect(prompt).not.toMatch(/[\r\n]/);
    expect(payload(prompt)).toEqual({
      file: "sections/intro.tex", startLine: 12, endLine: 14, resolved: false, selectedText: "We show $x < y$.",
      comment: { author: "Alice", text: "Line one\nLine two" }, replies: [{ author: "Bob", text: "Yes,\nin \\S 3." }]
    });
  });

  it("removes terminal controls that could end a bracketed paste", () => {
    const hostile = "a\u001b[201~b\u009b201~c\rd\u0003e" + String.fromCharCode(0x2028) + "f";
    const prompt = commentAgentPrompt(comment({ content: hostile, selectedText: hostile, replies: [reply(hostile, hostile)] }));
    expect(prompt).not.toMatch(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u);
    expect(prompt).not.toContain("\\u001b");
    expect(payload(prompt).comment.text).toBe("a[201~b201~cdef");
  });

  it("keeps the newest replies and reports how many were left out", () => {
    const replies = [reply("first " + "x".repeat(10_000)), reply("second " + "x".repeat(10_000)), reply("third " + "x".repeat(10_000)), reply("fourth " + "x".repeat(10_000))];
    const result = payload(commentAgentPrompt(comment({ replies })));
    expect(result.replies.map((entry: { text: string }) => entry.text.split(" ")[0])).toEqual(["third", "fourth"]);
    expect(result.omittedEarlierReplies).toBe(2);
  });

  it("bounds a long quote and has no line numbers for a lost anchor", () => {
    const result = payload(commentAgentPrompt(comment({ orphaned: true, selectedText: "q".repeat(9_000) })));
    expect(result.selectedText.length).toBeLessThan(4_100);
    expect(result.selectedText).toContain("[truncated]");
    expect(result.anchorLost).toBe(true);
    expect(result.startLine).toBeUndefined();
  });

  it("includes a replacement only while it is still proposed", () => {
    const suggestion = { status: "pending", replacementText: "We prove" } as Comment["suggestion"];
    expect(payload(commentAgentPrompt(comment({ suggestion }))).proposedReplacement).toBe("We prove");
    expect(payload(commentAgentPrompt(comment({ suggestion: { ...suggestion!, status: "accepted" } }))).proposedReplacement).toBeUndefined();
  });
});

describe("asking the agent from a comment", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const renderThread = (onAskAgent?: () => boolean) => act(async () => root.render(withDiscussionQueries(createElement(CommentThread, {
    projectId: "project", currentUserId: "me", draftStore: new CommentDraftStore(),
    comment: comment({ id: "c", authorId: "other", createdAt: "2026-11-01", updatedAt: "2026-11-01" }), onAskAgent,
    onMarkMentionRead: async () => true, onFocus: vi.fn(), onActivate: vi.fn(), onToggle: async () => {}, onReply: async () => true,
    onEdit: async () => true, onDelete: async () => true, onEditReply: async () => true, onDeleteReply: async () => true, onReplyExpansionChange: vi.fn()
  }), discussionTestClient())));
  const button = () => host.querySelector<HTMLButtonElement>(".comment-ask-agent");
  const hint = () => host.querySelector(".comment-agent-hint");

  it("reminds the user to start a task when none is running, then clears the reminder", async () => {
    vi.useFakeTimers();
    await renderThread(() => false);
    expect(button()?.getAttribute("aria-label")).toBe("让 Agent 分析批注");
    await act(async () => button()!.click());
    expect(hint()?.textContent).toBe("请先启动 Coding Agent 任务");
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(hint()).toBeNull();
  });

  it("shows no reminder when the request was accepted", async () => {
    const ask = vi.fn(() => true);
    await renderThread(ask);
    expect(button()?.disabled).toBe(false);
    await act(async () => button()!.click());
    expect(ask).toHaveBeenCalledOnce();
    expect(hint()).toBeNull();
  });

  it("disables the button without a reminder when agents are unavailable", async () => {
    await renderThread(undefined);
    expect(button()?.disabled).toBe(true);
    await act(async () => button()!.click());
    expect(hint()).toBeNull();
  });
});

describe("pasting into the agent terminal", () => {
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket;
    readyState = 1; sent: unknown[] = [];
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    constructor() { FakeSocket.last = this; }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
  }
  let host: HTMLElement;
  let root: Root;
  const finished = vi.fn();
  const running = { id: "t", state: "running" } as AgentTask;
  const request = { id: 1, text: "prompt" };
  const render = (task: AgentTask, pasteRequest: typeof request | null = request) => act(async () => root.render(
    createElement(AgentTerminalSurface, { task, onTask: () => {}, pasteRequest, onPasteFinished: finished })));
  const open = () => act(async () => FakeSocket.last.onopen!());
  const control = (writable: boolean) => act(async () => FakeSocket.last.onmessage!({ data: JSON.stringify({ type: "control", writable }) }));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", FakeSocket);
    terminal.paste.mockClear(); terminal.focus.mockClear(); finished.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("waits for the connection and control, then pastes once without pressing Enter", async () => {
    await render(running);
    expect(terminal.paste).not.toHaveBeenCalled();
    await open();
    await control(true);
    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith("prompt");
    expect(terminal.focus).toHaveBeenCalled();
    expect(finished).toHaveBeenCalledExactlyOnceWith(1);
    await render(running);
    expect(terminal.paste).toHaveBeenCalledTimes(1);
  });

  it("takes control once from another tab before pasting", async () => {
    await render(running);
    await open();
    await control(false);
    await control(false);
    expect(FakeSocket.last.sent.filter((message) => (message as { type: string }).type === "takeControl")).toHaveLength(1);
    expect(terminal.paste).not.toHaveBeenCalled();
    await control(true);
    expect(terminal.paste).toHaveBeenCalledTimes(1);
  });

  it("holds the paste until a starting task is running", async () => {
    await render({ ...running, state: "starting" });
    await open();
    await control(true);
    expect(terminal.paste).not.toHaveBeenCalled();
    await render(running);
    expect(terminal.paste).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a request", async () => {
    await render(running, null);
    await open();
    await control(true);
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});
