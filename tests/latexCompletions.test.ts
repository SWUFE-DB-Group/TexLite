import { describe, expect, it, vi } from "vitest";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFunction } from "i18next";
import { latexCompletions } from "../src/client/latexCompletions";
import { latexLanguage } from "../src/client/latexLanguage";
import type { LatexCompletionIndex } from "../src/client/types";

const t = ((key: string) => key) as TFunction;
const index: LatexCompletionIndex = {
  commands: [], environments: [{ label: "figure", kind: "keyword", detail: "Environment" }],
  labels: [{ label: "fig:second", kind: "constant", detail: "Label" }], citations: [],
  packages: [{ label: "amssymb", kind: "text", detail: "Package" }],
  classes: [{ label: "article", kind: "class", detail: "Document class" }],
  files: [{ label: "figure.png", kind: "text", detail: "Project file" }]
};

function complete(source: string, explicit = true, completionIndex: LatexCompletionIndex = index) {
  const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
  return latexCompletions(new CompletionContext(state, source.length, explicit), t, completionIndex);
}

describe("editor LaTeX completion source", () => {
  it.each([
    [String.raw`\usepackage{amsmath, ams`, "amssymb", String.raw`\usepackage{amsmath, amssymb`],
    [String.raw`\RequirePackage[opt]{amsmath, ams`, "amssymb", String.raw`\RequirePackage[opt]{amsmath, amssymb`],
    [String.raw`\cref{fig:first, fig:`, "fig:second", String.raw`\cref{fig:first, fig:second`],
    [String.raw`\Cref{fig:first, fig:`, "fig:second", String.raw`\Cref{fig:first, fig:second`],
    [String.raw`\crefrange{fig:first}{fig:`, "fig:second", String.raw`\crefrange{fig:first}{fig:second`],
    [String.raw`\vpageref[on the next page]{fig:`, "fig:second", String.raw`\vpageref[on the next page]{fig:second`],
    [String.raw`\hyperref[fig:`, "fig:second", String.raw`\hyperref[fig:second`]
  ])("preserves earlier list entries in %s", (source, label, expected) => {
    const result = complete(source)!;
    expect(result.options.some((item) => item.label === label)).toBe(true);
    expect(source.slice(0, result.from) + label).toBe(expected);
    expect(result.validFor.test("item,")).toBe(false);
  });

  it.each(["nocite", "citep*", "citet*", "Parencite", "Textcite", "Autocite", "Citeauthor"])("completes %s citations", (command) => {
    const source = `\\${command}[see]{one, tw`;
    expect(complete(source)?.from).toBe(source.lastIndexOf("tw"));
  });

  it("completes subsequent multicite arguments", () => {
    const source = String.raw`\cites[see]{first}[p. 2]{seco`;
    expect(complete(source)?.from).toBe(source.lastIndexOf("seco"));
  });

  it("shares comment-aware citation parsing with reference navigation", () => {
    const source = String.raw`\bibitem{known} A local bibliography item.
\cite% a command comment
{known}
\cite{known,% a key comment
  kn`;
    const result = complete(source)!;
    expect(result.from).toBe(source.lastIndexOf("kn"));
    expect(result.options).toEqual(expect.arrayContaining([expect.objectContaining({ label: "known" })]));
  });

  it("shares label extraction with reference navigation", () => {
    const source = String.raw`\\label{escaped-label}
\label{visible-label}
\hypertarget{target-label}{Anchor}
\ref{vis`;
    const options = complete(source)!.options.map((option) => option.label);
    expect(options).toEqual(expect.arrayContaining(["visible-label", "target-label"]));
    expect(options).not.toContain("escaped-label");
  });

  it("limits citation choices to project BibTeX entries and current-file bibitems", () => {
    const source = String.raw`\bibitem{current-manual} A manual bibliography entry.
\cite{cur`;
    const scopedIndex: LatexCompletionIndex = {
      ...index,
      citations: [
        { label: "linked-bib", detail: "BibTeX key", kind: "constant", source: "references.bib" },
        { label: "historical-use", detail: "Citation key", kind: "constant", source: "main.tex" },
        { label: "other-manual", detail: "Bibliography key", kind: "constant", source: "appendix.tex" }
      ]
    };
    const options = complete(source, true, scopedIndex)!.options.map((option) => option.label);
    expect(options).toEqual(expect.arrayContaining(["current-manual", "linked-bib"]));
    expect(options).not.toEqual(expect.arrayContaining(["historical-use", "other-manual"]));
  });

  it("does not interpret a separate group after a single citation as another citation argument", () => {
    expect(complete(String.raw`\cite{first} {ordinary`, false)).toBeNull();
  });

  it("does not offer arbitrary project files as document classes", () => {
    expect(complete(String.raw`\documentclass{`)?.options.map((item) => item.label)).toEqual(["article"]);
  });

  it.each([String.raw`\end{fig`, String.raw`\end{fig}`])("closes end completions without duplicating braces: %s", (source) => {
    let state = EditorState.create({ doc: source });
    const to = source.indexOf("fig") + 3;
    const result = latexCompletions(new CompletionContext(state, to, true), t, index)!;
    const option = result.options.find((entry) => entry.label === "figure")!;
    expect(typeof option.apply).toBe("function");
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
    (option.apply as Exclude<Completion["apply"], string | undefined>)(view, option, result.from, to);
    expect(state.doc.toString()).toBe(String.raw`\end{figure}`);
  });

  it("keeps command menus free of descriptive text", () => {
    expect(complete(String.raw`\noind`)?.options.find((entry) => entry.label === "\\noindent")?.detail).toBeUndefined();
  });

  it("does not complete inside literal source, but resumes after an inline percent delimiter", () => {
    expect(complete(String.raw`\begin{lstlisting}
\noind`)).toBeNull();
    expect(complete(String.raw`\begin{alltt}
\noind`)).toBeNull();
    expect(complete(String.raw`\verb|%| \noind`)?.options.some((entry) => entry.label === "\\noindent")).toBe(true);
  });

  it("builds local command snippets with optional arguments and ignores literal examples", () => {
    const source = String.raw`\newcommand{\note}[2][blue]{#2}
\NewDocumentCommand{\demo}{O{red} m}{#2}
\begin{verbatim}
\newcommand{\fake}[1]{#1}
\end{verbatim}
\not`;
    let state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const result = latexCompletions(new CompletionContext(state, state.doc.length, true), t, index)!;
    const note = result.options.find((entry) => entry.label === "\\note")!;
    expect(result.options.some((entry) => entry.label === "\\fake")).toBe(false);
    expect(typeof note.apply).toBe("function");
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
    (note.apply as Exclude<Completion["apply"], string | undefined>)(view, note, result.from, state.doc.length);
    expect(state.doc.toString()).toBe(source.slice(0, source.lastIndexOf("\\not")) + String.raw`\note[]{}`);

    const demoSource = source.slice(0, source.lastIndexOf("\\not")) + String.raw`\dem`;
    state = EditorState.create({ doc: demoSource, extensions: [latexLanguage] });
    const demoResult = latexCompletions(new CompletionContext(state, state.doc.length, true), t, index)!;
    const demo = demoResult.options.find((entry) => entry.label === "\\demo")!;
    (demo.apply as Exclude<Completion["apply"], string | undefined>)(view, demo, demoResult.from, state.doc.length);
    expect(state.doc.toString()).toBe(demoSource.slice(0, demoSource.lastIndexOf("\\dem")) + String.raw`\demo[]{}`);
  });

  it("does not flatten the full document for symbol extraction while typing prose", () => {
    const state = EditorState.create({ doc: "Ordinary prose without a completion context." });
    const flatten = vi.spyOn(state.doc, "toString");
    expect(latexCompletions(new CompletionContext(state, state.doc.length, false), t, index)).toBeNull();
    expect(flatten).not.toHaveBeenCalled();
    flatten.mockRestore();
  });
});
