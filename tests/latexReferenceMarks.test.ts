import { EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findLatexReferences } from "../src/shared/latexReferences";
import { LatexReferenceMarkPlugin, REFERENCE_SCAN_DELAY_MS, referenceNavigationSettings } from "../src/client/latexReferenceMarks";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness(source: string, scan = vi.fn(findLatexReferences), initialWindow = { from: 0, to: source.length }) {
  let state = EditorState.create({ doc: source, extensions: [referenceNavigationSettings.of({ enabled: true, title: (reference) => reference.key })] });
  let windows = [initialWindow];
  let plugin: LatexReferenceMarkPlugin;
  const view = {
    get state() { return state; },
    get visibleRanges() { return windows; },
    dispatch(spec: TransactionSpec) {
      const transaction = state.update(spec);
      const startState = state;
      state = transaction.state;
      windows = windows.map((window) => ({ from: transaction.changes.mapPos(window.from, -1), to: transaction.changes.mapPos(window.to, 1) }));
      plugin.update({ state, startState, docChanged: transaction.docChanged, viewportChanged: false, changes: transaction.changes, transactions: [transaction], view } as unknown as ViewUpdate);
    }
  } as unknown as EditorView;
  plugin = new LatexReferenceMarkPlugin(view, scan);
  return {
    view, plugin, scan,
    edit: (spec: TransactionSpec) => view.dispatch(spec),
    scroll(window: { from: number; to: number }) {
      windows = [window];
      const transaction = state.update({});
      plugin.update({ state, startState: state, docChanged: false, viewportChanged: true, changes: transaction.changes, transactions: [], view } as unknown as ViewUpdate);
    },
    marks() {
      const result: Array<{ from: number; to: number; attributes: Record<string, string> }> = [];
      plugin.decorations.between(0, state.doc.length, (from, to, mark) => { result.push({ from, to, attributes: mark.spec.attributes }); });
      return result;
    }
  };
}

describe("deferred LaTeX reference marks", () => {
  it("coalesces typing and reflow without scanning in the input update", () => {
    vi.useFakeTimers();
    const source = "\\cite{first}\n" + "Research prose.\n".repeat(10_000) + "\\ref{last}\nText";
    const h = harness(source);
    for (let index = 0; index < 20; index++) {
      const doc = h.view.state.doc;
      const flatten = vi.spyOn(doc, "sliceString");
      h.edit({ changes: { from: doc.length, insert: "x" } });
      expect(flatten).not.toHaveBeenCalled();
      flatten.mockRestore();
      h.scroll({ from: 0, to: h.view.state.doc.length });
      vi.advanceTimersByTime(10);
    }
    expect(h.scan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.scan).toHaveBeenLastCalledWith(source + "x".repeat(20));
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["first", "last"]);
    h.plugin.destroy();
  });

  it("removes marks in the affected suffix immediately and rebuilds current offsets after scanning", () => {
    vi.useFakeTimers();
    const source = "\\cite{before}\nParagraph\n\\ref{after}";
    const h = harness(source);
    h.edit({ changes: { from: source.indexOf("Paragraph"), insert: "More " } });
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["before"]);
    expect(h.scan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["before", "after"]);
    for (const mark of h.marks()) {
      expect(mark.attributes["data-latex-reference-from"]).toBe(String(mark.from));
      expect(mark.attributes["data-latex-reference-to"]).toBe(String(mark.to));
      expect(h.view.state.doc.sliceString(mark.from, mark.to)).toBe(mark.attributes["data-latex-reference-key"]);
    }
    h.plugin.destroy();
  });

  it("rechecks a retained multiline citation before navigation when its closing brace is removed", () => {
    vi.useFakeTimers();
    const source = "\\cite{first,\n second}";
    const h = harness(source);
    const first = findLatexReferences(source)[0]!;
    h.edit({ changes: { from: source.length - 1, to: source.length } });
    expect(h.marks()).toHaveLength(1);
    expect(h.plugin.resolve(first)).toBeNull();
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.marks()).toEqual([]);
    h.plugin.destroy();
  });

  it("keeps raw literal state across distant viewports after a structural edit", () => {
    vi.useFakeTimers();
    const source = "\\begin{verbatim}\n" + "Raw.\n".repeat(600) + "\\cite{hidden}\n\\end{verbatim}\n\\cite{visible}";
    const h = harness(source, vi.fn(findLatexReferences), { from: source.indexOf("\\cite{hidden}"), to: source.length });
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["visible"]);
    h.edit({ changes: { from: source.indexOf("Raw."), insert: "%" } });
    expect(h.marks()).toEqual([]);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["visible"]);
    h.plugin.destroy();
  });

  it("coalesces scrolling and reuses coverage instead of rescanning the same prefix", () => {
    vi.useFakeTimers();
    const source = "\\cite{first}\n" + "Paragraph.\n".repeat(1_000) + "\\cite{last}";
    const h = harness(source, vi.fn(findLatexReferences), { from: 0, to: 20 });
    expect(h.scan.mock.calls[0]![0].length).toBeLessThan(source.length);
    h.scroll({ from: 2_000, to: 3_000 });
    h.scroll({ from: source.length - 30, to: source.length });
    expect(h.scan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["last"]);
    h.scroll({ from: 0, to: 20 });
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["first"]);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.scan).toHaveBeenCalledTimes(2);
    h.plugin.destroy();
  });

  it("updates translated tooltips without rescanning and cancels work when disabled", () => {
    vi.useFakeTimers();
    const h = harness("\\cite{paper}\nText");
    h.edit({ effects: StateEffect.reconfigure.of(referenceNavigationSettings.of({ enabled: true, title: () => "Translated" })) });
    expect(h.marks()[0]!.attributes.title).toBe("Translated");
    expect(h.scan).toHaveBeenCalledTimes(1);
    h.edit({ changes: { from: h.view.state.doc.length, insert: "x" } });
    h.edit({ effects: StateEffect.reconfigure.of(referenceNavigationSettings.of({ enabled: false, title: () => "" })) });
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.marks()).toEqual([]);
    h.edit({ effects: StateEffect.reconfigure.of(referenceNavigationSettings.of({ enabled: true, title: () => "Enabled" })) });
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.marks()[0]!.attributes.title).toBe("Enabled");
    h.plugin.destroy();
  });

  it("never publishes a scan result for a replaced document", () => {
    vi.useFakeTimers();
    const scan = vi.fn(findLatexReferences);
    const h = harness("\\cite{old}", scan);
    h.edit({ changes: { from: 6, to: 9, insert: "intermediate" } });
    scan.mockImplementationOnce((source) => {
      h.edit({ changes: { from: 6, to: 18, insert: "latest" } });
      return findLatexReferences(source);
    });
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.marks()).toEqual([]);
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS);
    expect(h.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["latest"]);
    h.plugin.destroy();
  });

  it("cancels pending work when a file/editor is destroyed and keeps caches view-local", () => {
    vi.useFakeTimers();
    const old = harness("\\cite{old}\nText");
    old.edit({ changes: { from: old.view.state.doc.length, insert: "x" } });
    old.plugin.destroy();
    const current = harness("\\cite{current}");
    vi.advanceTimersByTime(REFERENCE_SCAN_DELAY_MS * 2);
    expect(old.scan).toHaveBeenCalledTimes(1);
    expect(old.marks()).toEqual([]);
    expect(current.marks().map((mark) => mark.attributes["data-latex-reference-key"])).toEqual(["current"]);
    current.plugin.destroy();
  });
});
