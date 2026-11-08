// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import { LatexEditor } from "../src/client/LatexEditor";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import { agentChangeMarks } from "../src/client/agents/agentChangeMarks";
import { AgentChangesReview } from "../src/client/agents/AgentChangesReview";
import { useAgentChanges, type AgentChangeReview, type PendingAgentChange } from "../src/client/agents/useAgentChanges";
import { sourceHash } from "../src/client/sourceHash";
import type { AgentChange, AgentChangeFile } from "../src/shared/agentProtocol";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.mocked(api).mockReset();
  window.localStorage.clear();
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const source = "Intro.\nA stronger claim.\nEnd.\n";
const change = (id: string, text: string, extra: Partial<AgentChange> = {}): AgentChange => {
  const from = source.indexOf(text);
  return { id, ids: [id], at: "2026-01-01T10:00:00.000Z", from, to: from + text.length, line: source.slice(0, from).split("\n").length,
    pieces: [{ from, to: from + text.length }], anchors: [], before: "Old claim.", after: "A stronger claim.",
    afterFrom: source.lastIndexOf("\n", from - 1) + 1, ...extra };
};

describe("agent change marks in the editor", () => {
  let props: ComponentProps<typeof LatexEditor>;
  const editor = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  const marked = () => {
    const ranges: Array<[string, string]> = [];
    editor().state.field(agentChangeMarks).between(0, editor().state.doc.length, (from, to, value) => {
      ranges.push([editor().state.sliceDoc(from, to), String(value.spec.class ?? "widget")]);
    });
    return ranges;
  };
  const render = (updates: Partial<typeof props> = {}) => act(async () => {
    props = { ...props, ...updates };
    root.render(createElement(LatexEditor, props));
  });
  beforeEach(() => {
    props = {
      value: source, projectId: "project", filePath: "main.tex", mainFile: "main.tex", readOnly: false, comments: [], focusComment: null,
      preferences: defaultEditorPreferences, nativeSpellCheck: false, completionIndex: null, spellCheckIssues: [],
      spellCheckJump: null, jumpTo: null, searchRequest: 0,
      onChange: vi.fn(), onSelection: vi.fn(), onAddComment: vi.fn(), onSelectionHistory: vi.fn(),
      onCommentClick: vi.fn(), onSpellCheckReplace: vi.fn(), onReferenceNavigate: vi.fn(), onCursor: vi.fn(),
      onAgentChangesStale: vi.fn()
    };
  });

  it("marks agent text on the revision it was computed for and emphasizes the change shown in the panel", async () => {
    const changes = [change("a", "A stronger"), change("b", "", { pieces: [], anchors: [source.indexOf("End")], before: null })];
    await render({ agentChanges: { sourceHash: sourceHash(source), changes }, activeAgentChangeId: "a" });
    expect(marked()).toEqual([["A stronger", "cm-agent-change cm-agent-change-active"], ["", "widget"]]);
    expect(props.onAgentChangesStale).not.toHaveBeenCalled();
    // Marks follow local typing until the next result replaces them.
    await act(async () => editor().dispatch({ changes: { from: 0, insert: "New " } }));
    expect(marked()[0][0]).toBe("A stronger");
  });

  it("adds a review button after each change only when the agent review can be opened", async () => {
    const onOpenAgentChange = vi.fn();
    const changes = [change("a", "A stronger")];
    await render({ agentChanges: { sourceHash: sourceHash(source), changes } });
    expect(host.querySelector(".cm-agent-review-button")).toBeNull();
    await render({ onOpenAgentChange });
    const button = host.querySelector<HTMLButtonElement>('.cm-agent-review-button[data-agent-change-id="a"]')!;
    expect(button.getAttribute("aria-label")).toBe("Open in agent review");
    const selection = editor().state.selection;
    await act(async () => button.click());
    expect(onOpenAgentChange).toHaveBeenCalledWith("a");
    expect(editor().state.selection.eq(selection)).toBe(true);
  });

  it("places nothing and asks for a fresh result when the editor holds different text", async () => {
    await render({ agentChanges: { sourceHash: sourceHash(source + "unsaved"), changes: [change("a", "A stronger")] } });
    expect(marked()).toEqual([]);
    expect(props.onAgentChangesStale).toHaveBeenCalledOnce();
  });

  it("scrolls to a revealed change without moving the selection", async () => {
    const changes = [change("a", "A stronger")];
    await render({ agentChanges: { sourceHash: sourceHash(source), changes } });
    const selection = editor().state.selection;
    await render({ agentChangeReveal: { id: "a", nonce: 1 } });
    expect(editor().state.selection.eq(selection)).toBe(true);
  });
});

describe("agent change review bar", () => {
  const pending = (id: string, path: string, line: number, extra: Partial<PendingAgentChange> = {}): PendingAgentChange => ({
    ...change(id, "A stronger"), path, line, sourceHash: "h", ...extra
  });
  const review = (changes: PendingAgentChange[]): AgentChangeReview => ({
    pending: changes, forFile: () => null, loading: false, error: "", refresh: vi.fn(), refreshSoon: vi.fn(),
    markReviewed: vi.fn(), markAllReviewed: vi.fn()
  });
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(label))!;

  it("stays hidden without unreviewed changes", async () => {
    await act(async () => root.render(createElement(AgentChangesReview, { review: review([]), activeId: null, onShow: vi.fn() })));
    expect(host.querySelector(".agent-review")).toBeNull();
  });

  it("selects a change requested from the editor and switches between new content and diff", async () => {
    const onShow = vi.fn();
    const changes = [pending("a", "main.tex", 2), pending("b", "main.tex", 2, { id: "b", ids: ["b"] })];
    await act(async () => root.render(createElement(AgentChangesReview, { review: review(changes), activeId: null, onShow, focus: { id: "b", nonce: 1 } })));
    // Opened from the editor: the details show that change, and the editor is not moved again.
    expect(host.querySelector(".agent-review-position")?.textContent).toBe("2 / 2");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Diff");
    expect(onShow).not.toHaveBeenCalled();
    await act(async () => button("New content").click());
    expect(host.querySelector(".agent-review-content")?.textContent).toBe("A stronger claim.");
    expect(host.querySelector(".agent-review-content mark")?.textContent).toBe("A stronger");
    // The chosen tab stays while moving to another change.
    await act(async () => button("Previous change").click());
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("New content");
  });

  it("moves through changes across files, shows a diff, and marks the current one reviewed", async () => {
    const onShow = vi.fn();
    const changes = [pending("a", "main.tex", 2), pending("b", "intro.tex", 5, { before: null })];
    const state = review(changes);
    await act(async () => root.render(createElement(AgentChangesReview, { review: state, activeId: null, onShow })));
    expect(host.querySelector(".agent-review-count")?.textContent).toBe("2");
    await act(async () => button("Next change").click());
    // Navigation shows the change in the editor without taking keyboard focus.
    expect(onShow).toHaveBeenLastCalledWith(changes[1], false);
    expect(host.querySelector(".agent-review-file")?.textContent).toBe("intro.tex:5");
    expect(host.querySelector(".agent-review-unavailable")).not.toBeNull();
    await act(async () => button("Previous change").click());
    expect(host.querySelector(".suggestion-diff del")?.textContent).toBe("Old");
    await act(async () => button("Open in editor").click());
    expect(onShow).toHaveBeenLastCalledWith(changes[0], true);
    await act(async () => button("Mark reviewed").click());
    expect(state.markReviewed).toHaveBeenCalledWith(changes[0]);
    expect(onShow).toHaveBeenLastCalledWith(changes[1], false);
    await act(async () => button("Mark all reviewed").click());
    expect(state.markAllReviewed).toHaveBeenCalledOnce();
  });
});

describe("agent change review state", () => {
  let current: AgentChangeReview;
  function Probe({ userId }: { userId: string }) {
    current = useAgentChanges(userId, "paper", false);
    return null;
  }
  const files = (changes: AgentChange[]): { files: AgentChangeFile[] } => ({ files: [{ path: "main.tex", sourceHash: "h", changes }] });

  it("keeps review marks in this browser per user, and forgets marks for changes that no longer exist", async () => {
    vi.mocked(api).mockResolvedValue(files([change("a", "A stronger"), change("b", "End")]) as never);
    await act(async () => root.render(createElement(Probe, { userId: "alice" })));
    expect(api).toHaveBeenCalledWith("/api/projects/paper/agent-changes", expect.anything());
    expect(current.pending.map((item) => [item.id, item.path])).toEqual([["a", "main.tex"], ["b", "main.tex"]]);
    await act(async () => current.markReviewed(current.pending[0]));
    expect(current.pending.map((item) => item.id)).toEqual(["b"]);
    expect(current.forFile("main.tex")?.changes.map((item) => item.id)).toEqual(["b"]);

    // Remounting keeps the mark; another user of this browser has their own.
    await act(async () => root.render(createElement(Probe, { userId: "bob" })));
    expect(current.pending.map((item) => item.id)).toEqual(["a", "b"]);
    await act(async () => root.render(createElement(Probe, { userId: "alice" })));
    expect(current.pending.map((item) => item.id)).toEqual(["b"]);

    vi.mocked(api).mockResolvedValue(files([change("b", "End")]) as never);
    await act(async () => current.refresh());
    const stored = Object.entries(window.localStorage).find(([key]) => key.includes("texlite-agent-review") && key.includes("alice"));
    expect(JSON.parse(stored![1] as string)).toEqual([]);
    await act(async () => current.markAllReviewed());
    expect(current.pending).toEqual([]);
  });
});
