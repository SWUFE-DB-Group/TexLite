// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { SearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { createInstance } from "i18next";
import en from "../src/client/locales/en.json";
import { createEditorSearchPanel } from "../src/client/editorSearchPanel";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const views: EditorView[] = [];
// Happy DOM fires selectionchange synchronously, unlike browsers. Do not let
// its incomplete native selection model overwrite CodeMirror's real state.
const ignoreNativeSelection = (event: Event) => event.stopImmediatePropagation();
beforeEach(() => document.addEventListener("selectionchange", ignoreNativeSelection, true));
afterEach(() => {
  views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren();
  document.removeEventListener("selectionchange", ignoreNativeSelection, true);
});

function fixture(readOnly = false, doc = "model Model model models") {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [
    search({ top: true, createPanel: createEditorSearchPanel(i18n.t) }), keymap.of(searchKeymap), history(), EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)
  ] }) });
  views.push(view);
  openSearchPanel(view);
  const field = (name: string) => view.dom.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const button = (name: string) => view.dom.querySelector<HTMLButtonElement>(`button[name="${name}"]`)!;
  const type = (name: string, text: string) => { field(name).value = text; field(name).dispatchEvent(new Event("input", { bubbles: true })); };
  const key = (target: HTMLElement, key: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  const status = () => view.dom.querySelector(".cm-search-count")!.textContent;
  return { view, field, button, type, key, status };
}

describe("compact editor search panel", () => {
  it("keeps search focus, counts the selected match, and navigates with Enter / Shift+Enter", () => {
    const { view, field, type, key, status } = fixture();
    expect(document.activeElement).toBe(field("search"));
    type("search", "model");
    expect(status()).toBe("0 / 4");
    key(field("search"), "Enter");
    expect(status()).toBe("1 / 4");
    key(field("search"), "Enter");
    expect(status()).toBe("2 / 4");
    key(field("search"), "Enter", true);
    expect(status()).toBe("1 / 4");
    view.dispatch({ selection: { anchor: 12, head: 17 } });
    expect(status()).toBe("3 / 4");
    key(field("search"), "Escape");
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.hasFocus).toBe(true);
  });

  it("updates all three options, marks empty results, and accepts external query changes", () => {
    const { view, field, button, type, status } = fixture();
    type("search", "model");
    button("caseSensitive").click();
    expect(status()).toBe("0 / 3");
    button("wholeWord").click();
    expect(status()).toBe("0 / 2");
    button("regexp").click();
    type("search", "[");
    expect(status()).toBe(en.editor.search.invalidQuery);
    expect(field("search").getAttribute("aria-invalid")).toBe("true");
    expect(button("next").disabled).toBe(true);
    type("search", "missing");
    expect(status()).toBe(en.editor.search.noMatches);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "Model", caseSensitive: true, replace: "test" })) });
    expect(field("search").value).toBe("Model");
    expect(field("replace").value).toBe("test");
    expect(button("regexp").getAttribute("aria-pressed")).toBe("false");
    expect(status()).toBe("0 / 1");
  });

  it("replaces with CodeMirror transactions, preserves capture groups and supports undo", () => {
    const { view, field, button, type, key, status } = fixture(false, "item1 item2");
    type("search", "item(\\d)"); button("regexp").click();
    type("replace", "value$1");
    key(field("search"), "Enter");
    key(field("replace"), "Enter");
    expect(view.state.doc.toString()).toBe("value1 item2");
    expect(status()).toBe("1 / 1");
    button("replaceAll").click();
    expect(view.state.doc.toString()).toBe("value1 value2");
    expect(status()).toBe(en.editor.search.noMatches);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("value1 item2");
  });

  it("puts Select all in a dismissible menu and preserves the replace value when collapsed", () => {
    const { view, field, button, type, key } = fixture();
    type("search", "model"); type("replace", "framework");
    button("toggleReplace").click();
    expect(view.dom.querySelector<HTMLElement>(".cm-search-replace-row")!.hidden).toBe(true);
    button("toggleReplace").click();
    expect(field("replace").value).toBe("framework");
    key(button("more"), "ArrowDown");
    expect(document.activeElement).toBe(button("select"));
    key(button("select"), "Escape");
    expect(button("more").getAttribute("aria-expanded")).toBe("false");
    expect(searchPanelOpen(view.state)).toBe(true);
    button("more").click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(button("more").getAttribute("aria-expanded")).toBe("false");
    button("more").click(); button("select").click();
    expect(view.state.selection.ranges).toHaveLength(4);
    expect(view.hasFocus).toBe(true);
  });

  it("never exposes replacement in read-only views and ignores composition Enter", () => {
    const { view, field, button, type } = fixture(true);
    type("search", "model");
    expect(button("toggleReplace").hidden).toBe(true);
    expect(view.dom.querySelector<HTMLElement>(".cm-search-replace-row")!.hidden).toBe(true);
    field("search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(view.state.selection.main.empty).toBe(true);
    button("replaceAll").click();
    expect(view.state.doc.toString()).toBe("model Model model models");
  });

  it("disables identical case-sensitive replacements but permits case normalization and deletion", () => {
    const { view, button, type } = fixture();
    type("search", "model"); type("replace", "model");
    button("caseSensitive").click();
    expect(button("replaceAll").disabled).toBe(true);
    button("caseSensitive").click();
    expect(button("replaceAll").disabled).toBe(false);
    button("replaceAll").click();
    expect(view.state.doc.toString()).toBe("model model model models");
    button("wholeWord").click(); type("replace", "");
    button("replaceAll").click();
    expect(view.state.doc.toString()).toBe("   models");
  });
});
