import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { matchBrackets } from "@codemirror/language";
import { latexLanguage } from "../src/client/latexLanguage";

describe("LaTeX syntax handling", () => {
  it("matches an outer resizebox brace after a nested tabular environment", () => {
    const source = String.raw`\resizebox{\linewidth}{!}{
  \begin{tabular}{ll}
    \textbf{Header} \\
  \end{tabular}
}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const openingLine = state.doc.line(1);
    const closingLine = state.doc.line(5);
    const opening = openingLine.from + openingLine.text.lastIndexOf("{");
    const closing = closingLine.from + closingLine.text.indexOf("}");
    const match = matchBrackets(state, closing + 1, -1);
    expect(match).toMatchObject({
      start: { from: closing, to: closing + 1 },
      end: { from: opening, to: opening + 1 },
      matched: true
    });
  });
});
