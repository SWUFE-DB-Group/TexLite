import { describe, expect, it } from "vitest";
import { createLatexTextEdits, formatWithTexFmt, isFormattableLatexFile, reindentLatexSelection } from "../src/client/latexFormatter";

describe("LaTeX formatting", () => {
  it("recognizes LaTeX source files", () => {
    expect(isFormattableLatexFile("main.tex")).toBe(true);
    expect(isFormattableLatexFile("styles/paper.STY")).toBe(true);
    expect(isFormattableLatexFile("paper.cls")).toBe(true);
    expect(isFormattableLatexFile("references.bib")).toBe(true);
  });

  it("creates minimal edits at the selected source offset", async () => {
    await expect(createLatexTextEdits("Hello   world", "Hello world", 20)).resolves.toEqual([
      { from: 26, to: 28, replacement: "" }
    ]);
  });

  it("formats LaTeX in the browser with the bundled tex-fmt build", async () => {
    await expect(formatWithTexFmt("\\documentclass{article}\n\\begin{document}\n  text\n\\end{document}\n")).resolves.toBe("\\documentclass{article}\n\\begin{document}\ntext\n\\end{document}\n");
  });

  it("passes editor TOML options to tex-fmt", async () => {
    await expect(formatWithTexFmt("\\section{Title}\n", "not valid =")).rejects.toThrow("TOML");
  });

  it("reindents formatted selection output", () => {
    expect(reindentLatexSelection("    \\section{Title}\n", "\\section{Title}\n")).toBe("    \\section{Title}\n");
  });
});
