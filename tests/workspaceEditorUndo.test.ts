// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import { WorkspaceEditorPanel, type WorkspaceEditorPanelProps } from "../src/client/workspace/WorkspaceEditorPanel";
import "../src/client/i18n";

vi.mock("react-resizable-panels", async (original) => ({
  ...await original<typeof import("react-resizable-panels")>(),
  Panel: ({ children }: { children: ReactNode }) => createElement("section", null, children)
}));

const initial = "Original source\n";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let doc: Y.Doc;
let text: Y.Text;
let awareness: Awareness;
let manager: Y.UndoManager;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  doc = new Y.Doc();
  text = doc.getText("source:main.tex");
  text.insert(0, initial);
  awareness = new Awareness(doc);
  manager = new Y.UndoManager(text);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  manager.destroy();
  awareness.destroy();
  doc.destroy();
  vi.unstubAllGlobals();
});

const view = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
const noop = () => {};
const render = (readOnly: boolean, overrides: Partial<WorkspaceEditorPanelProps> = {}) => act(async () => {
  const props: WorkspaceEditorPanelProps = {
    project: { mainFile: "main.tex" } as WorkspaceEditorPanelProps["project"],
    projectId: "paper", activeFile: "main.tex", mainFile: "main.tex", loadedFile: "main.tex", openTabs: [], content: initial,
    readOnly, comments: [], focusComment: null, editorPreferences: defaultEditorPreferences,
    completionIndex: null, nativeSpellCheck: false, spellCheckIssues: [], spellCheckJump: null, sourceJump: null,
    collaborativeText: text, collaborationAwareness: awareness, undoManager: manager, editorNotice: "",
    activateTab: noop, closeTab: noop, handleTabKeyDown: noop, reorderTab: noop, updateEditorContent: noop,
    setSelection: noop, onAddComment: noop, onSelectionHistory: noop, onCommentClick: noop, onSpellCheckReplace: noop,
    onReferenceNavigate: noop, onCursor: noop, onSourceJumpHandled: noop, ...overrides
  };
  root.render(createElement(WorkspaceEditorPanel, props));
});

const pressUndoKey = (redo = false) => act(async () => {
  const mac = /Mac/.test(navigator.platform);
  view().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: redo ? "Z" : "z", code: "KeyZ", keyCode: 90, ctrlKey: !mac, metaKey: mac, shiftKey: redo, bubbles: true, cancelable: true
  }));
});

describe("workspace collaboration undo", () => {
  it("undoes and redoes local edits after the initial sync without undoing another author's changes", async () => {
    await render(true);
    await act(async () => vi.dynamicImportSettled());
    const current = view();
    expect(current.state.readOnly).toBe(true);
    await render(false);
    expect(view()).toBe(current);
    await act(async () => current.dispatch({ changes: { from: 0, insert: "Local " } }));
    await act(async () => doc.transact(() => text.insert(text.length, "Remote\n"), "remote"));
    await pressUndoKey();
    expect(text.toString()).toBe(initial + "Remote\n");
    expect(current.state.doc.toString()).toBe(text.toString());
    await pressUndoKey(true);
    expect(text.toString()).toBe("Local " + initial + "Remote\n");
  });

  it("preserves history across a disconnect but blocks keyboard and native undo while read-only", async () => {
    await render(false);
    const current = view();
    await act(async () => current.dispatch({ changes: { from: 0, insert: "Local " } }));
    await render(true);
    await pressUndoKey();
    await act(async () => current.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "historyUndo", bubbles: true, cancelable: true
    })));
    expect(text.toString()).toBe("Local " + initial);
    await render(false);
    expect(view()).toBe(current);
    await pressUndoKey();
    expect(text.toString()).toBe(initial);
  });
});

describe("workspace source navigation", () => {
  it("waits for the requested file and selects only the clicked occurrence on a line", async () => {
    const content = "Setup\nkey key suffix";
    text.delete(0, text.length);
    text.insert(0, content);
    const onSourceJumpHandled = vi.fn();
    const sourceJump = { path: "main.tex", line: 2, column: 5, matchText: "key", nonce: 1 };
    await render(false, { sourceJump, onSourceJumpHandled, loadedFile: "" });
    await act(async () => vi.dynamicImportSettled());
    expect(view().state.selection.main.empty).toBe(true);
    expect(onSourceJumpHandled).not.toHaveBeenCalled();
    await render(false, { sourceJump, onSourceJumpHandled });
    expect(view().state.selection.main).toMatchObject({ from: 10, to: 13 });
    expect(onSourceJumpHandled).toHaveBeenCalledExactlyOnceWith(1);
    await act(async () => {
      view().dispatch(view().state.replaceSelection("new"));
    });
    expect(text.toString()).toBe("Setup\nkey new suffix");
  });

  it("positions the caret without selecting a line for coordinates or a stale search result", async () => {
    await render(false, { sourceJump: { path: "main.tex", line: 1, column: 4, nonce: 1 } });
    await act(async () => vi.dynamicImportSettled());
    expect(view().state.selection.main).toMatchObject({ from: 3, to: 3 });
    await render(false, { sourceJump: { path: "main.tex", line: 1, column: 10, matchText: "obsolete", nonce: 2 } });
    expect(view().state.selection.main).toMatchObject({ from: 9, to: 9 });
  });
});
