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

  it.each([
    String.raw`\bibliography{anthology, cust`,
    "\\bibliography{anthology,% another database\n  cust"
  ])("completes only the active bibliography file in %s", (source) => {
    const result = complete(source, true, {
      ...index, files: [{ label: "custom", kind: "text", detail: "Project file" }]
    })!;
    expect(result.from).toBe(source.lastIndexOf("cust"));
    expect(result.options.map((item) => item.label)).toContain("custom");
    expect(source.slice(0, result.from) + "custom").toBe(source.slice(0, -4) + "custom");
    expect(result.validFor.test("custom, next")).toBe(false);
    expect(result.validFor.test("custom% comment")).toBe(false);
    expect(result.validFor.test("custom")).toBe(true);
  });

  it("retains commas in ordinary file paths", () => {
    const source = String.raw`\input{first,second`;
    const result = complete(source)!;
    expect(result.from).toBe(source.indexOf("first"));
    expect(result.validFor.test("first,second")).toBe(true);
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

  it.each([
    [String.raw`\newcommand{\figlabel}[1]{\label{fig:#1}}
\label{fig:real}
\ref{`, "fig:real", "fig:#1"],
    [String.raw`\newcommand{\manual}[1]{\bibitem{manual:#1} Text}
\bibitem{manual:real} Text
\cite{`, "manual:real", "manual:#1"]
  ])("omits parameterized reference templates from editor completion", (source, realKey, templateKey) => {
    const options = complete(source)?.options.map((option) => option.label);
    expect(options).toContain(realKey);
    expect(options).not.toContain(templateKey);
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

  it.each(["includegraphics", "input", "include", "subfile", "bibliography", "addbibresource"])(
    "shows only paths, not redundant source descriptions, when completing %s", (command) => {
      const source = `\\input{chapters/prior.tex}\n\\${command}{fi`;
      const result = complete(source, true, {
        ...index,
        files: [{ label: "figures/result.pdf", kind: "text", detail: "Project file", source: "Project" }]
      })!;
      expect(result.options.map((entry) => entry.label)).toEqual(["chapters/prior.tex", "figures/result.pdf"]);
      expect(result.options.every((entry) => entry.detail === undefined)).toBe(true);
      expect(result.options.every((entry) => entry.type === "text")).toBe(true);
    }
  );

  it.each(["figure", "itemize", "equation"])("completes a partially typed end inside a known %s environment", (name) => {
    const partial = name.slice(0, 3);
    let state = EditorState.create({ doc: `\\begin{${name}}\nText\n\\end{${partial}}`, extensions: [latexLanguage] });
    const to = state.doc.length - 1;
    const result = latexCompletions(new CompletionContext(state, to, false), t, {
      ...index, environments: [{ label: name, kind: "keyword", detail: "Environment" }]
    })!;
    expect(result).not.toBeNull();
    const option = result.options.find((entry) => entry.label === name)!;
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
    (option.apply as Exclude<Completion["apply"], string | undefined>)(view, option, result.from, to);
    expect(state.doc.toString()).toBe(`\\begin{${name}}\nText\n\\end{${name}}`);
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

  it.each([
    [String.raw`\includegraphics[width={0.4\textwidth}]{fig`, "figure.png"],
    ["\\includegraphics[width={0.4\\textwidth}]\n{fig", "figure.png"],
    ["\\includegraphics[width={0.4\\textwidth}] % note\n  {fig", "figure.png"],
    [String.raw`\usepackage[opt={x[y]}]{amsmath, ams`, "amssymb"],
    [String.raw`\documentclass[opt={x[y]}]{arti`, "article"],
    [String.raw`\begin{fig`, "figure"]
  ])("preserves candidate sources with structural context in %s", (source, expected) => {
    expect(complete(source)?.options.map((option) => option.label)).toContain(expected);
  });

  it.each([String.raw`% comment \noind`, String.raw`\lstinline{\noind`, String.raw`\\noind`])(
    "does not offer command completions in %s", (source) => {
      expect(complete(source)).toBeNull();
    }
  );

  it("keeps math command completions available", () => {
    expect(complete(String.raw`$\alph`)?.options.some((option) => option.label === "\\alpha")).toBe(true);
  });

  it("invalidates cached key suggestions when a TeX comment begins", () => {
    for (const source of [String.raw`\cite{pap`, String.raw`\ref{fig`, String.raw`\usepackage{ams`]) {
      const result = complete(source)!;
      expect(result.validFor.test("word%")).toBe(false);
    }
    expect(complete("\\cite{pap% comment")).toBeNull();
  });

  it("updates cursor classification after editing without carrying an earlier comment context", () => {
    let state = EditorState.create({ doc: String.raw`% \noind`, extensions: [latexLanguage] });
    expect(latexCompletions(new CompletionContext(state, state.doc.length, true), t, index)).toBeNull();
    state = state.update({ changes: { from: 0, to: 2 } }).state;
    expect(latexCompletions(new CompletionContext(state, state.doc.length, true), t, index)?.options.some((entry) => entry.label === "\\noindent")).toBe(true);
  });
});
