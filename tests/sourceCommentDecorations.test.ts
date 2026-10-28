import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openSourceCommentOnClick, setSourceComments, sourceCommentAnchorForId, sourceCommentDecorations, sourceCommentMarksForFile
} from "../src/client/sourceCommentDecorations";
import type { Comment } from "../src/client/types";
import { sourceHash } from "../src/client/sourceHash";

afterEach(() => vi.unstubAllGlobals());

function comment(id: string, from = 1, to = 5): Comment {
  return {
    id, filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
    selectedText: "some text here".slice(from, to), startOffset: from, endOffset: to, startLine: 1, endLine: 1,
    content: "Please revise", resolved: false, orphaned: false, createdAt: "2026-01-01T00:00:00Z",
    resolvedById: null, resolvedByUsername: null, resolvedByDisplayName: null, resolvedAt: null,
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
  children: PinElement[] = [];
  handlers: Record<string, (event: Event) => void> = {};
  title = "";
  type = "";
  className = "";
  textContent = "";
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(child: PinElement) { this.children.push(child); }
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
      { ...comment("orphaned"), selectedText: "missing", orphaned: true }, { ...comment("other"), filePath: "other.tex" }
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

  it("tracks local insertion and deletion within a quote without losing its source mark", () => {
    let { state } = fixture([comment("thread", 5, 9)]);
    state = state.update({ changes: { from: 7, insert: "new " } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 5, endOffset: 13, selectedText: "tenew xt", orphaned: false });
    state = state.update({ changes: { from: 6, to: 7 } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 5, endOffset: 12, selectedText: "tnew xt", orphaned: false });
    expect(ranges(state)).toHaveLength(2);
  });

  it("recovers a fully replaced quote on undo before any server save", () => {
    let { state } = fixture([comment("thread", 5, 9)]);
    state = state.update({ changes: { from: 5, to: 9, insert: "other" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "text", orphaned: true });
    expect(ranges(state)).toEqual([]);
    state = state.update({ changes: { from: 5, to: 10, insert: "text" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 5, endOffset: 9, selectedText: "text", orphaned: false });
    expect(ranges(state)).toHaveLength(2);
  });

  it("keeps a deleted quote detached from an unchanged duplicate until its own text is restored", () => {
    const source = "Before target after.\nBefore target after.\n";
    const from = source.indexOf("target");
    const saved = { ...comment("thread"), startOffset: from, endOffset: from + 6, selectedText: "target" };
    let state = EditorState.create({ doc: source, extensions: [sourceCommentDecorations({ label: "View", onOpen: vi.fn() })] })
      .update({ effects: setSourceComments.of(sourceCommentMarksForFile([saved], "main.tex")) }).state;
    state = state.update({ changes: { from, to: from + 6 } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    expect(ranges(state)).toEqual([]);
    state = state.update({ changes: { from: 0, insert: "% note\n" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    state = state.update({ changes: { from: from + 7, insert: "tarXget" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    state = state.update({ changes: { from: from + 10, to: from + 11 } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ orphaned: false, startOffset: from + 7, endOffset: from + 13 });
    expect(ranges(state)).toHaveLength(2);
  });

  it("does not reset local offsets when an unchanged saved anchor arrives with a reply or resolution", () => {
    const saved = comment("thread", 5, 9);
    let { state } = fixture([saved]);
    state = state.update({ changes: { from: 0, insert: "prefix " } }).state;
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([{ ...saved, resolved: true }], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 12, endOffset: 16, selectedText: "text", orphaned: false });
    expect(ranges(state)).toEqual([]);
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([saved], "main.tex")) }).state;
    expect(ranges(state).map(({ from, to }) => [from, to])).toEqual([[12, 16], [16, 16]]);
  });

  it("keeps a whole-range replacement detached through partial recovery until the full quote returns", () => {
    let { state } = fixture([comment("thread", 5, 9)]);
    state = state.update({ changes: { from: 5, to: 9, insert: "teXt" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "text", orphaned: true });
    state = state.update({ changes: { from: 5, to: 9, insert: "tex" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    expect(ranges(state)).toEqual([]);
    state = state.update({ changes: { from: 8, insert: "t" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "text", startOffset: 5, endOffset: 9, orphaned: false });
  });

  it("retains an anchor when an exact partial deletion leaves only one original character", () => {
    let { state } = fixture([comment("thread", 5, 9)]);
    state = state.update({ changes: { from: 6, to: 9 } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "t", startOffset: 5, endOffset: 6, orphaned: false });
  });

  it("keeps the live anchor when a save response represents an earlier partial edit", () => {
    const saved = comment("thread", 5, 9);
    let { state } = fixture([saved]);
    state = state.update({ changes: { from: 7, insert: "new " } }).state;
    const firstSave = { ...saved, selectedText: "tenew xt", endOffset: 13 };
    state = state.update({ changes: { from: 7, insert: "next " } }).state;
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([firstSave], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 5, endOffset: 18, selectedText: "tenext new xt", orphaned: false });
    expect(ranges(state)).toHaveLength(2);
  });

  it("does not lose a locally restored marker when a stale orphaned save response arrives", () => {
    const saved = { ...comment("thread", 5, 9), contextBefore: "some ", contextAfter: " here" };
    let { state } = fixture([saved]);
    state = state.update({ changes: { from: 5, to: 9 } }).state;
    state = state.update({ changes: { from: 5, insert: "text" } }).state;
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([{ ...saved, endOffset: 5, orphaned: true }], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: 5, endOffset: 9, orphaned: false });
    expect(ranges(state)).toHaveLength(2);
  });

  it("accepts authoritative external deletion without mistaking it for a stale save", () => {
    const source = "Before abcdefghij after.";
    const selected = "abcdefghij";
    const from = source.indexOf(selected);
    const saved = { ...comment("thread"), selectedText: selected, startOffset: from, endOffset: from + selected.length,
      contextBefore: "Before ", contextAfter: " after.", anchorSourceHash: sourceHash(source) };
    let state = EditorState.create({ doc: source, extensions: [sourceCommentDecorations({ label: "View", onOpen: vi.fn() })] })
      .update({ effects: setSourceComments.of(sourceCommentMarksForFile([saved], "main.tex")) }).state;
    const changes = Array.from({ length: 9 }, (_, index) => ({ from: from + index + 1, insert: String(index + 1) }));
    const changed = state.update({ changes }).state.doc.toString();
    const persisted = { ...saved, endOffset: from + 19, orphaned: true, anchorSourceHash: sourceHash(changed) };
    state = state.update({ changes }).state;
    // A raw remote Yjs update carries the same small operations as typing.
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(false);
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([persisted], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: selected, orphaned: true });
    expect(ranges(state)).toEqual([]);
  });

  it.each([false, true])("does not let a late partial-save response attach a deleted quote to another occurrence (revision supplied: %s)", (revision) => {
    const source = "Before text after.\nBefore te!xt after.";
    const saved = { ...comment("thread", 7, 11), selectedText: "text", contextBefore: "Before ", contextAfter: " after.\nBefore te!xt after.",
      anchorSourceHash: revision ? sourceHash(source) : undefined };
    let state = EditorState.create({ doc: source, extensions: sourceCommentDecorations({ label: "View", onOpen: vi.fn() }) })
      .update({ effects: setSourceComments.of(sourceCommentMarksForFile([saved], "main.tex")) }).state;
    state = state.update({ changes: { from: 9, insert: "!" } }).state;
    const partialSave = { ...saved, selectedText: "te!xt", endOffset: 12,
      anchorSourceHash: revision ? sourceHash(state.doc.toString()) : undefined };
    const length = state.doc.line(1).length + 1;
    state = state.update({ changes: { from: 0, to: length } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    // The surviving duplicate now occupies exactly the saved range.
    expect(state.doc.sliceString(partialSave.startOffset, partialSave.endOffset)).toBe("te!xt");
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([partialSave], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ orphaned: true, selectedText: "te!xt" });
    expect(ranges(state)).toEqual([]);
    state = state.update({ changes: { from: 0, insert: "Before te!xt after.\n" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ orphaned: false, startOffset: 7, endOffset: 12 });
  });

  it("preserves local undo and subsequent typing when a revision-bound deletion response is behind", () => {
    const saved = { ...comment("thread", 5, 9), contextBefore: "some ", contextAfter: " here", anchorSourceHash: sourceHash("some text here") };
    let { state } = fixture([saved]);
    state = state.update({ changes: { from: 5, to: 9 } }).state;
    const deletedHash = sourceHash(state.doc.toString());
    state = state.update({ changes: { from: 5, insert: "text" } }).state;
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([
      { ...saved, endOffset: 5, orphaned: true, anchorSourceHash: deletedHash }
    ], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "text", orphaned: false });
    state = state.update({ changes: { from: 7, insert: "new " } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "tenew xt", orphaned: false });
    state = state.update({ effects: setSourceComments.of(sourceCommentMarksForFile([saved], "main.tex")) }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ selectedText: "tenew xt", orphaned: false });
  });

  it("recovers a distant quote on whole-document undo without flattening on ordinary edits", () => {
    const source = "before\n".repeat(2000) + "review this paragraph\n" + "after\n".repeat(2000);
    const start = source.indexOf("review");
    const item = { ...comment("thread"), startOffset: start, endOffset: start + 21, selectedText: "review this paragraph" };
    let state = EditorState.create({ doc: source, extensions: [sourceCommentDecorations({ label: "View", onOpen: vi.fn() })] })
      .update({ effects: setSourceComments.of(sourceCommentMarksForFile([item], "main.tex")) }).state;
    const flatten = vi.spyOn(state.doc, "toString");
    state = state.update({ changes: { from: 0, insert: "prefix\n" } }).state;
    expect(flatten).not.toHaveBeenCalled();
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: "overwritten" } }).state;
    expect(sourceCommentAnchorForId(state, "thread")?.orphaned).toBe(true);
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: "prefix\n" + source } }).state;
    expect(sourceCommentAnchorForId(state, "thread")).toMatchObject({ startOffset: start + 7, endOffset: start + 28, orphaned: false });
    expect(ranges(state)).toHaveLength(2);
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

  it("requests a toggle from labelled pin buttons despite CodeMirror ignoring widget events", () => {
    const { state, onOpen } = fixture([comment("collapsed", 3, 3)]);
    vi.stubGlobal("document", { createElement: () => new PinElement(), createElementNS: () => new PinElement() });
    const widget = ranges(state)[0]!.value.spec.widget!;
    const pin = widget.toDOM({ state } as EditorView) as unknown as PinElement;
    expect(pin.type).toBe("button");
    expect(pin.attributes["aria-label"]).toBe("View this source comment");
    expect(pin.textContent).toBe("");
    expect(pin.children[0]?.attributes["aria-hidden"]).toBe("true");
    expect(pin.children[0]?.children).toHaveLength(1);
    const down = new Event("mousedown", { cancelable: true });
    pin.handlers.mousedown!(down);
    expect(down.defaultPrevented).toBe(true);
    const key = new Event("keydown", { cancelable: true });
    pin.handlers.keydown!(key);
    expect(key.defaultPrevented).toBe(false); // Enter/Space activate the native button.
    pin.handlers.click!(new Event("click"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("collapsed", true);
  });
});
