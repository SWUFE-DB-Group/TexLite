import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { latexLanguage } from "../src/client/latex";
import { bibtexLanguage } from "../src/client/bibtex";
import { bstLanguage } from "../src/client/bstLanguage";
import { editorColorScheme, selectedCommentDecorations } from "../src/client/editorThemeExtension";

function markedText(state: EditorState, visibleRanges = [{ from: 0, to: state.doc.length }]) {
  expect(ensureSyntaxTree(state, state.doc.length, 200)).not.toBeNull();
  const ranges: Array<{ from: number; to: number; text: string }> = [];
  selectedCommentDecorations(state, visibleRanges).between(0, state.doc.length, (from, to) => {
    ranges.push({ from, to, text: state.sliceDoc(from, to) });
  });
  return ranges;
}

describe("selected comment readability", () => {
  it.each([
    ["TeX", latexLanguage, String.raw`40.16\% text. % actual comment
\verb|%| \textbf{after}`],
    ["BibTeX", bibtexLanguage, "% actual comment\n@article{key, title={100% literal}, year={2026}}"],
    ["BST", bstLanguage, "% actual comment\nFUNCTION {example} { \"% literal\" write$ }"]
  ] as const)("brightens only parsed %s comments inside a selection", (_name, language, doc) => {
    const from = doc.indexOf("actual comment"), to = from + "actual comment".length;
    const state = EditorState.create({ doc, selection: { anchor: from, head: doc.length }, extensions: [language, editorColorScheme("dark")] });
    expect(markedText(state).map((range) => range.text.trimEnd())).toEqual(["actual comment"]);
    expect(markedText(state, [{ from: from + 7, to }])).toEqual([{ from: from + 7, to, text: "comment" }]);
  });

  it.each(["verbatim", "lstlisting"])("does not brighten percent signs inside %s", (name) => {
    const doc = `\\begin{${name}}\n% literal } $ \\ref{not-a-reference}\n\\end{${name}}\n% actual comment`;
    const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length }, extensions: [latexLanguage, editorColorScheme("dark")] });
    expect(markedText(state).map((range) => range.text)).toEqual(["% actual comment"]);
  });

  it("follows the current selection and theme after reconfiguration and edits", () => {
    const appearance = new Compartment();
    let state = EditorState.create({ doc: "40.16\\% text", selection: { anchor: 0, head: 12 }, extensions: [latexLanguage, appearance.of(editorColorScheme("dark"))] });
    expect(markedText(state)).toEqual([]);
    state = state.update({ changes: { from: 5, insert: "\\" }, selection: { anchor: 0, head: 13 } }).state;
    expect(markedText(state).map((range) => range.text)).toEqual(["% text"]);
    state = state.update({ effects: appearance.reconfigure(editorColorScheme("light")) }).state;
    expect(markedText(state)).toEqual([]);
    state = state.update({ effects: appearance.reconfigure(editorColorScheme("dark")) }).state;
    expect(markedText(state).map((range) => range.text)).toEqual(["% text"]);
    state = state.update({ selection: { anchor: 0 } }).state;
    expect(markedText(state)).toEqual([]);
  });
});
