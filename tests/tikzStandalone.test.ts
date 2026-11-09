import { describe, expect, it } from "vitest";
import { isStandaloneTikz } from "../src/shared/tikzStandalone";

describe("standalone TikZ detection", () => {
  it("accepts a standalone document with the tikz option or a visible picture", () => {
    expect(isStandaloneTikz("\\documentclass[tikz,border=4pt]{standalone}\n\\begin{document}\\end{document}")).toBe(true);
    expect(isStandaloneTikz("\\documentclass[border=4pt]{standalone}\n\\begin{document}\n\\begin{tikzpicture}\\end{tikzpicture}\n\\end{document}")).toBe(true);
  });

  it("rejects main documents, standalone without TikZ, and commented-out declarations", () => {
    expect(isStandaloneTikz("\\documentclass{article}\n\\begin{tikzpicture}\\end{tikzpicture}")).toBe(false);
    expect(isStandaloneTikz("\\documentclass{standalone}\n\\begin{document}Text\\end{document}")).toBe(false);
    expect(isStandaloneTikz("% \\documentclass[tikz]{standalone}\n\\documentclass{article}")).toBe(false);
    expect(isStandaloneTikz("\\documentclass{standalone}\n% \\begin{tikzpicture}\n")).toBe(false);
  });
});
