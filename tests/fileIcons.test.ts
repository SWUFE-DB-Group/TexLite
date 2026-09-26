import { describe, expect, it } from "vitest";
import { fileIconKind } from "../src/client/fileIcons";

describe("project file icons", () => {
  it("maps common resources to semantic icon categories", () => {
    expect(fileIconKind("paper/main.tex")).toBe("tex");
    expect(fileIconKind("references/main.bib")).toBe("bib");
    expect(fileIconKind("README.md")).toBe("markdown");
    expect(fileIconKind("notes.txt")).toBe("text");
    expect(fileIconKind("metadata.dat")).toBe("text");
    expect(fileIconKind("figures/result.PNG")).toBe("image");
    expect(fileIconKind("output.pdf")).toBe("pdf");
    expect(fileIconKind("data.csv")).toBe("spreadsheet");
  });

  it("handles project control files and unknown extensions safely", () => {
    expect(fileIconKind("latexmkrc")).toBe("latexmkrc");
    expect(fileIconKind(".latexmkrc")).toBe("latexmkrc");
    expect(fileIconKind("archive.zip")).toBe("archive");
    expect(fileIconKind("unknown.custom" )).toBe("file");
  });
});
