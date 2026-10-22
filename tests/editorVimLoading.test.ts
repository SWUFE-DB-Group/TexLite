// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { LatexEditor } from "../src/client/LatexEditor";
import { defaultEditorPreferences } from "../src/client/editorPreferences";
import { setTheme } from "../src/client/theme";
import { loadVimSupport, type VimSupport } from "../src/client/vimLoader";
import * as support from "../src/client/vimSupport";
import i18n from "../src/client/i18n";

vi.mock("../src/client/vimLoader", () => ({ loadVimSupport: vi.fn() }));

function deferred() {
  let resolve!: (value: VimSupport) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<VimSupport>((yes, no) => { resolve = yes; reject = no; });
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
const toggle = (enabled: boolean) => render({ preferences: { ...props.preferences, vimMode: enabled } });
const press = (key: string) => act(async () => { Vim.handleKey(getCM(editor())!, key, "user"); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await i18n.changeLanguage("en");
  vi.mocked(loadVimSupport).mockReset().mockResolvedValue(support);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = {
    value: "Original text.\n", filePath: "main.tex", readOnly: false, comments: [], focusComment: null,
    preferences: defaultEditorPreferences, nativeSpellCheck: false, completionIndex: null, spellCheckIssues: [],
    spellCheckJump: null, jumpTo: null, searchRequest: 0,
    onChange: vi.fn(), onSelection: vi.fn(), onAddComment: vi.fn(), onSelectionHistory: vi.fn(),
    onCommentClick: vi.fn(), onSpellCheckReplace: vi.fn(), onReferenceNavigate: vi.fn(), onCursor: vi.fn()
  };
});
afterEach(async () => {
  await act(async () => { root.unmount(); setTheme("light"); });
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("editor lazy Vim lifecycle", () => {
  it("does not request Vim or install Vim behavior when disabled", async () => {
    await render();
    expect(loadVimSupport).not.toHaveBeenCalled();
    expect(getCM(editor())).toBeNull();
    expect(host.querySelector(".vim-editor-status")).toBeNull();
  });

  it("preserves edits, selection and undo/redo history made before Vim finishes loading", async () => {
    const pending = deferred();
    vi.mocked(loadVimSupport).mockReturnValue(pending.promise);
    await toggle(true);
    const current = editor();
    expect(getCM(current)).toBeNull();
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe(i18n.t("editor.vimLoading"));
    await act(async () => current.dispatch({ changes: { from: 0, insert: "Added " }, selection: { anchor: 8 } }));
    const source = current.state.doc.toString(), selection = current.state.selection;
    await act(async () => pending.resolve(support));
    expect(editor()).toBe(current);
    expect(current.state.doc.toString()).toBe(source);
    expect(current.state.selection.eq(selection)).toBe(true);
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--NORMAL--");
    await press("u");
    expect(current.state.doc.toString()).toBe(props.value);
    await press("<C-r>");
    expect(current.state.doc.toString()).toBe(source);
  });

  it("keeps Insert mode on appearance changes and removes listeners when disabled", async () => {
    const watch = support.watchVimStatus;
    const cleanup = vi.fn();
    const subscribe = vi.spyOn(support, "watchVimStatus").mockImplementation((view, onChange) => {
      const stop = watch(view, onChange);
      return () => { cleanup(); stop(); };
    });
    await toggle(true);
    const current = editor(), cm = getCM(current);
    await press("i");
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--INSERT--");
    await render({ preferences: { ...props.preferences, fontSize: 20 } });
    await act(async () => setTheme("dark"));
    expect(editor()).toBe(current);
    expect(getCM(current)).toBe(cm);
    expect(cm?.state.vim?.insertMode).toBe(true);
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--INSERT--");
    expect(loadVimSupport).toHaveBeenCalledTimes(1);
    await toggle(false);
    expect(getCM(current)).toBeNull();
    expect(host.querySelector(".vim-editor-status")).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await toggle(true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--NORMAL--");
  });

  it("does not install Vim after the user disables it during loading", async () => {
    const pending = deferred();
    vi.mocked(loadVimSupport).mockReturnValue(pending.promise);
    await toggle(true);
    const current = editor();
    await toggle(false);
    await act(async () => pending.resolve(support));
    expect(editor()).toBe(current);
    expect(getCM(current)).toBeNull();
    expect(host.querySelector(".vim-editor-status")).toBeNull();
  });

  it("ignores stale results after file switching and installs Vim only for the current editor", async () => {
    const first = deferred(), second = deferred();
    vi.mocked(loadVimSupport).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await toggle(true);
    const old = editor();
    await render({ filePath: "chapter.tex", value: "Current file.\n" });
    const current = editor();
    expect(current).not.toBe(old);
    await act(async () => first.resolve(support));
    expect(getCM(current)).toBeNull();
    await act(async () => second.resolve(support));
    expect(getCM(current)).toBeDefined();
    expect(current.state.doc.toString()).toBe("Current file.\n");
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--NORMAL--");
  });

  it("reinstalls Vim on a read-only transition without allowing document changes", async () => {
    await toggle(true);
    const old = editor();
    await render({ readOnly: true });
    const current = editor();
    expect(current).not.toBe(old);
    expect(getCM(current)).toBeDefined();
    await press("x"); await press("u");
    expect(current.state.doc.toString()).toBe(props.value);
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--NORMAL--");
  });

  it("keeps ordinary editing available on failure and retries without replacing the editor", async () => {
    const pending = deferred();
    vi.mocked(loadVimSupport).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(support);
    await toggle(true);
    const current = editor();
    await act(async () => pending.reject(new Error("Disconnected")));
    expect(getCM(current)).toBeNull();
    expect(host.querySelector(".vim-editor-status")?.textContent).toContain(i18n.t("editor.vimLoadFailed"));
    await act(async () => current.dispatch({ changes: { from: 0, insert: "Added " } }));
    const source = current.state.doc.toString();
    await act(async () => host.querySelector<HTMLButtonElement>(".vim-editor-status button")!.click());
    expect(editor()).toBe(current);
    expect(current.state.doc.toString()).toBe(source);
    expect(getCM(current)).toBeDefined();
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--NORMAL--");
  });

  it("ignores a rejected import after unmount", async () => {
    const pending = deferred();
    vi.mocked(loadVimSupport).mockReturnValue(pending.promise);
    await toggle(true);
    await act(async () => root.render(null));
    await act(async () => pending.reject(new Error("Disconnected")));
    expect(host.textContent).toBe("");
  });

  it("installs Vim only in the surviving StrictMode editor instance", async () => {
    const subscribe = vi.spyOn(support, "watchVimStatus");
    const pending = deferred();
    vi.mocked(loadVimSupport).mockReturnValue(pending.promise);
    props = { ...props, preferences: { ...props.preferences, vimMode: true } };
    await act(async () => root.render(createElement(StrictMode, null, createElement(LatexEditor, props))));
    const current = editor();
    await act(async () => pending.resolve(support));
    expect(editor()).toBe(current);
    expect(getCM(current)).not.toBeNull();
    expect(subscribe).toHaveBeenCalledTimes(1);
    await press("i");
    expect(host.querySelector(".vim-editor-status")?.textContent).toBe("--INSERT--");
  });

  it("restores standard editing if Vim initialization fails after extension installation", async () => {
    vi.spyOn(support, "watchVimStatus").mockImplementationOnce(() => { throw new Error("Initialization failed"); });
    await toggle(true);
    const current = editor();
    expect(getCM(current)).toBeNull();
    expect(host.querySelector(".vim-editor-status")?.textContent).toContain(i18n.t("editor.vimLoadFailed"));
    await act(async () => current.dispatch({ changes: { from: 0, insert: "Added " } }));
    expect(current.state.doc.toString()).toBe(`Added ${props.value}`);
  });

  it("uses the session's Yjs undo manager and preserves another author's edits", async () => {
    const doc = new Y.Doc(), text = doc.getText("file");
    text.insert(0, props.value);
    const awareness = new Awareness(doc), undoManager = new Y.UndoManager(text);
    try {
      await render({ collaboration: { text, awareness, undoManager }, preferences: { ...props.preferences, vimMode: true } });
      const current = editor();
      await act(async () => current.dispatch({ changes: { from: 0, insert: "Local " } }));
      undoManager.stopCapturing();
      await act(async () => doc.transact(() => text.insert(text.length, "Remote\n"), "remote-author"));
      expect(current.state.doc.toString()).toBe(`Local ${props.value}Remote\n`);
      await press("u");
      expect(current.state.doc.toString()).toBe(`${props.value}Remote\n`);
      expect(text.toString()).toBe(`${props.value}Remote\n`);
      await press("<C-r>");
      expect(current.state.doc.toString()).toBe(`Local ${props.value}Remote\n`);
      expect(editor()).toBe(current);
    } finally {
      await act(async () => root.render(null));
      undoManager.destroy(); awareness.destroy(); doc.destroy();
    }
  });
});
