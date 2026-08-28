import { describe, expect, it } from "vitest";
import { findLatexMathRangeAt, supportsLatexMathHover } from "../src/client/latexMath";

function rangeAt(source: string, text: string) {
  const position = source.indexOf(text);
  if (position < 0) throw new Error(`Missing ${text}`);
  return findLatexMathRangeAt(source, position);
}

describe("LaTeX math hover ranges", () => {
  it("finds inline and display delimiters without including them in preview source", () => {
    const source = String.raw`Inline $a^2 + b^2$ and \[\frac{1}{2}\].`;
    expect(rangeAt(source, "b^2")).toMatchObject({ source: "a^2 + b^2", displayMode: false });
    expect(rangeAt(source, "frac")).toMatchObject({ source: "\\frac{1}{2}", displayMode: true });
  });

  it("ignores escaped dollars, comments, and verbatim content", () => {
    const source = String.raw`Price \$5 and % $not-math$
\verb|$also-not-math$| but $x + y$.\begin{verbatim}$never$\end{verbatim}`;
    expect(rangeAt(source, "Price")).toBeNull();
    expect(rangeAt(source, "not-math")).toBeNull();
    expect(rangeAt(source, "also-not-math")).toBeNull();
    expect(rangeAt(source, "x + y")).toMatchObject({ source: "x + y", displayMode: false });
    expect(rangeAt(source, "never")).toBeNull();
  });

  it("handles common display environments and removes document-only labels", () => {
    const source = String.raw`\begin{align}
  a &= b \\ \label{eq:example}
  c &= d
\end{align}`;
    const range = rangeAt(source, "c &= d");
    expect(range?.displayMode).toBe(true);
    expect(range?.source).toContain("\\begin{aligned}");
    expect(range?.source).not.toContain("label");
  });

  it("does not turn an unmatched delimiter into a formula extending over later prose", () => {
    const source = "Unfinished $x + y\nLater prose without math.";
    expect(rangeAt(source, "Later prose")).toBeNull();
  });

  it("only enables hover previews in LaTeX source files", () => {
    for (const file of ["main.tex", "style.STY", "article.cls", "appendix.ltx"]) expect(supportsLatexMathHover(file)).toBe(true);
    for (const file of ["references.bib", "notes.txt", "figure.pdf"]) expect(supportsLatexMathHover(file)).toBe(false);
  });
});
