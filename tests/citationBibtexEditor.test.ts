// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { undo, undoDepth } from "@codemirror/commands";
import CitationBibtexEditor from "../src/client/CitationBibtexEditor";
import { setTheme } from "../src/client/theme";
import { citationEditor, replaceCitationBibtex } from "./helpers/citationEditor";

let host: HTMLDivElement, root: Root, props: ComponentProps<typeof CitationBibtexEditor>;
const render = (updates: Partial<typeof props> = {}) => act(async () => {
  props = { ...props, ...updates };
  root.render(createElement(StrictMode, null, createElement(CitationBibtexEditor, props)));
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  setTheme("light");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { value: '@article{paper, title={{Protected} text}, url={\\url{https://example.org}}}', placeholder: "BibTeX", onChange: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); setTheme("light"); localStorage.clear(); vi.unstubAllGlobals();
});

it("mounts the real BibTeX language and colored tokens, with native spellchecking disabled", async () => {
  await render();
  const view = citationEditor(host);
  expect(view.state.facet(language)?.name).toBe("bibtex");
  expect(view.state.doc.toString()).toBe(props.value);
  const tokens = [...view.contentDOM.querySelectorAll("span[class]")];
  const entryType = tokens.find((node) => node.textContent === "@article");
  const key = tokens.find((node) => node.textContent === "paper");
  expect(entryType).toBeDefined(); expect(key).toBeDefined();
  expect(entryType!.className).not.toBe(key!.className);
  expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
  expect(view.contentDOM.getAttribute("aria-label")).toBe("BibTeX");
});

it("keeps the document, cursor and undo stack across theme, tab visibility and read-only changes", async () => {
  await render();
  const view = citationEditor(host), original = props.value;
  const edited = original.replace("Protected", "Draft");
  await act(async () => replaceCitationBibtex(host, edited));
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(edited);
  await render({ value: edited });
  const selection = view.state.selection;
  expect(undoDepth(view.state)).toBe(1);
  await act(async () => setTheme("dark"));
  await render({ active: false, disabled: true, placeholder: "Paste a reference" });
  expect(citationEditor(host)).toBe(view);
  expect(view.state.doc.toString()).toBe(edited);
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  expect(view.state.readOnly).toBe(true);
  expect(view.state.facet(EditorView.editable)).toBe(false);
  expect(undoDepth(view.state)).toBe(1);
  await render({ active: true, disabled: false });
  await act(async () => { expect(undo(view)).toBe(true); });
  expect(props.onChange).toHaveBeenLastCalledWith(original);
});

it("applies external values without echoing changes and always calls the current callback for user edits", async () => {
  await render();
  const view = citationEditor(host), originalCallback = props.onChange;
  const onChange = vi.fn();
  await render({ value: "@misc{replacement, title={Updated from the form}}", onChange, disabled: true });
  expect(citationEditor(host)).toBe(view);
  expect(view.state.doc.toString()).toBe(props.value);
  expect(originalCallback).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
  expect(undoDepth(view.state)).toBe(0);
  await render({ disabled: false });
  await act(async () => replaceCitationBibtex(host, "@misc{replacement, title={User edit}}"));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("@misc{replacement, title={User edit}}");
  expect(originalCallback).not.toHaveBeenCalled();
});
