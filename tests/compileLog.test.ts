import { describe, expect, it } from "vitest";
import { classifyCompileLog } from "../src/client/compileLog";

describe("compile log classification", () => {
  it("does not treat package filenames containing error as errors", () => {
    const log = [
      "(/usr/share/texmf-dist/tex/generic/pgfplots/pgfplots.errorbars.code.tex)",
      "Running 'pdflatex -file-line-error -halt-on-error main.tex'",
      "Package: infwarerr Providing info/warning/error messages"
    ].join("\n");
    expect(classifyCompileLog(log).errors).toEqual([]);
  });

  it("recognizes actual TeX and latexmk errors", () => {
    const log = [
      "! Undefined control sequence.",
      "main.tex:12: LaTeX Error: Missing \\begin{document}.",
      "Latexmk: Errors, so I did not complete making targets"
    ].join("\n");
    expect(classifyCompileLog(log, "failed").errors).toHaveLength(3);
  });

  it("recognizes warnings without matching unrelated substrings", () => {
    const log = ["LaTeX Warning: Reference undefined", "warningtrack.sty", "Underfull \\hbox (badness 1000)"].join("\n");
    expect(classifyCompileLog(log).warnings).toHaveLength(2);
  });

  it("uses the final LaTeX pass for warnings and trusts a successful result", () => {
    const log = [
      "Running 'pdflatex -file-line-error -halt-on-error main.tex'",
      "LaTeX Warning: Citation `present' on page 1 undefined on input line 10.",
      "main.tex:10: LaTeX Error: an error-looking line from an earlier pass.",
      "Running 'bibtex main'",
      "Running 'pdflatex -file-line-error -halt-on-error main.tex'",
      "Package microtype Warning: \\nonfrenchspacing is active.",
      "Output written on main.pdf (1 page).",
      "Latexmk: All targets (main.pdf) are up-to-date"
    ].join("\n");

    expect(classifyCompileLog(log, "succeeded")).toEqual({
      warnings: ["Package microtype Warning: \\nonfrenchspacing is active."],
      errors: []
    });
  });

  it("infers a successful latexmk result when an older caller has no status", () => {
    const log = [
      "Running 'pdflatex -file-line-error -halt-on-error main.tex'",
      "Output written on main.pdf (1 page).",
      "Latexmk: All targets (main.pdf) are up-to-date"
    ].join("\n");

    expect(classifyCompileLog(log).errors).toEqual([]);
  });
});
