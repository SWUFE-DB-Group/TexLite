import { describe, expect, it } from "vitest";
import { parseTexcountOutput } from "../src/server/texcount.js";

describe("TeXcount output", () => {
  it("parses TexLite's fixed report template and computes the word total", () => {
    const result = parseTexcountOutput("__TEXLITE_TEXCOUNT_WORDS__|128|12|7|4|2|9|3");
    expect(result).toEqual({
      textWords: 128,
      headerWords: 12,
      captionWords: 7,
      totalWords: 147,
      headers: 4,
      floats: 2,
      inlineMath: 9,
      displayMath: 3,
      files: null,
      parserErrors: 0
    });
  });

  it("retains parser error counts without treating a report as invalid", () => {
    const result = parseTexcountOutput("__TEXLITE_TEXCOUNT_WORDS__|0|0|0|0|0|0|0\n(errors:1)");
    expect(result.parserErrors).toBe(1);
    expect(result.totalWords).toBe(0);
  });

  it("rejects output that does not contain TexLite's report template", () => {
    expect(() => parseTexcountOutput("TeXcount failed")).toThrow(/expected report/);
  });
});
