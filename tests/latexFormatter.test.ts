import { describe, expect, it } from "vitest";
import { createLatexTextEdits, isFormattableLatexFile, reindentLatexSelection } from "../src/client/latexFormatter";

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

  it("reindents output from the host formatter", () => {
    expect(reindentLatexSelection("    \\section{Title}\n", "\\section{Title}\n")).toBe("    \\section{Title}\n");
  });
});
