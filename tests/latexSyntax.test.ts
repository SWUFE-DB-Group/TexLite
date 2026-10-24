import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { defaultHighlightStyle, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { latexLanguage } from "../src/client/latexLanguage";
import { findMatchingLatexEnvironmentEnd } from "../src/client/latexFolding";
import { latexCompletionContext, latexEnvironmentCompletionPlan } from "../src/client/latexCompletionContexts";
import { hasDocumentClass } from "../src/client/latexRoot";
import { hasLatexDocumentClass } from "../src/shared/latexRoot";
import { inlineLatexLiteralEnd } from "../src/client/latexLiterals";

describe("LaTeX syntax handling", () => {
  it("exposes structured command arguments without mutating earlier editor states", () => {
    const original = EditorState.create({ doc: String.raw`\documentclass{article}`, extensions: [latexLanguage] });
    const before = syntaxTree(original).toString();
    const edited = original.update({ changes: { from: 14, insert: "[11pt]" } }).state;
    expect(syntaxTree(edited).toString()).toContain("OptionalArgument");
    expect(syntaxTree(edited).toString()).toContain("DocumentClassArgument");
    expect(syntaxTree(original).toString()).toBe(before);
  });

  it.each([
    String.raw`\lstinline{a{b}c}`,
    String.raw`\mintinline{python}{print("ok")}`,
    String.raw`\lstinline[language=C]{value \{ nested \}}`,
    String.raw`\Verb[formatcom=\color{red}]{a{b}c}`,
    String.raw`\verb{literal{`
  ])("ends inline literals before following normal text: %s", (literal) => {
    const source = literal + String.raw` Normal prose \textbf{after}`;
    expect(inlineLatexLiteralEnd(source, 0)).toBe(literal.length);
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const tree = syntaxTree(state);
    expect(tree.resolveInner(source.indexOf("Normal") + 1).name).toBe("Normal");
    expect(tree.resolveInner(source.indexOf("\\textbf") + 1).name).toBe("TextBoldCtrlSeq");
  });

  it("folds after literal percent signs and ignores nested-looking raw commands", () => {
    for (const body of [String.raw`\verb|%|`, String.raw`\lstinline{%}`, String.raw`\begin{verbatim}
\begin{figure}
100% \end{verbatim}`]) {
      const source = `\\begin{figure}\n${body} \\end{figure}`;
      const state = EditorState.create({ doc: source });
      expect(findMatchingLatexEnvironmentEnd(state.doc, source.indexOf("}") + 1, "figure")?.from)
        .toBe(source.lastIndexOf("\\end{figure}"));
    }
  });

  it("folds a literal block at its raw close even after percent signs", () => {
    const source = String.raw`\begin{verbatim}
\begin{verbatim}
% \end{verbatim}`;
    const state = EditorState.create({ doc: source });
    expect(findMatchingLatexEnvironmentEnd(state.doc, source.indexOf("}") + 1, "verbatim")?.from)
      .toBe(source.indexOf("\\end{verbatim}"));
  });

  it("already ignores minted language arguments during root detection", () => {
    expect(hasDocumentClass(String.raw`\begin{minted}[linenos]{latex}
\documentclass{article}
\end{minted}`)).toBe(false);
  });
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

  it("detects document roots after source changes while ignoring comments and listings", () => {
    expect(hasDocumentClass("% \\documentclass{article}\n")).toBe(false);
    const listing = "\\begin{verbatim}[options]\n\\documentclass{article}\n\\end{verbatim}";
    expect(hasDocumentClass(listing)).toBe(false);
    expect(hasDocumentClass("\\documentclass[11pt]{article}\n")).toBe(true);
  });

  it("uses one literal-aware root detector for all source entry points", () => {
    const nonRoots = [
      String.raw`\verb|\documentclass{article}|`,
      String.raw`\begin{alltt}
\documentclass{article}
\end{alltt}`,
      String.raw`\begin{tcblisting}
\documentclass{article}
\end{tcblisting}`,
      String.raw`\\documentclass{article}`
    ];
    for (const source of nonRoots) {
      expect(hasLatexDocumentClass(source)).toBe(false);
      expect(hasDocumentClass(source)).toBe(false);
    }
    expect(hasLatexDocumentClass(String.raw`\documentclass{article}`)).toBe(true);
  });

  it("does not let raw literal content leave subsequent prose in math mode", () => {
    for (const source of [
      String.raw`\verb|$|
Normal prose after an inline literal.`,
      String.raw`\begin{verbatim}
$
\end{verbatim}
Normal prose after a literal environment.`,
      String.raw`\begin{alltt}
$
\end{alltt}
Normal prose after a literal environment.`
    ]) {
      const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
      const proseStart = source.indexOf("Normal prose");
      const proseEnd = source.length;
      const highlighted: Array<{ from: number; to: number }> = [];
      highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => highlighted.push({ from, to }));
      expect(highlighted.some((range) => range.from < proseEnd && range.to > proseStart)).toBe(false);
    }
  });

  it("treats a percent sign immediately after a number as a comment", () => {
    const source = "100% comment containing $ that must not enter math mode\nNormal prose after the comment.";
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const proseStart = source.indexOf("Normal prose");
    const highlighted: Array<{ from: number; to: number }> = [];
    highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => highlighted.push({ from, to }));

    expect(highlighted.some((range) => range.to > proseStart)).toBe(false);
  });

  it("folds environments using real closing commands rather than commented or literal examples", () => {
    const source = String.raw`\begin{figure}
% \end{figure}
\begin{verbatim}
\end{figure}
\end{verbatim}
\caption{A real figure}
\end{figure}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const opening = state.doc.line(1);
    const closing = state.doc.line(7);
    expect(foldable(state, opening.from, opening.to)).toMatchObject({ from: opening.to, to: closing.from });

    const beginEnd = source.indexOf("}") + 1;
    expect(findMatchingLatexEnvironmentEnd(state.doc, beginEnd, "figure")).toMatchObject({ from: closing.from });
  });

  it("finds only the current citation key after commas and optional citation arguments", () => {
    const source = String.raw`\citep[see][p. 5]{smith2024, jo`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const context = new CompletionContext(state, source.length, true);
    expect(latexCompletionContext(context).argument).toMatchObject({ kind: "citation", from: source.lastIndexOf("jo"), query: "jo" });
  });

  it.each([
    [String.raw`\cite% a comment between the command and its argument
{paper`, "paper"],
    [String.raw`\cite[prenote={see [also]}]{paper`, "paper"],
    [String.raw`\cite{first,% a comment before the next key
  second`, "second"]
  ])("finds an unfinished citation key through TeX trivia: %s", (source, query) => {
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const context = new CompletionContext(state, source.length, true);
    expect(latexCompletionContext(context).argument).toMatchObject({ kind: "citation", from: source.lastIndexOf(query), query });
  });

  it("does not mistake an escaped command for an unfinished citation", () => {
    const source = String.raw`\\cite{paper`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const context = new CompletionContext(state, source.length, true);
    expect(latexCompletionContext(context).argument).toBeNull();
  });

  it("recognizes spaced begin and end environment arguments", () => {
    const source = String.raw`\begin {fig`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const context = new CompletionContext(state, source.length, true);
    expect(latexCompletionContext(context).argument).toMatchObject({ kind: "environment", from: source.lastIndexOf("fig"), query: "fig", command: "begin" });
  });

  it("reuses an existing environment close instead of inserting a duplicate", () => {
    const source = String.raw`\begin{fig}
  \caption{Already written below}
\end{figure}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const from = source.indexOf("fig");
    const plan = latexEnvironmentCompletionPlan(state.doc, from, from + "fig".length, "figure");
    expect(plan).toMatchObject({ insert: "figure}", reusesExistingEnd: true });

    const withoutEnd = EditorState.create({ doc: String.raw`  \begin{fig`, extensions: [latexLanguage] });
    const noEndFrom = withoutEnd.doc.length - "fig".length;
    expect(latexEnvironmentCompletionPlan(withoutEnd.doc, noEndFrom, withoutEnd.doc.length, "figure"))
      .toMatchObject({ insert: "figure}\n  \t\n  \\end{figure}", reusesExistingEnd: false });
  });

  it("does not steal an outer close while completing a nested environment", () => {
    const source = String.raw`\begin{itemize}
  \begin{ite}
\end{itemize}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const from = source.indexOf("\\begin{ite}") + "\\begin{".length;
    expect(latexEnvironmentCompletionPlan(state.doc, from, from + "ite".length, "itemize"))
      .toMatchObject({ reusesExistingEnd: false, insert: "itemize}\n  \t\n  \\end{itemize}" });
  });

  it.each(["\\begin\n{fig}", "\\begin% note\n{fig}"])("reuses a multiline environment end for %s", (opening) => {
    const source = `${opening}\nText\n\\end\n{figure}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const from = source.indexOf("fig");
    const plan = latexEnvironmentCompletionPlan(state.doc, from, from + 3, "figure");
    expect(plan).toMatchObject({ insert: "figure}", reusesExistingEnd: true });
    expect(source.slice(0, from) + plan.insert + source.slice(plan.to)).toBe(`${opening.replace("fig", "figure")}\nText\n\\end\n{figure}`);
  });

  it("preserves a multiline outer close when completing a nested environment", () => {
    const source = "\\begin\n{itemize}\n  \\begin\n  {ite}\n\\end\n{itemize}";
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const from = source.indexOf("{ite}") + 1;
    expect(latexEnvironmentCompletionPlan(state.doc, from, from + 3, "itemize").reusesExistingEnd).toBe(false);
  });

  it("reuses a multiline close after skipping literal examples and comments", () => {
    const source = "\\begin\n{fig}\n\\verb|\\end{figure}|\n% \\end{figure}\n\\begin{verbatim}\n\\end{figure}\n\\end{verbatim}\n\\end% close\n{figure}";
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const from = source.indexOf("fig");
    expect(latexEnvironmentCompletionPlan(state.doc, from, from + 3, "figure")).toMatchObject({ insert: "figure}", reusesExistingEnd: true });
  });

  it("does not let commented or escaped begin markers claim a real closing command", () => {
    for (const prefix of ["% \\begin{itemize}\n", "\\\\begin{itemize}\n"]) {
      const source = prefix + "\\begin\n{ite}\n\\end{itemize}";
      const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
      const from = source.indexOf("{ite}") + 1;
      expect(latexEnvironmentCompletionPlan(state.doc, from, from + 3, "itemize")).toMatchObject({ insert: "itemize}", reusesExistingEnd: true });
    }
  });
});
