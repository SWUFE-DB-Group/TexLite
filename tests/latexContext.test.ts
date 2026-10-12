import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { latexLanguage } from "../src/client/latex";
import { latexContextAt, MAX_LATEX_CONTEXT_LENGTH } from "../src/client/latex/context";
import { latexCompletionContext } from "../src/client/latexCompletionContexts";
import { literalEnvironmentNames } from "../src/shared/latexLiterals";

afterEach(() => vi.restoreAllMocks());

function fixture(marked: string) {
  const position = marked.indexOf("▮");
  if (position < 0) throw new Error("Missing cursor marker");
  const source = marked.replace("▮", "");
  const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
  expect(ensureSyntaxTree(state, state.doc.length, 300)).not.toBeNull();
  return { state, position, source };
}

describe("LaTeX cursor context", () => {
  it.each([
    [String.raw`\citep[see][p. 5]{one, tw▮}`, "citation", "tw"],
    [String.raw`\cites[see]{first}[p. 2]{seco▮}`, "citation", "seco"],
    [String.raw`\smartcite{pa▮}`, "citation", "pa"],
    [String.raw`\crefrange{fig:first}{fig:se▮}`, "label", "fig:se"],
    [String.raw`\hyperref[fig:se▮]{caption}`, "label", "fig:se"],
    [String.raw`\begin { fig▮}`, "environment", " fig"],
    [String.raw`\end{fig▮}`, "environment", "fig"],
    [String.raw`\begin{verbatim▮}`, "environment", "verbatim"],
    [String.raw`\includegraphics[width={0.4\textwidth}]{fi▮}`, "file", "fi"],
    [String.raw`\addbibresource[location=local]{ref▮}`, "file", "ref"],
    [String.raw`\bibliography{ref▮}`, "file", "ref"],
    [String.raw`\RequirePackage[opt={x[y]}]{amsmath, ams▮}`, "package", "ams"],
    [String.raw`\documentclass[11pt]{arti▮}`, "class", "arti"],
    ["\\usepackage% comment\n{amsmath,% another\n ams▮}", "package", "ams"],
    ["中文😀 \\cite{one,% note\n  tw▮}", "citation", "tw"]
  ])("identifies the active argument in %s", (marked, kind, query) => {
    const { state, source, position } = fixture(marked);
    const result = latexContextAt(state, position);
    expect(result.available).toBe(true);
    expect(result.argument).toMatchObject({ kind, query, from: position - query.length });
    expect(source[result.argument!.commandFrom]).toBe("\\");
  });

  it.each([
    ["% words▮\nText", "comment"], ["% words\n▮Text", "text"],
    [String.raw`\verb|x $|▮`, "text"], [String.raw`\verb*|x|▮`, "text"],
    ["\\verb|x $▮\nText", "literal"], [String.raw`\lstinline{{x}▮`, "literal"],
    [String.raw`\lstinline{{x}}▮`, "text"], [String.raw`\lstinline{%}▮`, "text"],
    [String.raw`\mintinline{python}{x}▮`, "text"],
    [String.raw`\begin{verbatim}▮`, "literal"],
    [String.raw`\begin{verbatim}raw\end{verbatim}▮`, "text"],
    [String.raw`\begin{verbatim}raw \end{verb▮`, "literal"],
    [String.raw`$x▮$`, "math"], [String.raw`$x$▮`, "text"],
    [String.raw`\[x▮\]`, "math"], [String.raw`\[x\]▮`, "text"],
    [String.raw`\begin{equation}▮\end{equation}`, "math"],
    [String.raw`\begin{equation}x▮\end{equation}`, "math"]
  ])("recognizes the region at %s", (marked, region) => {
    const { state, position } = fixture(marked);
    expect(latexContextAt(state, position).region).toBe(region);
  });

  it.each(literalEnvironmentNames)("suppresses argument context inside %s", (name) => {
    const { state, position } = fixture(`\\begin{${name}}\n\\cite{pap▮\n\\end{${name}}`);
    expect(latexContextAt(state, position)).toMatchObject({ available: true, region: "literal", argument: null });
  });

  it.each([
    String.raw`\\cite{paper▮}`, String.raw`\cite{first} {ordinary▮}`,
    String.raw`\cite{first} \textbf{ordinary▮}`, String.raw`\setcitestyle{round▮}`,
    String.raw`\usepackage{nested{value▮}}`, String.raw`\documentclass{article} {ordinary▮}`,
    String.raw`\includegraphics[width={0.4\textwidth▮}]{figure.png}`,
    String.raw`\cite{paper}▮`, String.raw`\hyperref[label]{ordinary▮}`
  ])("does not invent argument context in %s", (marked) => {
    const { state, position } = fixture(marked);
    expect(latexContextAt(state, position).argument).toBeNull();
  });

  it("uses the same immutable result for every check in one completion request", () => {
    const { state, position } = fixture(String.raw`\cite{pap▮}`);
    const context = new CompletionContext(state, position, true);
    const first = latexCompletionContext(context);
    const slice = vi.spyOn(state, "sliceDoc");
    expect(latexCompletionContext(context)).toBe(first);
    expect(slice).not.toHaveBeenCalled();
  });

  it("does not materialize a full document prefix to find a nearby argument", () => {
    const prefix = "Paragraph with ordinary prose.\n".repeat(4_000);
    const { state, position } = fixture(prefix + String.raw`\cites{first}[p. 2]{seco▮}`);
    const flatten = vi.spyOn(state.doc, "toString");
    const slice = vi.spyOn(state, "sliceDoc");
    expect(latexContextAt(state, position).argument).toMatchObject({ kind: "citation", query: "seco" });
    expect(flatten).not.toHaveBeenCalled();
    expect(slice.mock.calls.every(([from = 0, to = state.doc.length]) => to - from <= MAX_LATEX_CONTEXT_LENGTH)).toBe(true);
  });

  it("does not perform argument scans while typing ordinary prose", () => {
    const { state, position } = fixture("Paragraph.\n".repeat(4_000) + "Ordinary prose▮");
    const slice = vi.spyOn(state, "sliceDoc");
    expect(latexContextAt(state, position)).toMatchObject({ available: true, region: "text", argument: null });
    expect(slice).not.toHaveBeenCalled();
  });

  it("defers oversized standalone input instead of guessing its unparsed literal context", () => {
    const source = "\\begin{verbatim}\n" + "raw ".repeat(4_000) + "\\cite{pap";
    const state = EditorState.create({ doc: source });
    const slice = vi.spyOn(state, "sliceDoc");
    expect(latexContextAt(state, source.length)).toMatchObject({ available: false, region: "unknown", argument: null });
    expect(slice).not.toHaveBeenCalled();
  });
});
