import { describe, expect, it } from "vitest";
import { ignoredRanges, lintLatex, maskLatexSource } from "../src/client/spellCheck";

describe("Harper LaTeX writing checks", () => {
  it("masks LaTeX syntax while preserving source positions", () => {
    const source = String.raw`\begin{tikzpicture}
\tikzset{every node near coord/.append style={draw=rqblue!80!black}}
\end{tikzpicture}
This sentence has wrng spelling.`;
    const masked = maskLatexSource(source);
    expect(masked).toContain("This sentence has wrng spelling.");
    expect(masked).not.toContain("tikzpicture");
    expect(ignoredRanges(source).some((range) => source.slice(range.from, range.to).includes("tikzpicture"))).toBe(true);
  });

  it("ignores comments, references, options, and table column specifications", async () => {
    const source = String.raw`% commment wrng
anotherr wrng
\cite{badcitation} \label{badlabel} \ref{badref}
\begin{axis}[
  colorbar,
  colormap name=academicblue,
]
\end{axis}
\begin{tabular}{lllll}
\end{tabular}`;
    expect((await lintLatex(source)).map((issue) => issue.word)).toEqual(["anotherr", "wrng"]);
  });

  it("honours the shared project dictionary", async () => {
    expect((await lintLatex("TexLite wrng")).map((issue) => issue.word)).toEqual(["TexLite", "wrng"]);
    expect((await lintLatex("TexLite wrng", ["TexLite"])).map((issue) => issue.word)).toEqual(["wrng"]);
  });

  it("checks misspelled words that begin with a capital letter and hyphenated words", async () => {
    expect((await lintLatex("Thiss sentence")).map((issue) => issue.word)).toContain("Thiss");
    expect((await lintLatex("well-known misspeled")).map((issue) => issue.word)).toEqual(["misspeled"]);
  });

  it("returns Harper spelling suggestions and classifies grammar lints", async () => {
    const spelling = (await lintLatex("This sentence has wrng spelling."))[0];
    expect(spelling).toMatchObject({ word: "wrng", kind: "spelling" });
    expect(spelling?.suggestions).toContain("wrong");

    const grammar = (await lintLatex("Their going to the store."))[0];
    expect(grammar).toMatchObject({ word: "Their", kind: "grammar" });
    expect(grammar?.suggestions).toContain("They're");
  });

  it("maps Harper's Unicode scalar offsets back to CodeMirror offsets", async () => {
    const source = "中文。 wrng";
    const issue = (await lintLatex(source))[0];
    expect(issue).toMatchObject({ word: "wrng", from: 4, to: 8 });

    const astralSource = "😀 wrng";
    const astralIssue = (await lintLatex(astralSource))[0];
    expect(astralIssue).toMatchObject({ word: "wrng", from: 3, to: 7 });
  });
});
