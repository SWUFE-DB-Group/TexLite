import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, foldable, getIndentation, matchBrackets, syntaxTree } from "@codemirror/language";
import { TreeFragment, type SyntaxNode, type Tree } from "@lezer/common";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { latexLanguage } from "../src/client/latex";
import { parser } from "../src/client/latex/latex.mjs";
import { literalEnvironmentNames } from "../src/shared/latexLiterals";

const article = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,graphicx,natbib}
\newcommand{\sys}[1]{\textbf{#1}}
\begin{document}
\section{Introduction}
We study $x_i^2$ and \citep[see][p. 5]{smith2024,jones2025}.
\label{sec:intro}
\subsection{Approach}
\begin{align}
  x &= \frac{a}{b} \\
  y &= \left( x+1 \right)
\end{align}
\begin{figure}[htbp]
  \includegraphics[width=\linewidth]{images/test.pdf}
  \caption{A result.}
\end{figure}
\begin{itemize}
  \item First result.
  \item Second result.
\end{itemize}
\section{Conclusion}
See \ref{sec:intro} and \url{https://example.com/}.
\end{document}`;

function nodes(tree: Tree) {
  const result: Array<{ name: string; from: number; to: number }> = [];
  tree.iterate({ enter: (node) => { result.push({ name: node.name, from: node.from, to: node.to }); } });
  return result;
}

function parseWithoutErrors(source: string) {
  const tree = parser.parse(source);
  const errors: number[] = [];
  tree.iterate({ enter: (node) => { if (node.type.isError) errors.push(node.from); } });
  expect(errors, source).toEqual([]);
  return tree;
}

function stateFor(source: string) {
  const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
  expect(ensureSyntaxTree(state, state.doc.length, 200)).not.toBeNull();
  return state;
}

function styles(source: string) {
  const state = stateFor(source);
  const ranges: Array<{ from: number; to: number; style: string }> = [];
  highlightTree(syntaxTree(state), tagHighlighter([
    { tag: tags.tagName, class: "command" }, { tag: tags.keyword, class: "keyword" },
    { tag: tags.string, class: "literal" }, { tag: tags.comment, class: "comment" },
    { tag: tags.brace, class: "brace" }, { tag: tags.attributeValue, class: "argument" }
  ]), (from, to, style) => ranges.push({ from, to, style }));
  return ranges;
}

describe("structural LaTeX parser", () => {
  it.each([
    "\\documentclass\n{article}", "\\usepackage\n{amsmath}", "\\usepackage[opt]\n{amsmath}",
    "\\textbf {bold}", "\\textit\n{italic}", "\\texttt {code}", "\\emph\n{emphasis}",
    "\\include \n{chapter}", "\\input\n{chapter}",
    "\\newcommand*{\\mycmd}[1]{#1}", "\\renewcommand*{\\mycmd}[1]{#1}",
    "\\newcommand*\n{\\mycmd}\n[2]\n[default]\n{#1 #2}",
    "\\def\\mycmd #1 #2\n{#1 #2}",
    "\\newenvironment*{custom}{\\begin{itemize}}{\\end{itemize}}",
    "\\renewenvironment*{custom}{\\begin{itemize}}{\\end{itemize}}"
  ])("accepts common whitespace and starred command forms: %s", (source) => {
    parseWithoutErrors(source + "\nNormal prose.");
  });

  it.each([
    ["\\includegraphics[width=\\linewidth]\n{images/test.pdf}", "IncludeGraphics", "IncludeGraphicsArgument", "{images/test.pdf}"],
    ["\\includegraphics[width=\\linewidth] % option comment\n  {images/test.pdf}", "IncludeGraphics", "IncludeGraphicsArgument", "{images/test.pdf}"],
    ["\\includesvg[width=\\linewidth]\n{images/test.svg}", "IncludeSvg", "IncludeSvgArgument", "{images/test.svg}"],
    ["\\caption[Short] {A long caption}", "Caption", "TextArgument", "{A long caption}"],
    ["\\caption[Short]% caption comment\n {A long caption}", "Caption", "TextArgument", "{A long caption}"],
    ["\\caption*\n{An unnumbered caption}", "Caption", "TextArgument", "{An unnumbered caption}"],
    ["\\title[Short]\n{A long title}", "Title", "TextArgument", "{A long title}"],
    ["\\title[Short] % title comment\n {A long title}", "Title", "TextArgument", "{A long title}"],
    ["$x \\tag* {A}$", "MathTextCommand", "TextArgument", "{A}"],
    ["\\begin{equation}\nx \\tag*% tag comment\n {A}\n\\end{equation}", "MathTextCommand", "TextArgument", "{A}"]
  ])("keeps spaced arguments inside their owning command: %s", (source, command, argument, expected) => {
    const tree = parseWithoutErrors(source + "\nNormal prose.");
    const argumentsWithOwner = nodes(tree).filter((node) => node.name === argument && source.slice(node.from, node.to) === expected);
    expect(argumentsWithOwner).toHaveLength(1);
    const owner = tree.resolveInner(argumentsWithOwner[0]!.from + 1);
    let found = false;
    for (let node: SyntaxNode | null = owner; node; node = node.parent) {
      if (node.name === command) found = true;
    }
    expect(found).toBe(true);
    expect(tree.resolveInner(source.length + 2).name).toBe("Normal");
  });

  it.each([" ", "\n", " % alias comment\n  "])("accepts whitespace before the target of let: %j", (spacing) => {
    const source = `\\let${spacing}\\original=\\replacement\nNormal prose.`;
    const tree = parseWithoutErrors(source);
    const aliases = nodes(tree).filter((node) => node.name === "Let");
    expect(aliases).toHaveLength(1);
    expect(source.slice(aliases[0]!.from, aliases[0]!.to)).toBe(source.slice(0, source.indexOf("\nNormal")));
    expect(nodes(tree).filter((node) => node.name === "Csname").map((node) => source.slice(node.from, node.to)))
      .toEqual([String.raw`\original`, String.raw`\replacement`]);
  });

  it("preserves a multiline section title when folding its contents", () => {
    const source = "\\section\n{Heading}\nParagraph.\n\\section{Next}\nText.";
    const tree = parseWithoutErrors(source);
    expect(nodes(tree).some((node) => node.name === "SectioningArgument" && source.slice(node.from, node.to) === "{Heading}")).toBe(true);
    const state = stateFor(source);
    expect(foldable(state, 0, state.doc.line(1).to)).toBeNull();
    const fold = foldable(state, state.doc.line(2).from, state.doc.line(2).to);
    expect(fold).toMatchObject({ from: state.doc.line(2).to, to: state.doc.line(4).from - 1 });
  });

  it("keeps starred definitions as fragments and matches their outer braces", () => {
    const source = "\\newcommand*{\\openmath}{$}\n\\newenvironment*{custom}{\\begin{itemize}}{\\end{itemize}}\nNormal prose.";
    const tree = parseWithoutErrors(source);
    expect(nodes(tree).filter((node) => node.name === "DefinitionArgument")).toHaveLength(3);
    expect(nodes(tree).some((node) => node.name === "DollarMath" || node.name === "ListEnvironment")).toBe(false);
    const state = stateFor(source);
    const closing = source.indexOf("}\nNormal");
    const opening = source.indexOf("{\\end");
    expect(matchBrackets(state, closing + 1, -1)).toMatchObject({ matched: true, end: { from: opening, to: opening + 1 } });
  });

  it.each(["\t", "\r\n", "% file comment\n"])("ends an unbraced input path at %j without swallowing the next command", (separator) => {
    const source = `\\input foo.tex${separator}\\section{Heading}\nText.`;
    const tree = parseWithoutErrors(source);
    const entries = nodes(tree);
    const path = entries.find((node) => node.name === "SpaceDelimitedLiteralArgContent")!;
    expect(source.slice(path.from, path.to)).toBe("foo.tex");
    expect(entries.some((node) => node.name === "Section")).toBe(true);
    if (separator.startsWith("%")) expect(entries.some((node) => node.name === "Comment")).toBe(true);
  });

  it("folds environment names with comments by their parsed name, not their raw group text", () => {
    const source = "\\begin{figure% name\n}\nbody\n\\end{figure% close\n}";
    parseWithoutErrors(source);
    const state = stateFor(source);
    expect(foldable(state, state.doc.line(2).from, state.doc.line(2).to)).toMatchObject({ from: state.doc.line(2).to, to: state.doc.line(4).from });
    const mismatched = stateFor("\\begin{figure% name\n}\nbody\n\\end{table}");
    expect(foldable(mismatched, 0, mismatched.doc.line(1).to)).toBeNull();
  });

  it("parses an ordinary paper and exposes command, argument, math, environment and section nodes", () => {
    const names = new Set(nodes(parseWithoutErrors(article)).map((node) => node.name));
    for (const name of ["DocumentClassArgument", "PackageArgument", "BibKeyArgument", "RefArgument", "Math", "Section", "SubSection", "FigureEnvironment", "ListEnvironment", "DefinitionArgument"]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it.each(literalEnvironmentNames)("keeps %s opaque and resumes normal prose after its close", (name) => {
    const source = `\\begin{${name}}\n$ % { \\begin{figure}\n\\end{${name}}\nNormal prose \\textbf{after}`;
    const tree = parseWithoutErrors(source);
    expect(tree.resolveInner(source.indexOf("Normal") + 1).name).toBe("Normal");
    const highlighted = styles(source);
    expect(highlighted.some((range) => range.style === "literal" && range.from <= source.indexOf("$") && range.to > source.indexOf("$"))).toBe(true);
    expect(highlighted.some((range) => range.from < source.indexOf("Normal") + 12 && range.to > source.indexOf("Normal"))).toBe(false);
  });

  it.each([
    String.raw`\verb|$ % {}|`, String.raw`\verb*|$ % {}|`, String.raw`\verb{literal{`,
    String.raw`\lstinline{a{b}c}`, String.raw`\lstinline[language=C]{value \{ nested \}}`,
    String.raw`\lstinline*[language=C]|x $ y|`, String.raw`\Verb[formatcom=\color{red}]{a{b}c}`,
    String.raw`\mintinline{python}{print("$")}`,
    String.raw`\mintinline[breaklines]{python}|x $ % y|`
  ])("preserves inline literal boundaries: %s", (literal) => {
    const source = `${literal} Normal prose \\textbf{after}`;
    const tree = parseWithoutErrors(source);
    expect(tree.resolveInner(source.indexOf("Normal") + 1).name).toBe("Normal");
  });

  it("ends unfinished inline literals at the newline without corrupting following prose", () => {
    for (const opening of [String.raw`\verb|$`, String.raw`\lstinline{x $`, String.raw`\mintinline{python}|$`]) {
      const source = `${opening}\nNormal prose`;
      expect(parser.parse(source).resolveInner(source.indexOf("Normal") + 1).name).toBe("Normal");
    }
  });

  it("recognizes spaced environment commands and compatible names", () => {
    for (const name of ["figure", "custom_env:1", "alltt", "verbatim*"]) {
      const source = `\\begin { ${name} }\ncontent\n\\end { ${name} }`;
      parseWithoutErrors(source);
      const state = stateFor(source);
      expect(foldable(state, 0, state.doc.line(1).to)).toMatchObject({ to: state.doc.line(3).from });
    }
    const multiline = "\\begin\n{alltt}\n$ % raw\n\\end\n{alltt}\nNormal prose";
    const tree = parseWithoutErrors(multiline);
    expect(tree.resolveInner(multiline.indexOf("Normal") + 1).name).toBe("Normal");
    parseWithoutErrors("\\begin% comment\n{verbatim}\n$\n\\end{verbatim}");
  });

  it("highlights entire commands, comments and braces without swallowing math subscripts", () => {
    const source = String.raw`\makeatletter \foo@bar \cs_new:Npn #1 {#1} $\alpha_x$ 100% comment $`;
    const tree = parseWithoutErrors(source);
    const tokens = nodes(tree).filter((node) => node.name === "CtrlSeq").map((node) => source.slice(node.from, node.to));
    expect(tokens).toContain(String.raw`\foo@bar`);
    expect(tokens).toContain(String.raw`\cs_new:Npn`);
    expect(tokens).toContain(String.raw`\alpha`);
    expect(tokens).not.toContain(String.raw`\alpha_x`);
    const colors = styles(source);
    expect(colors.some((range) => range.style === "comment" && source.slice(range.from, range.to).startsWith("%"))).toBe(true);
    expect(colors.some((range) => range.style === "brace" && source.slice(range.from, range.to) === "{")).toBe(true);
  });

  it("folds nested environments and sections using the tree, without a scanning fold service", () => {
    const source = "\\section{One}\nParagraph.\n\\subsection{Nested}\nMore text.\n\\section{Two}\nLast text.";
    const state = stateFor(source);
    expect(foldable(state, 0, state.doc.line(1).to)).toMatchObject({ to: state.doc.line(5).from - 1 });
    for (const whitespace of ["\n  ", "\n\n  ", "% trailing comment\n  "]) {
      const indented = stateFor(`\\section{One}\nText.${whitespace}\\section{Two}\nNext.`);
      const nextHeading = indented.doc.lineAt(indented.doc.toString().indexOf("\\section{Two}"));
      expect(foldable(indented, 0, indented.doc.line(1).to)).toMatchObject({ to: nextHeading.from - 1 });
    }
    const environments = stateFor("\\begin{figure}\n\\begin{center}\nx\n\\end{center}\n\\end{figure}");
    expect(foldable(environments, 0, environments.doc.line(1).to)).toMatchObject({ to: environments.doc.line(5).from });
    const commentedHeading = stateFor("\\section{One}% note\nText.\n\\section{Two}\nNext.");
    expect(foldable(commentedHeading, 0, commentedHeading.doc.line(1).to)).not.toBeNull();
    const commentedEnvironment = stateFor("\\begin{figure}% note\nText.\n\\end{figure}");
    expect(foldable(commentedEnvironment, 0, commentedEnvironment.doc.line(1).to)).toMatchObject({
      from: commentedEnvironment.doc.line(1).to, to: commentedEnvironment.doc.line(3).from
    });
    for (const incomplete of ["\\begin{figure}\ntext", "\\begin{custom}\ntext\n\\end{other}"]) {
      const unfinished = stateFor(incomplete);
      expect(foldable(unfinished, 0, unfinished.doc.line(1).to)).toBeNull();
    }
  });

  it("keeps typical style-file definitions parseable and highlights escaped percent signs correctly", () => {
    parseWithoutErrors(String.raw`\ProvidesPackage{example}
\makeatletter
\def\foo@bar#1{\textbf{#1}}
\newenvironment{custom}{\begin{quote}}{\end{quote}}
\cs_new:Npn \example_command:n #1 {#1}
\makeatother`);
    const source = "100\\% is text. % is a comment\nNormal text.";
    const colors = styles(source);
    const comments = colors.filter((range) => range.style === "comment");
    expect(comments).toHaveLength(1);
    expect(source.slice(comments[0]!.from, comments[0]!.to).trim()).toBe("% is a comment");
  });

  it.each([
    [String.raw`40.16\% remains text.`, ""],
    [String.raw`\\% comment with an unmatched } and $`, "% comment with an unmatched } and $"],
    [String.raw`%\\ an entirely commented-out line`, String.raw`%\\ an entirely commented-out line`],
    [String.raw`\\\% remains text.`, ""],
    [String.raw`\\\\% another comment {`, "% another comment {"]
  ])("respects percent escaping without corrupting the next line: %s", (line, expectedComment) => {
    const source = `${line}\n\\textbf{after}`;
    const tree = parseWithoutErrors(source);
    expect(nodes(tree).filter((node) => node.name === "Comment")
      .map((node) => source.slice(node.from, node.to).trimEnd()))
      .toEqual(expectedComment ? [expectedComment] : []);
    const state = stateFor(source);
    const opening = source.lastIndexOf("{");
    expect(matchBrackets(state, source.length, -1)).toMatchObject({ matched: true, end: { from: opening, to: opening + 1 } });
  });

  it("updates comment boundaries when a backslash is inserted and removed before a percent sign", () => {
    const source = "40.16\\% remains text\n\\textbf{after}";
    let state = stateFor(source);
    const slash = source.indexOf("\\");
    for (const changes of [{ from: slash, insert: "\\" }, { from: slash, to: slash + 1 }]) {
      state = state.update({ changes }).state;
      const tree = ensureSyntaxTree(state, state.doc.length, 200)!;
      expect(tree).not.toBeNull();
      expect(nodes(tree)).toEqual(nodes(parser.parse(state.doc.toString())));
      const comments = nodes(tree).filter((node) => node.name === "Comment");
      expect(comments).toHaveLength("insert" in changes ? 1 : 0);
      expect(tree.resolveInner(state.doc.toString().indexOf("after") + 1).name).toBe("Normal");
    }
  });

  it("keeps outer braces matchable across nested environments", () => {
    const source = String.raw`\resizebox{\linewidth}{!}{
\begin{tabular}{ll}
a & b \\
\end{tabular}
}`;
    const state = stateFor(source);
    expect(matchBrackets(state, source.length, -1)).toMatchObject({
      matched: true, end: { from: source.indexOf("{", source.indexOf("{!}") + 3) }
    });
    // No indentation policy is imported from Overleaf's application layers.
    expect(getIndentation(state, state.doc.line(3).from)).toBe(2);
  });

  it("matches fresh parse trees after deterministic insertions and deletions, including incomplete input", () => {
    // Mirrors the TreeFragment workflow in Overleaf's public
    // scripts/lezer-latex/test-incremental-parser.mjs, with deterministic
    // correctness assertions instead of timing-only measurements.
    let source = article + "\n" + article;
    let tree = parser.parse(source);
    let fragments = TreeFragment.addTree(tree);
    const edits = [String.raw`\begin{verbatim}`, "\n$ % raw\n", String.raw`\end{verbatim}`, String.raw`\citep{new}`, "{", "}", "$", "%", "\n", String.raw`\end {document}`, "\\newcommand*{\\foo}[1]{#1}", "\\section\n{Title}", "\\includegraphics[width=1cm]\n{image.pdf}", "\\title[Short]\n{Title}", "\\let \\old=\\new", "\\tag* {A}"];
    for (let index = 0; index < 70; index++) {
      const from = (index * 127 + 73) % source.length;
      const removed = index % 3 === 0 ? Math.min(3, source.length - from) : 0;
      const inserted = index % 3 === 0 ? "" : edits[index % edits.length]!;
      source = source.slice(0, from) + inserted + source.slice(from + removed);
      fragments = TreeFragment.applyChanges(fragments, [{ fromA: from, toA: from + removed, fromB: from, toB: from + inserted.length }], 0);
      tree = parser.parse(source, fragments);
      expect(nodes(tree), `edit ${index}`).toEqual(nodes(parser.parse(source)));
      fragments = TreeFragment.addTree(tree, fragments);
    }
  });

  it("recovers during character-by-character typing and returns the complete final structure", () => {
    for (const source of [String.raw`\begin{figure}\caption{A $x^2$ figure}\end{figure}`, String.raw`\newcommand{\foo}[1]{\textbf{#1}}`, String.raw`\citep[see]{first,second}`]) {
      for (let end = 0; end <= source.length; end++) {
        expect(parser.parse(source.slice(0, end)).length).toBe(end);
      }
      parseWithoutErrors(source);
    }
  });
});
