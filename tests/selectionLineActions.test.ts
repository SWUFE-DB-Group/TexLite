import { EditorState } from "@codemirror/state";
import { lineNumberMarkers, type EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectionLineActions } from "../src/client/selectionLineActions";

afterEach(() => vi.unstubAllGlobals());

function fixture(readOnly = false) {
  const onComment = vi.fn();
  const onHistory = vi.fn();
  const state = EditorState.create({
    doc: "first\nsecond\nthird",
    extensions: [selectionLineActions({ commentLabel: "Add comment", historyLabel: "Selection history", onComment, onHistory }), EditorState.readOnly.of(readOnly)]
  });
  return { state, onComment, onHistory };
}

function marker(state: EditorState) {
  const ranges = state.facet(lineNumberMarkers)[0]!;
  const cursor = ranges.iter();
  return { from: cursor.from, value: cursor.value, size: ranges.size };
}

// Only the marker's DOM construction needs a DOM shim. CodeMirror state,
// transactions and marker ranges are real, without mounting an editor.
class MarkerElement {
  children: MarkerElement[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, (event: Event) => void> = {};
  className = "";
  title = "";
  type = "";
  append(...children: MarkerElement[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: (event: Event) => void) { this.handlers[name] = handler; }
}

function actionButtons(view: { state: EditorState }) {
  vi.stubGlobal("document", { createElement: () => new MarkerElement(), createElementNS: () => new MarkerElement() });
  return (marker(view.state).value!.toDOM!(view as EditorView) as unknown as MarkerElement).children;
}

describe("selection line actions", () => {
  it("shows one action group at the first selected line and removes it when selection clears", () => {
    let { state } = fixture();
    expect(marker(state).size).toBe(0);
    state = state.update({ selection: { anchor: 16, head: 8 } }).state;
    expect(marker(state)).toMatchObject({ size: 1, from: 6 });
    state = state.update({ changes: { from: 0, insert: "intro\n" } }).state;
    expect(marker(state)).toMatchObject({ size: 1, from: 12 });
    state = state.update({ selection: { anchor: 0 } }).state;
    expect(marker(state).size).toBe(0);
  });

  it("creates distinct, labelled controls with always-enabled tooltips", () => {
    const view = { state: fixture().state.update({ selection: { anchor: 0, head: 5 } }).state };
    const buttons = actionButtons(view);
    expect(buttons).toHaveLength(2);
    expect(buttons.map(button => button.title)).toEqual(["Add comment", "Selection history"]);
    expect(buttons.map(button => button.attributes["aria-label"])).toEqual(["Add comment", "Selection history"]);
    expect(buttons.every(button => button.dataset.texliteTooltipAlways === "true")).toBe(true);
    const down = new Event("mousedown", { cancelable: true });
    buttons[1]!.handlers.mousedown!(down);
    expect(down.defaultPrevented).toBe(true);
    expect(view.state.selection.main.to).toBe(5);
    const key = new Event("keydown", { cancelable: true });
    buttons[1]!.handlers.keydown!(key);
    expect(key.defaultPrevented).toBe(false); // Preserve native keyboard activation.
  });

  it("invokes the matching workflow with the live selection and source, including read-only editors", () => {
    const { state, onComment, onHistory } = fixture(true);
    const view = { state: state.update({ selection: { anchor: 0, head: 5 } }).state };
    const [comment, history] = actionButtons(view);
    // A reused marker must not capture the original selection or document.
    view.state = view.state.update({ changes: { from: 0, to: 5, insert: "edited" }, selection: { anchor: 0, head: 6 } }).state;
    history!.handlers.click!(new Event("click"));
    expect(onHistory).toHaveBeenCalledExactlyOnceWith("edited", 0, 6, "edited\nsecond\nthird");
    expect(onComment).not.toHaveBeenCalled();
    comment!.handlers.click!(new Event("click"));
    expect(onComment).toHaveBeenCalledExactlyOnceWith("edited", 0, 6, "edited\nsecond\nthird");
    view.state = view.state.update({ selection: { anchor: 0 } }).state;
    history!.handlers.click!(new Event("click"));
    expect(onHistory).toHaveBeenCalledTimes(1);
  });
});
