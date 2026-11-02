// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { ReadOnlySource } from "../src/client/shared/ReadOnlySource";
import { loadTextFileLanguage } from "../src/client/textLanguages";

vi.mock("../src/client/textLanguages", async (original) => ({
  ...await original<typeof import("../src/client/textLanguages")>(), loadTextFileLanguage: vi.fn().mockResolvedValue([])
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.mocked(loadTextFileLanguage).mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each([
  ["main.tex", "\\section{Hello}", "latex"],
  ["references.bib", "@article{key, title={A study}}", "bibtex"],
  ["plain.bst", "ENTRY { title } {} {}", "bibtex-style"]
])("keeps %s highlighted, keyboard-focusable and read-only without auxiliary requests", async (path, content, expected) => {
  await act(async () => root.render(createElement(ReadOnlySource, { path, content })));
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  expect(view.state.readOnly).toBe(true); expect(view.state.facet(EditorView.editable)).toBe(false);
  expect(view.contentDOM.getAttribute("tabindex")).toBe("0"); expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
  expect(view.state.facet(language)?.name).toBe(expected); expect(view.state.doc.toString()).toBe(content);
  expect(loadTextFileLanguage).not.toHaveBeenCalled();
});

it("navigates to outline lines without making source editable", async () => {
  const onCursor = vi.fn(), content = "First\nSecond\nThird";
  await act(async () => root.render(createElement(ReadOnlySource, { path: "main.tex", content, jumpTo: { line: 2, nonce: 1 }, onCursor })));
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
  expect(onCursor).toHaveBeenLastCalledWith(2, 1, 6);
  expect(view.state.readOnly).toBe(true);
  expect(host.querySelector<HTMLElement>(".editor-shell")?.style.fontSize).toBe("14px");
});
