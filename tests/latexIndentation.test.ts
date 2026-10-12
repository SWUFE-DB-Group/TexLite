import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { ensureSyntaxTree, getIndentation, IndentContext, indentOnInput, indentRange, indentUnit } from "@codemirror/language";
import { latexLanguage } from "../src/client/latex";

function stateFor(source: string, unit = "  ") {
  const state = EditorState.create({
    doc: source, selection: { anchor: source.length },
    extensions: [latexLanguage, indentUnit.of(unit), indentOnInput()]
  });
  expect(ensureSyntaxTree(state, source.length, 200)).not.toBeNull();
  return state;
}

describe("basic LaTeX editing indentation", () => {
  it.each(["itemize", "enumerate", "figure", "table", "tabular", "equation", "align", "custom"])("indents %s contents and aligns its end", (name) => {
    const source = `\\begin{${name}}\nText\n\\end{${name}}`;
    const state = stateFor(source);
    expect(getIndentation(state, state.doc.line(2).from)).toBe(2);
    expect(getIndentation(state, state.doc.line(3).from)).toBe(0);
  });

  it("respects configured indentation and the opening line's existing indent", () => {
    const state = stateFor("    \\begin{itemize}\n\\item Text\n\\end{itemize}", "    ");
    expect(getIndentation(state, state.doc.line(2).from)).toBe(8);
    expect(getIndentation(state, state.doc.line(3).from)).toBe(4);
  });

  it("reindents nested environments together without letting section nodes add a level", () => {
    const source = "\\begin{document}\n\\section{Heading}\n\\begin{figure}\n\\begin{center}\nText\n\\end{center}\n\\end{figure}\n\\end{document}";
    const state = stateFor(source);
    expect(state.update({ changes: indentRange(state, 0, source.length) }).newDoc.toString()).toBe(
      "\\begin{document}\n\\section{Heading}\n\\begin{figure}\n  \\begin{center}\n    Text\n  \\end{center}\n\\end{figure}\n\\end{document}"
    );
  });

  it.each([
    ["{\ntext\n}", 2],
    ["\\textbf{\ntext\n}", 2],
    ["\\newcommand{\\foo}[1]{\n#1\n}", 2],
    ["\\section{\nheading\n}", 2],
    ["\\usepackage[\noption\n]{example}", 2],
    ["\\[\na+b\n\\]", 2],
    ["\\(\na+b\n\\)", 2]
  ] as const)("indents multiline groups without column alignment: %s", (source, indentation) => {
    const state = stateFor(source);
    expect(getIndentation(state, state.doc.line(2).from)).toBe(indentation);
    expect(getIndentation(state, state.doc.line(3).from)).toBe(0);
  });

  it("supports Enter's simulated newline in an existing environment", () => {
    const source = "\\begin{itemize}\n\\item Text\n\\end{itemize}";
    const state = stateFor(source);
    const position = state.doc.line(1).to;
    expect(getIndentation(new IndentContext(state, { simulateBreak: position }), position)).toBe(2);
  });

  it("reindents completed closing markers while typing", () => {
    const state = stateFor("\\begin{itemize}\n  \\item Text\n  \\end{itemize");
    const result = state.update({
      changes: { from: state.doc.length, insert: "}" },
      selection: { anchor: state.doc.length + 1 },
      annotations: Transaction.userEvent.of("input.type")
    });
    expect(result.newDoc.line(3).text).toBe("\\end{itemize}");
    const group = stateFor("\\textbf{\n  Text\n  ");
    expect(group.update({
      changes: { from: group.doc.length, insert: "}" },
      selection: { anchor: group.doc.length + 1 },
      annotations: Transaction.userEvent.of("input.type")
    }).newDoc.line(3).text).toBe("}");
  });

  it.each(["verbatim", "lstlisting", "minted", "filecontents", "alltt"])("preserves %s raw indentation, including fake closing examples", (name) => {
    const source = `\\begin{${name}}\n    raw\n  \\end{fake}\n  \\end{${name}}`;
    const state = stateFor(source);
    expect(getIndentation(state, state.doc.line(2).from)).toBeNull();
    expect(getIndentation(state, state.doc.line(3).from)).toBeNull();
    expect(getIndentation(state, state.doc.line(4).from)).toBe(0);
    expect(state.update({ changes: indentRange(state, 0, source.length) }).newDoc.toString()).toBe(
      `\\begin{${name}}\n    raw\n  \\end{fake}\n\\end{${name}}`
    );
  });
});
