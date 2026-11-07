import { describe, expect, it } from "vitest";
import { BibtexFormatError, formatBibtex } from "../src/client/bibtexFormat";
import { MAX_CITATION_BIBTEX_BYTES } from "../src/server/limits.js";

const limit = MAX_CITATION_BIBTEX_BYTES;

describe("BibTeX formatting", () => {
  it("formats valid BibTeX without changing field names or values", () => {
    expect(formatBibtex("@article{x,title={One},year=2026}", limit)).toContain("title         = {One}");
    expect(formatBibtex("  \n", limit)).toBe("  \n");
  });

  it("reports typed failures without embedding a UI language", () => {
    expect(formattingFailure("@article{x title={Y}}").kind).toBe("invalid");
    expect(formattingFailure("x".repeat(limit + 1)).kind).toBe("too-large");
  });
});

function formattingFailure(source: string): BibtexFormatError {
  try {
    formatBibtex(source, limit);
  } catch (error) {
    if (error instanceof BibtexFormatError) return error;
    throw error;
  }
  throw new Error("Expected BibTeX formatting to fail");
}
