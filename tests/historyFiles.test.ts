import { describe, expect, it } from "vitest";
import { isHistoryTextFile } from "../src/shared/historyFiles";

describe("snapshot text comparisons", () => {
  it("includes ordinary source and data files", () => {
    for (const path of ["main.TEX", "references.bib", "paper.sty", "style.bst", "notes.txt", "README", "data/results.dat", "meta.json", "latexmkrc", ".latexmkrc"]) {
      expect(isHistoryTextFile(path), path).toBe(true);
    }
  });
  it("excludes PDFs, images, archives and unknown attachments", () => {
    for (const path of ["figure.pdf", "figure.PNG", "plot.svg", "plot.eps", "archive.zip", "data.bin", "other.unknown", ""]) {
      expect(isHistoryTextFile(path), path).toBe(false);
    }
  });
});
