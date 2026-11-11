import { describe, expect, it } from "vitest";
import { copiedFilePath } from "../src/server/routes/projectFiles.js";

describe("copied file names", () => {
  it("adds (copy) before the last extension and counts up past taken names", () => {
    const none = () => false;
    expect(copiedFilePath("main.tex", none)).toBe("main (copy).tex");
    expect(copiedFilePath("fig/plot.data.csv", none)).toBe("fig/plot.data (copy).csv");
    expect(copiedFilePath("Makefile", none)).toBe("Makefile (copy)");
    expect(copiedFilePath("conf/.latexmkrc", none)).toBe("conf/.latexmkrc (copy)");
    const taken = new Set(["a/b (copy).tex", "a/b (copy 2).tex"]);
    expect(copiedFilePath("a/b.tex", (candidate) => taken.has(candidate))).toBe("a/b (copy 3).tex");
  });
});
