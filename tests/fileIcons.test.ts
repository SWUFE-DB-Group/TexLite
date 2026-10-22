import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTypeIcon, fileIconKind } from "../src/client/fileIcons";

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
    expect(fileIconKind("README.custom")).toBe("file");
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { path: "unknown.custom" }))).toContain("file-type-icon-file");
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { path: "unknown.custom" }))).not.toContain("lucide-file-text");
  });
});
