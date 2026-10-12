import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { findLatexReferences } from "../src/shared/latexReferences";
import {
  LatexReferenceViewportCache,
  referenceScanWindows
} from "../src/client/latexReferenceDecorations";

function windowAround(source: string, needle: string): { from: number; to: number } {
  const from = source.indexOf(needle);
  if (from < 0) throw new Error(`Missing ${needle}`);
  return { from, to: from + needle.length };
}

describe("LaTeX reference viewport cache", () => {
  it("reuses bounded prefix coverage and extends it only when needed", () => {
    const source = "\\cite{first}\n" + "Paragraph.\n".repeat(600) + "\\cite{last}";
    const state = EditorState.create({ doc: source });
    const scan = vi.fn(findLatexReferences);
    const cache = new LatexReferenceViewportCache(scan);
    expect(cache.referencesThrough(state.doc, state.doc.line(1).to).map((reference) => reference.key)).toEqual(["first"]);
    expect(scan).toHaveBeenLastCalledWith("\\cite{first}");
    expect(cache.cachedThrough(state.doc, state.doc.line(1).to)).not.toBeNull();
    expect(cache.cachedThrough(state.doc, source.length)).toBeNull();
    cache.referencesThrough(state.doc, state.doc.line(1).to - 1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(cache.referencesFor(state.doc).map((reference) => reference.key)).toEqual(["first", "last"]);
    expect(scan).toHaveBeenCalledTimes(2);
    cache.clear();
    expect(cache.cachedThrough(state.doc, 0)).toBeNull();
  });

  it("scans an immutable document once across ordinary viewport changes", () => {
    const source = [
      "\\cite{intro}",
      ...Array.from({ length: 400 }, (_, index) => `Ordinary paragraph ${index}.`),
      "\\cite{middle}",
      ...Array.from({ length: 400 }, (_, index) => `More ordinary paragraph ${index}.`),
      "\\ref{appendix}"
    ].join("\n");
    const state = EditorState.create({ doc: source });
    const scan = vi.fn(findLatexReferences);
    const cache = new LatexReferenceViewportCache(scan);

    const firstWindow = referenceScanWindows(state.doc, [windowAround(source, "\\cite{middle}")], 0);
    expect(cache.referencesIn(state.doc, firstWindow).map((reference) => reference.key)).toEqual(["middle"]);

    const secondWindow = referenceScanWindows(state.doc, [windowAround(source, "\\ref{appendix}")], 0);
    expect(cache.referencesIn(state.doc, secondWindow).map((reference) => reference.key)).toEqual(["appendix"]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenLastCalledWith(source);

    const edited = state.update({ changes: { from: source.length, insert: "\n\\cite{new}" } }).state;
    const editedWindow = referenceScanWindows(edited.doc, [windowAround(edited.doc.toString(), "\\cite{new}")], 0);
    expect(cache.referencesIn(edited.doc, editedWindow).map((reference) => reference.key)).toEqual(["new"]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("keeps literal-environment context when a far-away viewport is scanned", () => {
    const source = [
      "\\begin{verbatim}",
      "\\cite{hidden}",
      ...Array.from({ length: 300 }, () => "literal source"),
      "\\end{verbatim}",
      "\\cite{visible}"
    ].join("\n");
    const state = EditorState.create({ doc: source });
    const cache = new LatexReferenceViewportCache();
    const windows = referenceScanWindows(state.doc, [windowAround(source, "\\cite{visible}")], 0);

    expect(cache.referencesIn(state.doc, windows).map((reference) => reference.key)).toEqual(["visible"]);
  });
});
