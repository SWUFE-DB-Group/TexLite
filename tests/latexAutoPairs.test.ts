import { describe, expect, it } from "vitest";
import { latexAutoPair, latexAutoPairAtCursor } from "../src/client/latexAutoPairs";

describe("LaTeX auto pairs", () => {
  it("closes an environment after the closing brace is typed", () => {
    const source = "\\begin{itemize";
    const pair = latexAutoPair(source, source.length, source.length, "}");
    expect(pair).toEqual({ insert: "\n\t\n\\end{itemize}", cursorOffset: 2, kind: "environment" });
  });

  it("keeps the existing indentation for the body and closing command", () => {
    const source = "  \\begin{figure";
    const pair = latexAutoPair(source, source.length, source.length, "}");
    expect(pair).toEqual({ insert: "\n  \t\n  \\end{figure}", cursorOffset: 4, kind: "environment" });
  });

  it("does not duplicate an immediately following closing environment", () => {
    const source = "\\begin{document\n\\end{document}";
    const from = "\\begin{document".length;
    expect(latexAutoPair(source, from, from, "}")).toBeNull();
  });

  it("can complete an environment after a close-bracket handler moves over its brace", () => {
    const source = "\\begin{itemize}";
    expect(latexAutoPairAtCursor(source, source.length)).toEqual({
      insert: "\n\t\n\\end{itemize}",
      cursorOffset: 2,
      kind: "environment"
    });
  });

  it("pairs scalable delimiters without affecting ordinary text", () => {
    const source = "\\left";
    expect(latexAutoPair(source, source.length, source.length, "(")).toEqual({
      insert: "\\right)",
      cursorOffset: 0,
      kind: "delimiter"
    });
    const text = "text \\begin{itemize";
    expect(latexAutoPair(text, text.length, text.length, "}")).toBeNull();
  });

  it("does not react to replacements", () => {
    const source = "\\begin{itemize";
    expect(latexAutoPair(source, 0, source.length, "}")).toBeNull();
  });
});
