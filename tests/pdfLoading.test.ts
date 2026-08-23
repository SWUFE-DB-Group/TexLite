import { describe, expect, it } from "vitest";
import { pdfLoadingMode } from "../src/server/compileArtifacts.js";

describe("PDF loading strategy", () => {
  const threshold = 5 * 1024 * 1024;

  it("uses one full response up to and including the automatic threshold", () => {
    const config = { pdfLoadingStrategy: "auto" as const, pdfRangeThresholdBytes: threshold };
    expect(pdfLoadingMode(config, threshold - 1)).toBe("full");
    expect(pdfLoadingMode(config, threshold)).toBe("full");
  });

  it("uses range requests above the automatic threshold", () => {
    expect(pdfLoadingMode(
      { pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: threshold },
      threshold + 1
    )).toBe("range");
  });

  it("honors explicit full and range overrides", () => {
    expect(pdfLoadingMode(
      { pdfLoadingStrategy: "full", pdfRangeThresholdBytes: threshold },
      threshold * 10
    )).toBe("full");
    expect(pdfLoadingMode(
      { pdfLoadingStrategy: "range", pdfRangeThresholdBytes: threshold },
      1
    )).toBe("range");
  });
});
