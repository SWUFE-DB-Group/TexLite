import { describe, expect, it } from "vitest";
import { parseCompileDiagnostics } from "../src/server/compileDiagnostics";

describe("structured compile diagnostics", () => {
  it("keeps phase, severity and source location for a failed LaTeX pass", () => {
    const result = parseCompileDiagnostics([
      "Running 'pdflatex -file-line-error main.tex'",
      "main.tex:1835: LaTeX Error: Missing }.",
      "Latexmk: Errors, so I did not complete making targets"
    ].join("\n"), "failed");

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error", phase: "pdflatex", file: "main.tex", line: 1835,
        message: "Missing }."
      }),
      expect.objectContaining({ severity: "error", phase: "latexmk" })
    ]));
    expect(result.errors.every((item) => item.raw)).toBe(true);
  });

  it("retains Windows drive paths and locates TeX errors without an Error prefix", () => {
    const log = [
      "Running 'xelatex -file-line-error main.tex'",
      String.raw`C:\TexLite 项目\chapters\Part One.tex:12: Undefined control sequence.`,
      "c:/TexLite 项目/main.tex:21:3: LaTeX Error: Missing }.",
      String.raw`C:\TexLite 项目\main.tex:28: Overfull \hbox (1pt too wide)`,
      "Latexmk: Errors, so I did not complete making targets"
    ].join("\r\n");
    const result = parseCompileDiagnostics(log, "failed");

    expect(result.errors).toMatchObject([
      { phase: "xelatex", file: "C:/TexLite 项目/chapters/Part One.tex", line: 12, message: "Undefined control sequence." },
      { phase: "xelatex", file: "c:/TexLite 项目/main.tex", line: 21, column: 3, message: "Missing }." },
      { phase: "latexmk" }
    ]);
    expect(result.warnings).toMatchObject([
      { file: "C:/TexLite 项目/main.tex", line: 28, message: expect.stringContaining("Overfull") }
    ]);
    expect(parseCompileDiagnostics(log, "succeeded").errors).toEqual([]);
  });

  it("does not expose an intermediate BibTeX error after a successful PDF", () => {
    const result = parseCompileDiagnostics([
      "Running 'pdflatex -file-line-error main.tex'",
      "LaTeX Warning: Citation `draft' undefined on input line 10.",
      "Running 'bibtex main'",
      "Bibtex errors: See file main.blg",
      "Running 'pdflatex -file-line-error main.tex'",
      "Package microtype Warning: adjustment applied.",
      "Output written on main.pdf (1 page).",
      "Latexmk: All targets (main.pdf) are up-to-date"
    ].join("\n"), "succeeded");

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((item) => item.message.includes("Citation `draft'"))).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "pdflatex", severity: "warning", message: expect.stringContaining("adjustment applied") })
    ]));
  });

  it("keeps repeated warnings only if they survive the final pass, even with wrapped engines and interleaved latexmk output", () => {
    const result = parseCompileDiagnostics([
      "Run number 1 of rule 'pdflatex'",
      "Running 'engine-wrapper main.tex'",
      "Latexmk: Missing bbl file 'output/main.bbl' in following:",
      "LaTeX Warning: Citation 'draft' undefined on input line 10.",
      "Package test Warning: Persistent warning.",
      "Run number 1 of rule 'bibtex output/main'",
      "Running 'bibtex main.aux'",
      "Run number 2 of rule 'pdflatex'",
      "Running 'engine-wrapper main.tex'",
      "Package test Warning: Persistent warning.",
      "(test)                second line of the message.",
      "(/some/path/pgfplots.errorbars.code.tex)",
      "Package: infwarerr Providing info/warning/error messages",
      "Latexmk: All targets (main.pdf) are up-to-date"
    ].join("\n"), "succeeded");
    expect(result.warnings).toMatchObject([{ phase: "pdflatex", message: "Persistent warning." }]);
    expect(result.errors).toEqual([]);
  });

  it("counts a genuine unresolved citation without counting its aggregate summary twice", () => {
    const result = parseCompileDiagnostics([
      "This is pdfTeX, Version 3.141592653",
      "LaTeX Warning: Citation 'missing' on page 1 undefined on input line 3.",
      "LaTeX Warning: There were undefined references."
    ].join("\n"), "succeeded", "main.tex");
    expect(result.warnings).toMatchObject([{ file: "main.tex", line: 3, message: expect.stringContaining("'missing'") }]);
  });

  it("returns a useful system diagnostic when a failed process has no marker", () => {
    const result = parseCompileDiagnostics("latexmk exited with status 1", "failed");
    expect(result.errors).toEqual([expect.objectContaining({ phase: "system", severity: "error" })]);
  });

  it("can infer success for legacy callers that do not provide a process status", () => {
    const result = parseCompileDiagnostics("Output written on main.pdf (1 page).\nLatexmk: All targets (main.pdf) are up-to-date");
    expect(result.errors).toEqual([]);
  });
});
