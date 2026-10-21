// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import { json, jsonLanguage } from "@codemirror/lang-json";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { latexLanguage } from "../src/client/latex";
import { LatexEditor } from "../src/client/LatexEditor";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import { loadTextFileLanguage } from "../src/client/textLanguages";

vi.mock("../src/client/textLanguages", async (original) => ({
  ...await original<typeof import("../src/client/textLanguages")>(), loadTextFileLanguage: vi.fn()
}));

function deferred() {
  let resolve!: (value: Extension) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Extension>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof LatexEditor>;
const editor = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
const render = (updates: Partial<typeof props> = {}) => act(async () => {
  props = { ...props, ...updates };
  root.render(createElement(LatexEditor, props));
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Layout is not under test; avoid scheduling CodeMirror's browser measures.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.mocked(loadTextFileLanguage).mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = {
    value: '{"title":"old"}', filePath: "settings.json", readOnly: false, comments: [], focusComment: null,
    preferences: defaultEditorPreferences, nativeSpellCheck: false, completionIndex: null, spellCheckIssues: [],
    spellCheckJump: null, jumpTo: null, searchRequest: 0,
    onChange: vi.fn(), onSelection: vi.fn(), onAddComment: vi.fn(), onSelectionHistory: vi.fn(),
    onCommentClick: vi.fn(), onSpellCheckReplace: vi.fn(), onReferenceNavigate: vi.fn(), onCursor: vi.fn()
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("editor auxiliary language lifecycle", () => {
  it.each(["main.tex", "refs.bib", "plain.bst"])("keeps %s synchronous without requesting auxiliary support", async (filePath) => {
    await render({ filePath });
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(loadTextFileLanguage).not.toHaveBeenCalled();
  });

  it("allows editing before load and preserves the document, cursor and undo history when highlighting arrives", async () => {
    const pending = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValue(pending.promise);
    await render();
    const current = editor();
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(false);
    await act(async () => current.dispatch({ changes: { from: 10, to: 13, insert: "new" }, selection: { anchor: 13 } }));
    const source = current.state.doc.toString();
    const selection = current.state.selection;
    const changes = vi.mocked(props.onChange).mock.calls.length;
    await act(async () => pending.resolve(json()));
    expect(editor()).toBe(current);
    expect(current.state.doc.toString()).toBe(source);
    expect(current.state.selection.eq(selection)).toBe(true);
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(true);
    expect(props.onChange).toHaveBeenCalledTimes(changes);
    await act(async () => { expect(undo(current)).toBe(true); });
    expect(current.state.doc.toString()).toBe(props.value);
  });

  it("ignores a late result after switching to a LaTeX file", async () => {
    const pending = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValue(pending.promise);
    await render();
    const old = editor();
    await render({ filePath: "main.tex", value: "\\section{Current}" });
    const current = editor();
    expect(current).not.toBe(old);
    await act(async () => pending.resolve(json()));
    expect(latexLanguage.isActiveAt(current.state, 0)).toBe(true);
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(false);
    expect(current.state.doc.toString()).toBe("\\section{Current}");
    expect(host.querySelector(".editor-language-notice")).toBeNull();
  });

  it("does not install a stale language or show a stale error after the editor is recreated", async () => {
    const first = deferred(), second = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    const old = editor();
    await render({ readOnly: true });
    const current = editor();
    expect(current).not.toBe(old);
    await act(async () => first.reject(new Error("Old request failed")));
    expect(host.querySelector(".editor-language-notice")).toBeNull();
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(false);
    await act(async () => second.resolve(json()));
    expect(current.state.readOnly).toBe(true);
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(true);
    expect(editor()).toBe(current);
  });

  it("preserves the Yjs binding and edits made during language loading", async () => {
    const pending = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValue(pending.promise);
    const doc = new Y.Doc(), text = doc.getText("file");
    text.insert(0, props.value);
    const awareness = new Awareness(doc);
    try {
      await render({ collaboration: { text, awareness } });
      const current = editor();
      await act(async () => current.dispatch({ changes: { from: current.state.doc.length, insert: "\n" } }));
      expect(text.toString()).toBe(`${props.value}\n`);
      await act(async () => pending.resolve(json()));
      expect(editor()).toBe(current);
      expect(current.state.doc.toString()).toBe(text.toString());
      expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(true);
      await act(async () => doc.transact(() => text.insert(text.length, " "), "remote"));
      expect(current.state.doc.toString()).toBe(text.toString());
      expect(props.onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.render(null));
      awareness.destroy(); doc.destroy();
    }
  });

  it("ignores errors from an editor that has already been unmounted", async () => {
    const pending = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValue(pending.promise);
    await render();
    await act(async () => root.render(null));
    await act(async () => pending.reject(new Error("Disconnected")));
    expect(host.textContent).toBe("");
  });

  it("keeps failures nonblocking and retries without recreating the editor", async () => {
    const pending = deferred();
    vi.mocked(loadTextFileLanguage).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json());
    await render();
    const current = editor();
    await act(async () => pending.reject(new Error("Disconnected")));
    expect(host.querySelector('.editor-language-notice[role="status"]')).not.toBeNull();
    expect(current.state.readOnly).toBe(false);
    await act(async () => current.dispatch({ changes: { from: current.state.doc.length, insert: "\n" } }));
    const source = current.state.doc.toString();
    await act(async () => host.querySelector<HTMLButtonElement>(".editor-language-notice button")!.click());
    expect(loadTextFileLanguage).toHaveBeenCalledTimes(2);
    expect(editor()).toBe(current);
    expect(current.state.doc.toString()).toBe(source);
    expect(jsonLanguage.isActiveAt(current.state, 0)).toBe(true);
    expect(host.querySelector(".editor-language-notice")).toBeNull();
  });
});
