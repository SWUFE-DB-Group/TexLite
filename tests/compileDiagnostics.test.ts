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

  it("returns a useful system diagnostic when a failed process has no marker", () => {
    const result = parseCompileDiagnostics("latexmk exited with status 1", "failed");
    expect(result.errors).toEqual([expect.objectContaining({ phase: "system", severity: "error" })]);
  });

  it("can infer success for legacy callers that do not provide a process status", () => {
    const result = parseCompileDiagnostics("Output written on main.pdf (1 page).\nLatexmk: All targets (main.pdf) are up-to-date");
    expect(result.errors).toEqual([]);
  });
});
