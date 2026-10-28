// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSourceComments, sourceCommentAnchorForId, sourceCommentDecorations } from "../src/client/sourceCommentDecorations";
import * as hashes from "../src/client/sourceHash";

const source = "Before abcdefghij after.";
const mark = () => ({ id: "thread", from: 7, to: 17, selectedText: "abcdefghij", contextBefore: "Before ", contextAfter: " after.",
  orphaned: false, resolved: false, anchorSourceHash: hashes.sourceHash(source) });
const views: EditorView[] = [];

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: source,
    extensions: sourceCommentDecorations({ label: "View", onOpen: vi.fn() }) }) });
  views.push(view);
  view.dispatch({ effects: setSourceComments.of([mark()]) });
  return view;
}

describe("deferred source-comment revision checks", () => {
  it("reconciles an HTTP deletion result arriving before the Yjs document without hashing in the input transaction", () => {
    const view = fixture();
    const changes = Array.from({ length: 9 }, (_, index) => ({ from: 8 + index, insert: String(index + 1) }));
    const changed = view.state.update({ changes }).state.doc.toString();
    const persisted = { ...mark(), to: 26, orphaned: true, anchorSourceHash: hashes.sourceHash(changed) };
    view.dispatch({ effects: setSourceComments.of([persisted]) });
    const hash = vi.spyOn(hashes, "sourceHash");
    view.dispatch({ changes });
    expect(hash).not.toHaveBeenCalled();
    expect(sourceCommentAnchorForId(view.state, "thread")?.orphaned).toBe(false);
    vi.advanceTimersByTime(200);
    expect(hash).toHaveBeenCalledExactlyOnceWith(changed);
    expect(sourceCommentAnchorForId(view.state, "thread")).toMatchObject({ orphaned: true, selectedText: "abcdefghij" });
    // A successful check is consumed, not replayed against later local undo.
    hash.mockClear();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    vi.advanceTimersByTime(1000);
    expect(hash).not.toHaveBeenCalled();
    expect(sourceCommentAnchorForId(view.state, "thread")?.orphaned).toBe(false);
  });

  it("coalesces pending checks while typing and does not poll an unmatched offline revision", () => {
    const view = fixture();
    view.dispatch({ effects: setSourceComments.of([{ ...mark(), orphaned: true, anchorSourceHash: hashes.sourceHash("future source revision") }]) });
    const hash = vi.spyOn(hashes, "sourceHash");
    for (let index = 0; index < 20; index++) {
      const flatten = vi.spyOn(view.state.doc, "toString");
      view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
      expect(flatten).not.toHaveBeenCalled();
      flatten.mockRestore();
      vi.advanceTimersByTime(10);
    }
    expect(hash).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(hash).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("does not hash ordinary edits with an already accepted server revision, including local deletion", () => {
    const view = fixture();
    const hash = vi.spyOn(hashes, "sourceHash");
    view.dispatch({ changes: { from: 7, to: 17 } });
    for (let index = 0; index < 5; index++) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
      vi.advanceTimersByTime(250);
    }
    expect(sourceCommentAnchorForId(view.state, "thread")?.orphaned).toBe(true);
    expect(hash).not.toHaveBeenCalled();
  });

  it("cancels pending work when the editor is destroyed", () => {
    const view = fixture();
    view.dispatch({ effects: setSourceComments.of([{ ...mark(), orphaned: true, anchorSourceHash: hashes.sourceHash("future source revision") }]) });
    const hash = vi.spyOn(hashes, "sourceHash");
    view.destroy(); views.pop();
    vi.advanceTimersByTime(1000);
    expect(hash).not.toHaveBeenCalled();
  });

  it("keeps a newly received comment detached until its own source revision arrives", () => {
    const view = fixture();
    const changed = source + "\n";
    const pending = { ...mark(), id: "new", contextAfter: " after.\n", anchorSourceHash: hashes.sourceHash(changed) };
    view.dispatch({ effects: setSourceComments.of([pending]) });
    expect(sourceCommentAnchorForId(view.state, "new")).toMatchObject({ orphaned: true, contextAfter: " after.\n" });
    view.dispatch({ changes: { from: source.length, insert: "\n" } });
    vi.advanceTimersByTime(200);
    expect(sourceCommentAnchorForId(view.state, "new")).toMatchObject({ orphaned: false, startOffset: 7, endOffset: 17 });
  });

  it("discards a pending deletion check when a newer matching response accepts the live anchor", () => {
    const view = fixture();
    view.dispatch({ effects: setSourceComments.of([{ ...mark(), orphaned: true, anchorSourceHash: hashes.sourceHash("other source") }]) });
    view.dispatch({ effects: setSourceComments.of([mark()]) });
    const hash = vi.spyOn(hashes, "sourceHash");
    vi.advanceTimersByTime(1000);
    expect(hash).not.toHaveBeenCalled();
    expect(sourceCommentAnchorForId(view.state, "thread")?.orphaned).toBe(false);
  });
});
