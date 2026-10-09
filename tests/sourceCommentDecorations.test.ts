import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openSourceCommentOnClick, setSourceComments, sourceCommentDecorations, sourceCommentMarksForFile
} from "../src/client/sourceCommentDecorations";
import type { Comment } from "../src/client/types";

afterEach(() => vi.unstubAllGlobals());

function comment(id: string, from = 1, to = 5): Comment {
  return {
    id, filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "text", startOffset: from, endOffset: to, startLine: 1, endLine: 1,
    content: "Please revise", resolved: false, orphaned: false, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", editedAt: null, replies: []
  };
}

function fixture(comments = [comment("thread")], readOnly = false) {
  const onOpen = vi.fn();
  const state = EditorState.create({
    doc: "some text here", extensions: [
      sourceCommentDecorations({ label: "View this source comment", onOpen }), EditorState.readOnly.of(readOnly)
    ]
  }).update({ effects: setSourceComments.of(sourceCommentMarksForFile(comments, "main.tex")) }).state;
  return { state, onOpen };
}

function ranges(state: EditorState) {
  const decorations = state.facet(EditorView.decorations)[0] as DecorationSet;
  const result = [];
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    result.push({ from: cursor.from, to: cursor.to, value: cursor.value });
  }
  return result;
}

class PinElement {
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, (event: Event) => void> = {};
  title = "";
  type = "";
  className = "";
  textContent = "";
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: (event: Event) => void) { this.handlers[name] = handler; }
  closest() { return this; }
}

function sourceClick(state: EditorState, onOpen: (id: string) => void, overrides: Partial<MouseEvent> = {}) {
  vi.stubGlobal("Element", PinElement);
  const target = new PinElement();
  target.dataset.sourceCommentId = "thread";
  return openSourceCommentOnClick({ button: 0, target, ...overrides } as unknown as MouseEvent, { state } as EditorView, onOpen);
}

describe("source comment navigation", () => {
  it("links unresolved source and pins, leaving resolved, orphaned and other-file threads unmarked", () => {
    const { state } = fixture([
      comment("thread"), { ...comment("resolved"), resolved: true },
      { ...comment("orphaned"), orphaned: true }, { ...comment("other"), filePath: "other.tex" }
    ]);
    const marks = ranges(state);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ from: 1, to: 5 });
    expect(marks[0]!.value.spec.attributes).toEqual({ "data-source-comment-id": "thread" });
    expect(marks[1]).toMatchObject({ from: 5, to: 5 });
    // Source marks must not become atomic ranges that prevent editing inside.
    expect(state.facet(EditorView.atomicRanges)).toEqual([]);
  });

  it("maps marks through edits and keeps pins for collapsed anchors and overlapping discussions", () => {
    let { state } = fixture([comment("one"), comment("two", 2, 6), comment("collapsed", 8, 8)]);
    state = state.update({ changes: { from: 0, insert: "prefix " } }).state;
    const mapped = ranges(state);
    expect(mapped.map(({ from, to }) => [from, to])).toEqual([[8, 12], [9, 13], [12, 12], [13, 13], [15, 15]]);
    state = state.update({ effects: setSourceComments.of([]) }).state;
    expect(ranges(state)).toEqual([]);
  });

  it("opens a thread on ordinary clicks without dispatching a source selection, including read-only editors", () => {
    const { state, onOpen } = fixture(undefined, true);
    expect(sourceClick(state, onOpen)).toBe(false);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("thread");
    expect(state.selection.main.empty).toBe(true);
  });

  it("does not hijack drag selections, modifier/reference clicks or right clicks", () => {
    const { state, onOpen } = fixture();
    sourceClick(state.update({ selection: { anchor: 1, head: 5 } }).state, onOpen);
    for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 2 }, { defaultPrevented: true }]) {
      sourceClick(state, onOpen, overrides);
    }
    expect(onOpen).not.toHaveBeenCalled();
    vi.stubGlobal("Element", PinElement);
    openSourceCommentOnClick({ button: 0, target: new PinElement() } as unknown as MouseEvent, { state } as EditorView, onOpen);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("activates labelled pin buttons directly despite CodeMirror ignoring widget events", () => {
    const { state, onOpen } = fixture([comment("collapsed", 3, 3)]);
    vi.stubGlobal("document", { createElement: () => new PinElement() });
    const widget = ranges(state)[0]!.value.spec.widget!;
    const pin = widget.toDOM({ state } as EditorView) as unknown as PinElement;
    expect(pin.type).toBe("button");
    expect(pin.attributes["aria-label"]).toBe("View this source comment");
    const down = new Event("mousedown", { cancelable: true });
    pin.handlers.mousedown!(down);
    expect(down.defaultPrevented).toBe(true);
    const key = new Event("keydown", { cancelable: true });
    pin.handlers.keydown!(key);
    expect(key.defaultPrevented).toBe(false); // Enter/Space activate the native button.
    pin.handlers.click!(new Event("click"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("collapsed");
  });
});
