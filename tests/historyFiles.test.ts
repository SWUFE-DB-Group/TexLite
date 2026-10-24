import { describe, expect, it } from "vitest";
import { defaultHistoryTracking, historyTextCandidate } from "../src/shared/historyTracking";

describe("snapshot text comparisons", () => {
  it("includes ordinary source and data files", () => {
    for (const path of ["main.TEX", "references.bib", "paper.sty", "style.bst", "notes.txt", "README", "data/results.dat", "meta.json", "latexmkrc", ".latexmkrc", "build.bat", "scripts/RUN.CMD", "settings.ini", "plot.eps", "notes.custom", "custom-name"]) {
      expect(historyTextCandidate(path), path).toBe(true);
      expect(defaultHistoryTracking(path, new TextEncoder().encode("UTF-8 text\r\n")), path).toBe(true);
    }
  });
  it("recognizes Git text configuration files, including nested dotfiles", () => {
    for (const path of [".gitignore", "chapters/.gitignore", ".gitattributes", ".gitmodules"]) {
      expect(defaultHistoryTracking(path, new TextEncoder().encode("*.log\n")), path).toBe(true);
    }
  });
  it("excludes known attachments even when their bytes happen to be UTF-8", () => {
    for (const path of ["figure.pdf", "figure.PNG", "plot.svg", "archive.zip", "data.bin", ".gitignore.zip", ""]) {
      expect(historyTextCandidate(path), path).toBe(false);
      expect(defaultHistoryTracking(path, new TextEncoder().encode("not a text resource")), path).toBe(false);
    }
  });

  it("uses the same content validation for automatic recording and comparisons", () => {
    for (const path of ["build.bat", "notes.txt", "other.unknown", ".unknown"]) {
      for (const bytes of [Uint8Array.of(0), Uint8Array.of(255, 254), Uint8Array.of(27, 91)]) {
        expect(defaultHistoryTracking(path, bytes), path).toBe(false);
      }
    }
  });
});
