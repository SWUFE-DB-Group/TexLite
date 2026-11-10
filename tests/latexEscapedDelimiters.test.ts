// @vitest-environment happy-dom
import { closeBrackets } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { deleteLatexEscapedPair, enterLatexEnvironmentBody, latexAutoPairInput, latexSkippedBracePair } from "../src/client/latexAutoPairs";
import { latexLanguage } from "../src/client/latexLanguage";

function editor(marked: string): EditorView {
  const anchor = marked.indexOf("|");
  return new EditorView({ state: EditorState.create({ doc: marked.replace("|", ""), selection: { anchor },
    extensions: [latexLanguage, EditorView.inputHandler.of(latexAutoPairInput), closeBrackets(), latexSkippedBracePair] }) });
}
const type = (view: EditorView, text: string) => {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
  if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, insert))) view.dispatch(insert());
};
const marked = (view: EditorView) => { const { head } = view.state.selection.main; const text = view.state.doc.toString(); return text.slice(0, head) + "|" + text.slice(head); };

describe("escaped LaTeX delimiters", () => {
  it.each([["\\|", "[", "\\[|\\]"], ["\\|", "(", "\\(|\\)"], ["\\|", "{", "\\{|\\}"], ["a \\|\nb", "[", "a \\[|\\]\nb"]])("pairs %s with %s", (source, text, expected) => {
    const view = editor(source);
    type(view, text);
    expect(marked(view)).toBe(expected);
  });

  it("still closes a sized delimiter at the end of a line with its own command", () => {
    const view = editor("\\left\\|");
    type(view, "{");
    expect(marked(view)).toBe("\\left\\{|\\right\\}");
  });

  it.each([
    ["\\\\|", "[", "\\\\[|]"],
    ["\\|word", "[", "\\[|word"],
    ["\\bigl\\| x", "{", "\\bigl\\{| x"],
    ["\\left\\| x", "{", "\\left\\{| x"]
  ])("does not add an escaped closer after %s", (source, text, expected) => {
    const view = editor(source);
    type(view, text);
    expect(marked(view)).toBe(expected);
  });

  it("leaves comments and verbatim text alone", () => {
    const view = editor("% \\|");
    type(view, "[");
    expect(view.state.doc.toString()).not.toContain("\\]");
  });

  it("steps over the closer when it is typed by hand", () => {
    const view = editor("\\[ x \\|\\]");
    type(view, "]");
    expect(marked(view)).toBe("\\[ x \\]|");
  });

  it("removes an empty pair with Backspace, and only an empty pair", () => {
    const empty = editor("a\\[|\\]b");
    expect(deleteLatexEscapedPair(empty)).toBe(true);
    expect(marked(empty)).toBe("a|b");
    const filled = editor("\\[x|\\]");
    expect(deleteLatexEscapedPair(filled)).toBe(false);
    const escaped = editor("\\\\[|\\]");
    expect(deleteLatexEscapedPair(escaped)).toBe(false);
  });

  it("closes a typed environment over the auto-inserted brace", () => {
    const view = editor("\\begin|");
    for (const text of ["{", "itemize", "}"]) type(view, text);
    expect(marked(view)).toBe("\\begin{itemize}\n\t|\n\\end{itemize}");
  });

  it("goes from the end of a begin line into its empty body", () => {
    const view = editor("\\begin{tabular}{cc}|\n\t\n\\end{tabular}");
    expect(enterLatexEnvironmentBody(view)).toBe(true);
    expect(marked(view)).toBe("\\begin{tabular}{cc}\n\t|\n\\end{tabular}");
    expect(enterLatexEnvironmentBody(editor("\\begin{tabular}{cc}|\n\tx\n\\end{tabular}"))).toBe(false);
    expect(enterLatexEnvironmentBody(editor("\\begin{tabular|}{cc}\n\t\n\\end{tabular}"))).toBe(false);
  });
});
