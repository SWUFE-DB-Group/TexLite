import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { latexLanguage } from "../src/client/latex";
import { latexHighlightStyle, latexSemanticDecorations } from "../src/client/latex/highlighting";
import { literalEnvironmentNames } from "../src/shared/latexLiterals";

function fixture(source: string, anchor = 0, head = anchor) {
  const state = EditorState.create({ doc: source, selection: { anchor, head }, extensions: [latexLanguage] });
  const tree = ensureSyntaxTree(state, source.length, 200)!;
  expect(tree).not.toBeNull();
  const syntax: Array<{ from: number; to: number; classes: string }> = [];
  highlightTree(tree, latexHighlightStyle, (from, to, classes) => syntax.push({ from, to, classes }));
  const classesAt = (offset: number) => syntax.filter((range) => range.from <= offset && range.to > offset).flatMap((range) => range.classes.split(" "));
  const marks = (visible = [{ from: 0, to: source.length }]) => {
    const result: Array<{ from: number; to: number; class: string }> = [];
    latexSemanticDecorations(state, visible, tree).between(0, source.length, (from, to, value) => {
      result.push({ from, to, class: value.spec.class });
    });
    return result;
  };
  return { state, classesAt, marks };
}

describe("semantic LaTeX palette", () => {
  it.each(["document", "table", "tabular", "itemize", "figure", "align", "custom_env:1"])("uses the same environment style for %s", (name) => {
    const source = `\\begin{${name}}\ncontent\n\\end{${name}}`;
    const { classesAt } = fixture(source);
    expect(classesAt(source.indexOf(name))).toContain("cm-tl-environment");
    expect(classesAt(source.lastIndexOf(name))).toContain("cm-tl-environment");
    expect(classesAt(0)).toContain("cm-tl-structure");
    expect(classesAt(source.indexOf("{"))).toContain("cm-tl-bracket");
  });

  it("distinguishes structural commands and headings without coloring ordinary prose or sizes", () => {
    const source = String.raw`\documentclass{article} \usepackage{amsmath}
\section{中文 Introduction \textbf{heading}}
\textbf{正文} \item \centering \arraystretch 1.2 5pt`;
    const { classesAt } = fixture(source);
    expect(classesAt(source.indexOf("\\section"))).toContain("cm-tl-structure");
    expect(classesAt(source.indexOf("\\documentclass"))).toEqual(["cm-tl-structure"]);
    for (const command of ["usepackage", "textbf", "item", "centering", "arraystretch"]) {
      expect(classesAt(source.lastIndexOf(`\\${command}`))).toEqual(["cm-tl-command"]);
    }
    expect(classesAt(source.indexOf("中文"))).toContain("cm-tl-heading");
    expect(classesAt(source.indexOf("正文"))).toEqual([]);
    expect(classesAt(source.indexOf("1.2"))).toEqual([]);
    expect(classesAt(source.indexOf("5pt"))).toEqual([]);
  });

  it.each(["usepackage", "input", "include"])("keeps configuration and inclusion command %s at ordinary weight", (command) => {
    const source = `\\${command}{example}`;
    expect(fixture(source).classesAt(0)).toEqual(["cm-tl-command"]);
  });

  it("treats documentclass as a document-start landmark without emphasizing adjacent preamble commands", () => {
    const source = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath} \usepackage{natbib} \newcommand{\sys}{System}`;
    const { classesAt } = fixture(source);
    expect(classesAt(0)).toEqual(["cm-tl-structure"]);
    for (const command of ["usepackage", "newcommand"]) {
      expect(classesAt(source.indexOf(`\\${command}`))).toEqual(["cm-tl-command"]);
    }
  });

  it.each(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"])("emphasizes the sectioning command %s", (command) => {
    const source = `\\${command}{Heading}`;
    expect(fixture(source).classesAt(0)).toEqual(["cm-tl-structure"]);
  });

  it("gives citation and label keys the same style, separate from their braces", () => {
    const source = String.raw`\citep[see]{smith,jones} \ref{sec:test} \label{sec:test}`;
    const { classesAt } = fixture(source);
    for (const key of ["smith", "jones", "sec:test"]) {
      expect(classesAt(source.indexOf(key))).toContain("cm-tl-key");
    }
    expect(classesAt(source.lastIndexOf("sec:test"))).toContain("cm-tl-key");
    expect(classesAt(source.indexOf("{smith"))).toEqual(["cm-tl-bracket"]);
  });

  it.each(["cite", "citep", "citet", "ref", "pageref", "eqref", "autoref", "cref", "Cref", "label"])("styles only the key of %s distinctly, not the command", (command) => {
    const source = `\\${command}{key} \\textbf{text}`;
    const { classesAt } = fixture(source);
    expect(classesAt(0)).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("key"))).toContain("cm-tl-key");
    expect(classesAt(source.indexOf("\\textbf"))).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("{"))).toEqual(["cm-tl-bracket"]);
  });

  it("keeps declared command names in the ordinary command style and declared environment names in the environment style", () => {
    const source = String.raw`\newcommand{\sys}{A} \renewcommand{\arraystretch}{1.2}
\newenvironment{custom}{before}{after} \renewenvironment{other}{before}{after}`;
    const { classesAt } = fixture(source);
    expect(classesAt(source.indexOf("\\sys"))).toContain("cm-tl-command");
    expect(classesAt(source.indexOf("\\arraystretch"))).toContain("cm-tl-command");
    expect(classesAt(source.indexOf("custom"))).toContain("cm-tl-environment");
    expect(classesAt(source.indexOf("other"))).toContain("cm-tl-environment");
    expect(classesAt(source.indexOf("1.2"))).toEqual([]);
  });

  it.each([String.raw`&`, String.raw`\\`, "~", String.raw`\%`, String.raw`\_`])("uses the special-character style for %s", (symbol) => {
    const source = `Text ${symbol} text`;
    expect(fixture(source).classesAt(source.indexOf(symbol))).toContain("cm-tl-special");
  });

  it.each([
    [String.raw`40.16\% remains text.`, false],
    [String.raw`\\% comment with { $ \ref{ignored}`, true],
    [String.raw`%\\ entire commented-out line`, true],
    [String.raw`\\\% remains text.`, false]
  ])("keeps escaped percent signs and real comments visually distinct: %s", (line, isComment) => {
    const source = `${line}\n\\textbf{after}`;
    const { classesAt, marks } = fixture(source);
    const percent = source.indexOf("%");
    expect(classesAt(percent)).toEqual([isComment ? "cm-tl-comment" : "cm-tl-special"]);
    expect(classesAt(source.indexOf("\\textbf"))).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("after"))).toEqual([]);
    expect(marks().some((range) => range.class === "cm-tl-math-command")).toBe(false);
  });

  it.each([String.raw`\verb|%|`, String.raw`\verb*|% { $|`, String.raw`\lstinline|%|`])("keeps percent signs literal in %s and resumes comments after it", (literal) => {
    const source = `${literal} % actual comment\n\\textbf{after}`;
    const { classesAt } = fixture(source);
    expect(classesAt(source.indexOf("%"))).toEqual(["cm-tl-literal"]);
    expect(classesAt(source.lastIndexOf("%"))).toEqual(["cm-tl-comment"]);
    expect(classesAt(source.indexOf("after"))).toEqual([]);
  });

  it.each(["$x + \\alpha + 1$", "$$x + \\alpha + 1$$", String.raw`\(x + \alpha + 1\)`, String.raw`\[x + \alpha + 1\]`])("colors math commands and delimiters without decorating the whole region: %s", (math) => {
    const source = `Before ${math} after`;
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf(math))).toContain("cm-tl-math-delimiter");
    expect(classesAt(source.indexOf("x +"))).toEqual([]);
    expect(classesAt(source.indexOf("1"))).toEqual([]);
    expect(marks()).toEqual([{ from: source.indexOf("\\alpha"), to: source.indexOf("\\alpha") + 6, class: "cm-tl-math-command" }]);
    expect(classesAt(source.indexOf("after"))).toEqual([]);
  });

  it("keeps prose commands ordinary and special characters distinct inside math environments", () => {
    const source = String.raw`\begin{align}
x &= \frac{a}{\sqrt{b}} + \text{a \textbf{word}} \\
\end{align}`;
    const { classesAt, marks } = fixture(source);
    const decorations = marks();
    expect(decorations.every((range) => ["cm-tl-math-command", "cm-tl-environment-match"].includes(range.class))).toBe(true);
    expect(classesAt(source.indexOf("align"))).toContain("cm-tl-environment");
    expect(classesAt(source.indexOf("&"))).toContain("cm-tl-special");
    const commands = decorations.filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to));
    expect(commands).toContain(String.raw`\frac`);
    expect(commands).toContain(String.raw`\sqrt`);
    expect(commands).not.toContain(String.raw`\textbf`);
  });

  it.each([
    [String.raw`\langle`, String.raw`\rangle`], [String.raw`\lVert`, String.raw`\rVert`],
    [String.raw`\lfloor`, String.raw`\rfloor`], ["(", ")"]
  ])("colors paired mathematical delimiters %s and %s", (opening, closing) => {
    const source = `$\\left${opening} x \\right${closing}$`;
    const { classesAt } = fixture(source);
    expect(classesAt(source.indexOf(opening))).toContain("cm-tl-math-delimiter");
    expect(classesAt(source.indexOf(closing))).toContain("cm-tl-math-delimiter");
    expect(classesAt(source.indexOf(" x ") + 1)).toEqual([]);
  });

  it("keeps multiline headings and spaced prose commands semantically highlighted", () => {
    const source = "\\section\n{Heading}\n$\\textbf {word} + \\alpha$";
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf("Heading"))).toContain("cm-tl-heading");
    expect(classesAt(source.indexOf("\\textbf"))).toEqual(["cm-tl-command"]);
    expect(marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to))).toEqual([String.raw`\alpha`]);
  });

  it("keeps starred math tags as prose, including nested text commands after spacing", () => {
    const source = String.raw`\begin{equation}
x + \alpha \tag* {\textbf{A}}
\end{equation}`;
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf("\\tag"))).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("\\textbf"))).toEqual(["cm-tl-command"]);
    expect(marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to)))
      .toEqual([String.raw`\alpha`]);
  });

  it.each([
    ["label", "{eq:test}"], ["thlabel", "{eq:test}"], ["ref", "{eq:test}"],
    ["eqref", "{eq:test}"], ["citep", "{paper}"], ["smartcite", "{paper}"],
    ["myref", "{eq:test}"], ["hyperref", "[eq:test]{caption}"],
    ["text", "{ordinary text}"], ["textrm", "{ordinary text}"], ["textbf", "{ordinary text}"],
    ["mbox", "{ordinary text}"], ["tag", "{A}"], ["notag", ""], ["nonumber", ""],
    ["color", "{red}"], ["textcolor", "{red}{x}"], ["hspace", "{1em}"], ["setlength", "{\\mylen}{1em}"]
  ])("retains ordinary styling for non-math command %s inside equation", (command, argument) => {
    const source = `\\begin{equation}\nx + \\alpha \\${command}${argument}\n\\end{equation}`;
    const { classesAt, marks } = fixture(source);
    const start = source.indexOf(`\\${command}`);
    expect(classesAt(start)).toEqual(["cm-tl-command"]);
    expect(marks().some((range) => range.class === "cm-tl-math-command" && range.from <= start && range.to > start)).toBe(false);
    expect(marks().some((range) => range.class === "cm-tl-math-command" && source.slice(range.from, range.to) === String.raw`\alpha`)).toBe(true);
  });

  it.each(["frac", "sqrt", "alpha", "sum", "mathbf", "mathrm", "mathcal", "operatorname", "quad", "underline", "custommath"])("keeps mathematical command %s purple in a math expression", (command) => {
    const source = `$\\${command}{x}$`;
    expect(fixture(source).marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to))).toContain(`\\${command}`);
  });

  it("keeps equation label keys distinct and allows nested math inside text", () => {
    const source = String.raw`\begin{equation}
\text{value $\alpha$} + \frac{a}{b} \label{eq:test}
\end{equation}`;
    const { classesAt, marks } = fixture(source);
    const commands = marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to));
    expect(commands).toEqual([String.raw`\alpha`, String.raw`\frac`]);
    expect(classesAt(source.indexOf("eq:test"))).toContain("cm-tl-key");
    expect(classesAt(source.indexOf("\\label"))).toEqual(["cm-tl-command"]);
  });

  it.each(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"])("does not give font-size declaration %s a math accent", (command) => {
    const source = `$\\${command} \\alpha$`;
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf(`\\${command}`))).toEqual(["cm-tl-command"]);
    expect(marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to))).toEqual([String.raw`\alpha`]);
  });

  it("keeps size and label declarations ordinary but math fonts and scalable fences purple in the POR equation", () => {
    const source = String.raw`\begin{equation}
\small
\mathrm{POR} =
P\left(
\mathcal{M}(q_i,\{I_i^p\})\sim a_i^{adv}
\mid
\mathcal{M}(q_i)\sim a_i
\right).
\label{eq:por}
\end{equation}`;
    const { classesAt, marks } = fixture(source);
    const commands = marks().filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to));
    expect(commands).toEqual([String.raw`\mathrm`, String.raw`\left`, String.raw`\mathcal`, String.raw`\sim`, String.raw`\mid`, String.raw`\mathcal`, String.raw`\sim`, String.raw`\right`]);
    expect(classesAt(source.indexOf("\\small"))).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("\\label"))).toEqual(["cm-tl-command"]);
    expect(classesAt(source.indexOf("eq:por"))).toContain("cm-tl-key");
  });

  it.each(literalEnvironmentNames)("keeps %s raw, with no math or task decorations", (name) => {
    const source = `\\begin{${name}}\n$ \\alpha % TODO { \\cite{key}\n\\end{${name}}\nNormal text.`;
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf("$"))).toContain("cm-tl-literal");
    expect(classesAt(source.indexOf("%"))).toEqual(["cm-tl-literal"]);
    expect(marks().every((range) => range.class === "cm-tl-environment-match")).toBe(true);
    expect(classesAt(source.indexOf("Normal"))).toEqual([]);
  });

  it("highlights TODO/FIXME only in comments and confines reads and marks to visible ranges", () => {
    const source = `TODO outside. % TODO 中文 FIXME NOTODO FIXMEX ${"x".repeat(10_000)}\nNormal text.`;
    const { state, classesAt, marks } = fixture(source);
    const start = source.indexOf("% TODO");
    expect(classesAt(start + 2)).toContain("cm-tl-comment");
    const slice = vi.spyOn(state, "sliceDoc");
    const visible = { from: start + 1, to: start + 32 };
    const ranges = marks([visible]);
    expect(ranges.map((range) => source.slice(range.from, range.to))).toEqual(["TODO", "FIXME"]);
    expect(slice.mock.calls.every(([from, to]) => Number(to) - Number(from) <= 33)).toBe(true);
    slice.mockRestore();
  });

  it("decorates a viewport in the middle of a multiline equation without copying the document", () => {
    const source = `\\[\n${"x + 1\n".repeat(100)}\\alpha\n\\]\nNormal`;
    const { state, marks } = fixture(source);
    const from = source.indexOf("\\alpha");
    const toString = vi.spyOn(state.doc, "toString");
    const ranges = marks([{ from, to: from + 6 }]);
    expect(ranges).toEqual([{ from, to: from + 6, class: "cm-tl-math-command" }]);
    expect(toString).not.toHaveBeenCalled();
    toString.mockRestore();
  });

  it("accents only the innermost environment pair, excluding begin options and column specifications", () => {
    const source = String.raw`\begin{table}
\begin{tabular}[t]{ll}a & b\\\end{tabular}
\end{table}`;
    for (const anchor of [source.indexOf("tabular") + 2, source.lastIndexOf("tabular") + 2]) {
      const ranges = fixture(source, anchor).marks().filter((range) => range.class === "cm-tl-environment-match");
      expect(ranges.map((range) => source.slice(range.from, range.to))).toEqual([String.raw`\begin{tabular}`, String.raw`\end{tabular}`]);
    }
    expect(fixture(source, source.indexOf("a &")).marks().filter((range) => range.class === "cm-tl-environment-match")).toEqual([]);
  });

  it.each([String.raw`\begin{custom}x`, String.raw`\begin{custom}x\end{other}`, String.raw`\verb|\begin{custom}|`, "% \\begin{custom}"])("does not accent inferred, mismatched or literal environment markers: %s", (source) => {
    expect(fixture(source, source.indexOf("custom") + 1).marks()).toEqual([]);
  });

  it("keeps environment pairing cursor-local, bounded and suppressed during selection", () => {
    const source = "\\begin% comment\n{custom_env:1}\nx\n\\end { custom_env:1 }";
    const { state, marks } = fixture(source, source.indexOf("custom") + 1);
    const slice = vi.spyOn(state, "sliceDoc");
    const viewport = { from: 0, to: source.indexOf("\nx") };
    expect(marks([viewport]).map((range) => source.slice(range.from, range.to))).toEqual(["\\begin% comment\n{custom_env:1}"]);
    expect(slice.mock.calls.every(([from, to]) => Number(to) - Number(from) <= 256)).toBe(true);
    slice.mockRestore();
    expect(fixture(source, 0, source.indexOf("\nx")).marks().filter((range) => range.class === "cm-tl-environment-match")).toEqual([]);
  });
});
