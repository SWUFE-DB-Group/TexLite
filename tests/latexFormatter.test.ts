import { describe, expect, it } from "vitest";
import { isFormattableLatexFile, reindentLatexSelection } from "../src/client/latexFormatter";
import { calculateLatexTextEdits, formatTexSource, LatexFormatterWorkerError } from "../src/client/latexFormatterWorkerCore";

describe("LaTeX formatting", () => {
  it("recognizes LaTeX source files", () => {
    expect(isFormattableLatexFile("main.tex")).toBe(true);
    expect(isFormattableLatexFile("styles/paper.STY")).toBe(true);
    expect(isFormattableLatexFile("paper.cls")).toBe(true);
    expect(isFormattableLatexFile("references.bib")).toBe(true);
  });

  it("creates minimal edits at the selected source offset", async () => {
    expect(calculateLatexTextEdits("Hello   world", "Hello world", 20)).toEqual([
      { from: 26, to: 28, replacement: "" }
    ]);
  });

  it("formats LaTeX with the bundled tex-fmt worker engine", () => {
    expect(formatTexSource("\\documentclass{article}\n\\begin{document}\n  text\n\\end{document}\n", "")).toEqual({
      output: "\\documentclass{article}\n\\begin{document}\ntext\n\\end{document}\n",
      logs: ""
    });
  });

  it("passes editor TOML options to tex-fmt", () => {
    expect(() => formatTexSource("\\section{Title}\n", "not valid =")).toThrow(LatexFormatterWorkerError);
    try {
      formatTexSource("\\section{Title}\n", "not valid =");
    } catch (error) {
      expect(error).toMatchObject({ kind: "format" });
      expect((error as Error).message).toContain("TOML");
    }
  });

  it("retains tex-fmt diagnostic logs for incomplete source", () => {
    const result = formatTexSource("\\begin{document}\n{x\n", "");
    expect(result.output).toBe("\\begin{document}\n{x\n");
    expect(result.logs).toContain("Indent does not return to zero");
  });

  it("reindents formatted selection output", () => {
    expect(reindentLatexSelection("    \\section{Title}\n", "\\section{Title}\n")).toBe("    \\section{Title}\n");
  });
});
