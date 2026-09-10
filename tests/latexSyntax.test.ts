import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { defaultHighlightStyle, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import {
  bibtexCompletionSource,
  bibtexEditorExtensions,
  bibtexLanguage,
  bibtexLinter,
  latexLanguage
} from "../src/client/latexLanguage";
import { latexFold, findMatchingLatexEnvironmentEnd } from "../src/client/latexFolding";
import { latexCitationCompletionContext, latexEnvironmentCompletionContext, latexEnvironmentCompletionPlan } from "../src/client/latexCompletionContexts";
import { hasDocumentClass } from "../src/client/latexRoot";
import { inlineLatexLiteralEnd } from "../src/client/latexLiterals";

describe("LaTeX syntax handling", () => {
  it.each([
    String.raw`\lstinline{a{b}c}`,
    String.raw`\mintinline{python}{print("ok")}`,
    String.raw`\lstinline[language=C]{value \{ nested \}}`,
    String.raw`\verb{literal{`
  ])("ends inline literals before following normal text: %s", (literal) => {
    const source = literal + String.raw` Normal prose \textbf{after}`;
    expect(inlineLatexLiteralEnd(source, 0)).toBe(literal.length);
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    expect(syntaxTree(state).resolveInner(source.indexOf("Normal") + 1).name).not.toBe("string");
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

  it("does not let raw literal content leave subsequent prose in math mode", () => {
    for (const source of [
      String.raw`\verb|$|
Normal prose after an inline literal.`,
      String.raw`\begin{verbatim}
$
\end{verbatim}
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

  it("folds environments using real closing commands rather than commented or literal examples", () => {
    const source = String.raw`\begin{figure}
% \end{figure}
\begin{verbatim}
\end{figure}
\end{verbatim}
\caption{A real figure}
\end{figure}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage, latexFold] });
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
    expect(latexCitationCompletionContext(context)).toEqual({ from: source.lastIndexOf("jo"), query: "jo" });
  });

  it("recognizes spaced begin and end environment arguments", () => {
    const source = String.raw`\begin {fig`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const context = new CompletionContext(state, source.length, true);
    expect(latexEnvironmentCompletionContext(context)).toEqual({ from: source.lastIndexOf("fig"), query: "fig", command: "begin" });
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

  it("parses TeX accent escapes in BibTeX values without losing brace matching", () => {
    const source = String.raw`@inproceedings{rombach2022high,
  title={High-Resolution Image Synthesis with Latent Diffusion Models},
  author={Rombach, Robin and Blattmann, Andreas and Lorenz, Dominik and Esser, Patrick and Ommer, Bj{\"o}rn},
  booktitle={Proceedings of the IEEE/CVF conference on computer vision and pattern recognition},
  pages={10684--10695},
  year={2022}
}
@article{next,
  title="The next entry"
}`;
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const errors: Array<{ from: number; to: number }> = [];
    let entryCount = 0;
    let escapeCount = 0;
    syntaxTree(state).iterate({
      enter(node) {
        if (node.type.isError) errors.push({ from: node.from, to: node.to });
        if (node.name === "Entry") entryCount += 1;
        if (node.name === "Escape") escapeCount += 1;
      }
    });

    expect(errors).toEqual([]);
    expect(entryCount).toBe(2);
    expect(escapeCount).toBe(1);

    const authorClosing = source.indexOf("},\n  booktitle");
    const authorOpening = source.indexOf("{", source.indexOf("author="));
    expect(matchBrackets(state, authorClosing + 1, -1)).toMatchObject({
      start: { from: authorClosing, to: authorClosing + 1 },
      end: { from: authorOpening, to: authorOpening + 1 },
      matched: true
    });
  });

  it("parses common BibTeX value forms and nested TeX accents", () => {
    const source = String.raw`@string{cvpr = "Proceedings of CVPR"}
@inproceedings(garcia2025,
  author = {Garc{\'i}a and M{\"u}ller},
  booktitle = cvpr # " 2025",
  year = 2025,
)`;
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const errors: Array<{ from: number; to: number }> = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.type.isError) errors.push({ from: node.from, to: node.to });
      }
    });
    expect(errors).toEqual([]);
  });

  it("preserves highlighting for BibTeX line comments", () => {
    const source = "% Generated bibliography\n@article{sample, title={Example}}";
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const highlighted: string[] = [];
    highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => {
      highlighted.push(state.sliceDoc(from, to));
    });
    expect(highlighted).toContain("% Generated bibliography");
  });

  it("enables codemirror-lang-bib folding, diagnostics, and field completion", () => {
    const incompleteSource = String.raw`@article{example,
  title = {An incomplete entry}
}`;
    const state = EditorState.create({ doc: incompleteSource, extensions: [bibtexLanguage, ...bibtexEditorExtensions] });
    const openingLine = state.doc.line(1);
    const fold = foldable(state, openingLine.from, openingLine.to);
    expect(fold).toMatchObject({ to: state.doc.line(3).from });
    expect(fold?.from).toBeLessThan(openingLine.to);

    const diagnostics = bibtexLinter()({ state } as unknown as EditorView);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", source: "BibTeX" })
    ]));

    const completionSource = "@inproceedings{example,\n  aut";
    const completionState = EditorState.create({ doc: completionSource, extensions: [bibtexLanguage] });
    const completion = bibtexCompletionSource(new CompletionContext(completionState, completionSource.length, true));
    expect(completion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "author", type: "property" })
    ]));
  });
});
