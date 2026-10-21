import { describe, expect, it } from "vitest";
import { isFormattableLatexFile, reindentLatexSelection } from "../src/client/latexFormatter";
import { formatTexSource, LatexFormatterWorkerError } from "../src/client/latexFormatterWorkerCore";
import { calculateLatexTextEdits } from "../src/client/formatterTextEdits";

describe("LaTeX formatting", () => {
  it("recognizes LaTeX source files", () => {
    expect(isFormattableLatexFile("main.tex")).toBe(true);
    expect(isFormattableLatexFile("styles/paper.STY")).toBe(true);
    expect(isFormattableLatexFile("paper.cls")).toBe(true);
    expect(isFormattableLatexFile("references.bib")).toBe(true);
  });

  it("creates minimal edits at the selected source offset", async () => {
    expect(calculateLatexTextEdits("Hello   world", "Hello world", 20)).toEqual([
      { from: 26, to: 28, replacement: "" }
    ]);
  });

  it("uses efficiency cleanup to combine edits separated by a trivial equality", () => {
    expect(calculateLatexTextEdits("abXcd", "xyXzw")).toEqual([
      { from: 0, to: 5, replacement: "xyXzw" }
    ]);
  });

  it("replaces whole emoji at UTF-16 editor offsets", () => {
    expect(calculateLatexTextEdits("前 😀 后", "前 😁 后", 20)).toEqual([
      { from: 22, to: 24, replacement: "😁" }
    ]);
  });

  it("keeps unchanged Unicode text and whole-character edit boundaries after efficiency cleanup", () => {
    const source = "😁𠀁😁";
    const formatted = "😀𠀁a𠀀";
    const prefix = "outside 😀\n";
    const suffix = "\nuntouched";
    const edits = calculateLatexTextEdits(source, formatted, prefix.length);
    expect(edits).toEqual([
      { from: prefix.length, to: prefix.length + 2, replacement: "😀" },
      { from: prefix.length + 4, to: prefix.length + 6, replacement: "a𠀀" }
    ]);
    let result = prefix + source + suffix;
    for (const edit of [...edits].reverse()) {
      result = result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
      expect(() => encodeURIComponent(result)).not.toThrow();
    }
    expect(result).toBe(prefix + formatted + suffix);
  });

  it.each([
    ["\\section{标题}  😀\nText   here\n", "\\section{标题} 😀\nText here\n"],
    ["first\r\n  second\r\n", "first\nsecond\n"],
    ["", "\\label{new}\n"], ["removed", ""],
    ["中文 𠀀 unchanged", "中文 𠀁 rewritten"]
  ])("reconstructs the formatted selection with its surrounding text intact: %j", (source, formatted) => {
    const prefix = "outside 😀\n";
    const suffix = "\nuntouched";
    const edits = calculateLatexTextEdits(source, formatted, prefix.length);
    let result = prefix + source + suffix;
    for (const edit of [...edits].reverse()) {
      result = result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
    }
    expect(result).toBe(prefix + formatted + suffix);
  });

  it("formats LaTeX with the bundled tex-fmt worker engine", () => {
    expect(formatTexSource("\\documentclass{article}\n\\begin{document}\n  text\n\\end{document}\n", "")).toEqual({
      output: "\\documentclass{article}\n\\begin{document}\ntext\n\\end{document}\n",
      logs: ""
    });
  });

  it("passes editor TOML options to tex-fmt", () => {
    expect(() => formatTexSource("\\section{Title}\n", "not valid =")).toThrow(LatexFormatterWorkerError);
    try {
      formatTexSource("\\section{Title}\n", "not valid =");
    } catch (error) {
      expect(error).toMatchObject({ kind: "format" });
      expect((error as Error).message).toContain("TOML");
    }
  });

  it("retains tex-fmt diagnostic logs for incomplete source", () => {
    const result = formatTexSource("\\begin{document}\n{x\n", "");
    expect(result.output).toBe("\\begin{document}\n{x\n");
    expect(result.logs).toContain("Indent does not return to zero");
  });

  it("reindents formatted selection output", () => {
    expect(reindentLatexSelection("    \\section{Title}\n", "\\section{Title}\n")).toBe("    \\section{Title}\n");
  });
});
