import { describe, expect, it } from "vitest";
import {
  findLatexBibliographyFiles,
  findLatexCitationCompletion,
  findLatexLabelCompletion,
  findLatexReferenceDefinitions,
  findLatexReferences,
  findLatexSourceIncludes,
  latexReferenceAt,
  lineAndColumnAt
} from "../src/shared/latexReferences.js";

describe("LaTeX reference lexer", () => {
  it("finds individual citation and label keys while ignoring comments", () => {
    const source = String.raw`% \cite{ignored}
See \citep[see][p. 4]{smith2025, doe2024} and \cref{fig:result, tab:summary}.`;

    expect(findLatexReferences(source)).toEqual([
      expect.objectContaining({ kind: "citation", command: "citep", key: "smith2025" }),
      expect.objectContaining({ kind: "citation", command: "citep", key: "doe2024" }),
      expect.objectContaining({ kind: "label", command: "cref", key: "fig:result" }),
      expect.objectContaining({ kind: "label", command: "cref", key: "tab:summary" })
    ]);

    const keyOffset = source.indexOf("doe2024") + 2;
    expect(latexReferenceAt(source, keyOffset)).toMatchObject({ kind: "citation", key: "doe2024" });
    expect(latexReferenceAt(source, source.indexOf("doe2024") + "doe2024".length)).toBeNull();
  });

  it("treats comments between citation keys as trivia rather than part of a key", () => {
    const source = String.raw`\cite{paper,% an explanatory comment
  other}`;
    expect(findLatexReferences(source).map((reference) => reference.key)).toEqual(["paper", "other"]);
  });

  it("finds source labels, in-file bibliography items, and BibTeX definitions", () => {
    const source = String.raw`% \label{ignored}
\section{Result}\label{sec:result}
\begin{thebibliography}{1}
\bibitem[Manual]{manual2026} Manual entry.
\end{thebibliography}`;
    const labels = findLatexReferenceDefinitions(source, "label");
    const bibitems = findLatexReferenceDefinitions(source, "citation");
    const bibtex = findLatexReferenceDefinitions(String.raw`% @article{ignored,
@article{smith2025,
  title = {A paper}
}
@string{ignored = "not a citation"}`, "citation", true);

    expect(labels).toEqual([expect.objectContaining({ key: "sec:result", source: "label", command: "label" })]);
    expect(bibitems).toEqual([expect.objectContaining({ key: "manual2026", source: "bibitem", command: "bibitem" })]);
    expect(bibtex).toEqual([expect.objectContaining({ key: "smith2025", source: "bibtex", command: "bibtex" })]);
  });

  it("finds nested and multi-key commands without consuming their outer arguments", () => {
    const source = [
      "\\caption[See \\citep{nested}]{Text \\cite{caption}}",
      "\\citep[see \\cite{note}]{outer}",
      "\\crefrange{eq:first}{eq:last} \\Cref{fig:a, fig:b}",
      "\\cites[see]{alpha}[also]{beta,gamma}"
    ].join("\n");

    expect(findLatexReferences(source).map((reference) => [reference.kind, reference.command, reference.key])).toEqual([
      ["citation", "citep", "nested"],
      ["citation", "cite", "caption"],
      ["citation", "cite", "note"],
      ["citation", "citep", "outer"],
      ["label", "crefrange", "eq:first"],
      ["label", "crefrange", "eq:last"],
      ["label", "Cref", "fig:a"],
      ["label", "Cref", "fig:b"],
      ["citation", "cites", "alpha"],
      ["citation", "cites", "beta"],
      ["citation", "cites", "gamma"]
    ]);
  });

  it("does not treat citation-style configuration commands as citation keys", () => {
    const source = String.raw`\citestyle{authoryear}
\setcitestyle{round}
\AtEveryCite{\emph{setup}}
\DeclareCiteCommand{\smartcite}{}{}{}
\citetext{See \cite{nested-key}} and \citeauthor{author-key}.`;

    expect(findLatexReferences(source).map((reference) => [reference.command, reference.key])).toEqual([
      ["cite", "nested-key"],
      ["citeauthor", "author-key"]
    ]);
  });

  it("shares reference completion contexts with navigation", () => {
    const range = String.raw`\crefrange{fig:before}{fig:af`;
    const vpageref = String.raw`\vpageref[on the next page]{sec:res`;
    const hyperref = String.raw`\hyperref[tab:sum`;

    expect(findLatexLabelCompletion(range)).toEqual({
      from: range.lastIndexOf("fig:af"),
      query: "fig:af"
    });
    expect(findLatexLabelCompletion(vpageref)).toEqual({
      from: vpageref.lastIndexOf("sec:res"),
      query: "sec:res"
    });
    expect(findLatexLabelCompletion(hyperref)).toEqual({
      from: hyperref.lastIndexOf("tab:sum"),
      query: "tab:sum"
    });
    expect(findLatexLabelCompletion(String.raw`\href{https://example.test}`)).toBeNull();
  });

  it("does not offer citation completion for citation-style configuration commands", () => {
    expect(findLatexCitationCompletion(String.raw`\setcitestyle{auth`)).toBeNull();
    expect(findLatexCitationCompletion(String.raw`\citep{auth`)).toEqual({ from: 7, query: "auth" });
  });

  it("ignores reference-shaped text in comments and literal TeX forms", () => {
    const source = [
      "% \\cite{commented}",
      "\\verb|\\cite{inline}|",
      "\\lstinline|\\ref{listing}|",
      "\\begin{verbatim}",
      "\\cite{verbatim}",
      "\\label{verbatim-label}",
      "\\end{verbatim}",
      "\\begin{Verbatim}",
      "\\ref{fancyvrb}",
      "\\end{Verbatim}",
      "\\begin{minted}{tex}",
      "\\cite{minted}",
      "\\end{minted}",
      "\\cite{real}\\label{real-label}\\hyperref[real-label]{Jump}",
      "\\href{https://example.test}{not-a-label}"
    ].join("\n");

    expect(findLatexReferences(source).map((reference) => reference.key)).toEqual(["real", "real-label"]);
    expect(findLatexReferenceDefinitions(source, "label").map((definition) => definition.key)).toEqual(["real-label"]);
    expect(findLatexReferenceDefinitions([
      "@comment{ @article{fake, title = {Nope}} }",
      "@string{value = \"@article{alsofake, title = {Nope}}\"}",
      "@preamble{\"@book{preamblefake, title = {Nope}}\"}",
      "% @article{commented, title = {Nope}}",
      "@article{real, title = {A real entry}}"
    ].join("\n"), "citation", true).map((definition) => definition.key)).toEqual(["real"]);
  });

  it("keeps scanning BibTeX after quotes and percent signs inside braced values", () => {
    const source = [
      "% @article{top-level-comment, title = {Ignored}}",
      "@article{quoted-value,",
      "  title = {\"quoted},",
      "  url = {https://example.com/%20},",
      "}",
      "@article{after-braced-value, title = {Still visible}}",
      "@book(parenthesized,",
      "  title = {A title with ) and \"quotes},",
      "  note = \"A quoted ) value\"",
      ")"
    ].join("\n");

    expect(findLatexReferenceDefinitions(source, "citation", true).map((definition) => definition.key)).toEqual([
      "quoted-value",
      "after-braced-value",
      "parenthesized"
    ]);
  });

  it("uses TeX's raw inline verb delimiters before scanning later references", () => {
    const percentDelimiter = String.raw`\verb%literal% \cite{after-percent}`;
    const backslashBeforeDelimiter = String.raw`\verb|a\| \cite{after-pipe}`;
    expect(findLatexReferences(percentDelimiter).map((reference) => reference.key)).toEqual(["after-percent"]);
    expect(findLatexReferences(backslashBeforeDelimiter).map((reference) => reference.key)).toEqual(["after-pipe"]);
  });

  it("keeps literal-environment state across a long source prefix", () => {
    const source = [
      "\\begin{verbatim}",
      "x".repeat(4_096),
      "\\cite{not-a-reference}",
      "\\end{verbatim}",
      "\\cite{real-reference}"
    ].join("\n");

    expect(findLatexReferences(source).map((reference) => reference.key)).toEqual(["real-reference"]);
  });

  it("extracts source and bibliography dependencies from ordinary document commands", () => {
    const source = [
      "\\input{chapters/intro}",
      "\\import{appendix}{proof.tex}",
      "\\bibliography{references, extra}",
      "\\addbibresource[datatype=bibtex]{library.bib}"
    ].join("\n");

    expect(findLatexSourceIncludes(source).map((reference) => reference.path)).toEqual([
      "chapters/intro",
      "appendix/proof.tex"
    ]);
    expect(findLatexBibliographyFiles(source).map((reference) => reference.path)).toEqual([
      "references",
      "extra",
      "library.bib"
    ]);
  });

  it("uses one-based source positions for navigation", () => {
    expect(lineAndColumnAt("first\nsecond\nthird", 6)).toEqual({ line: 2, column: 1 });
    expect(lineAndColumnAt("first\nsecond\nthird", 999)).toEqual({ line: 3, column: 6 });
  });
});
