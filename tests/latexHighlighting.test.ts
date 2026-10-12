import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { latexLanguage } from "../src/client/latex";
import { latexHighlightStyle, latexSemanticDecorations } from "../src/client/latex/highlighting";
import { literalEnvironmentNames } from "../src/shared/latexLiterals";

function fixture(source: string) {
  const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
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
    for (const command of ["documentclass", "usepackage", "section"]) {
      expect(classesAt(source.indexOf(`\\${command}`))).toContain("cm-tl-structure");
    }
    for (const command of ["textbf", "item", "centering", "arraystretch"]) {
      expect(classesAt(source.lastIndexOf(`\\${command}`))).toContain("cm-tl-command");
    }
    expect(classesAt(source.indexOf("中文"))).toContain("cm-tl-heading");
    expect(classesAt(source.indexOf("正文"))).toEqual([]);
    expect(classesAt(source.indexOf("1.2"))).toEqual([]);
    expect(classesAt(source.indexOf("5pt"))).toEqual([]);
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

  it("keeps declared command names teal and declared environment names blue", () => {
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
    expect(decorations.every((range) => range.class === "cm-tl-math-command")).toBe(true);
    expect(classesAt(source.indexOf("align"))).toContain("cm-tl-environment");
    expect(classesAt(source.indexOf("&"))).toContain("cm-tl-special");
    const commands = decorations.filter((range) => range.class === "cm-tl-math-command").map((range) => source.slice(range.from, range.to));
    expect(commands).toContain(String.raw`\frac`);
    expect(commands).toContain(String.raw`\sqrt`);
    expect(commands).not.toContain(String.raw`\textbf`);
  });

  it.each(literalEnvironmentNames)("keeps %s raw, with no math or task decorations", (name) => {
    const source = `\\begin{${name}}\n$ \\alpha % TODO { \\cite{key}\n\\end{${name}}\nNormal text.`;
    const { classesAt, marks } = fixture(source);
    expect(classesAt(source.indexOf("$"))).toContain("cm-tl-literal");
    expect(marks()).toEqual([]);
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
});
