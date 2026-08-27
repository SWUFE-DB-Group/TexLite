import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarperService, HarperUnavailableError, parseHarperCliOutput } from "../src/server/harper";
import { maskLatexSource } from "../src/server/latexSpellMask";
import { HarperLintSupersededError, lintLatex, mapLatexLints, type RawHarperLint } from "../src/client/spellCheck";

function scalarOffset(source: string, text: string): { start: number; end: number } {
  const index = source.indexOf(text);
  if (index < 0) throw new Error(`Missing ${text} in test source.`);
  const start = [...source.slice(0, index)].length;
  return { start, end: start + [...text].length };
}

function rawLint(source: string, text: string, kind = "Spelling", suggestions: string[] = []): RawHarperLint {
  const { start, end } = scalarOffset(source, text);
  return { start, end, problem: text, kind, message: `Issue in ${text}`, suggestions };
}

afterEach(() => vi.unstubAllGlobals());

describe("Harper writing checks", () => {
  it("linearly masks complex LaTeX syntax while preserving prose and Unicode scalar offsets", () => {
    const source = String.raw`\section{A mispeled heading}
Visible mispeled prose.
% comment mispeled 😀
\cite[compare]{missingCitation} \label{sec:mispeled} \ref{sec:mispeled}
\begin{axis}[
  width=\linewidth,
  draw=rqblue!80!black,
  colorbar,
]
\begin{scope}\node {mispeled};\end{scope}
\end{axis}
\begin{tabular}{p{2cm}llll}
mispeled
\end{tabular}
\verb|mispeled|
https://example.invalid/mispeled`;
    const masked = maskLatexSource(source);

    expect([...masked]).toHaveLength([...source].length);
    expect(masked).toContain("A mispeled heading");
    expect(masked).toContain("Visible mispeled prose.");
    for (const syntax of ["comment mispeled", "missingCitation", "sec:mispeled", "rqblue", "colorbar", "llll", "\\node", "https://example.invalid/mispeled"]) {
      expect(masked).not.toContain(syntax);
    }
  });

  it("handles escaped delimiters and unmatched math without swallowing later prose", () => {
    const source = String.raw`Before prose.
\\[-1mm]
After misspeled prose.
\[
  x = \text{mispeled}
\]
Inline $mispeled$ and \(also mispeled\).
The literal rate is 20\% and remains readable.
% ignored mispeled comment
\[ unfinished math
Later misspeled prose.`;
    const masked = maskLatexSource(source);

    expect(masked).not.toContain("-1mm");
    expect(masked).toContain("After misspeled prose.");
    expect(masked).not.toContain("x =");
    expect(masked).not.toContain("also mispeled");
    expect(masked).toContain("The literal rate is 20");
    expect(masked).not.toContain("ignored mispeled comment");
    expect(masked).toContain("Later misspeled prose.");
  });

  it("does not backtrack on repeated LaTeX line-break options or unmatched math", () => {
    const lineBreaks = `${String.raw`\\[-1mm]`}\n`.repeat(4_000);
    const unclosedMath = `${String.raw`\[`} x\n`.repeat(4_000);
    const source = `${lineBreaks}${unclosedMath}Final misspeled prose.`;
    const started = performance.now();
    const masked = maskLatexSource(source);

    expect(masked).toHaveLength(source.length);
    expect(masked).toContain("Final misspeled prose.");
    expect(masked).not.toContain("-1mm");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("maps native TeX diagnostics without a client-side syntax masker", async () => {
    const source = String.raw`\section{A misspeled heading}
Visible misspeled prose.
% ignored misspeled comment
\cite{missingCitation} \label{sec:reference}
\begin{axis}[colorbar,draw=rqblue!80!black]
\node {ignored misspeled label};
\end{axis}`;
    const visible = "misspeled prose";
    const issues = await mapLatexLints(source, [], [rawLint(source, visible)]);

    expect(issues).toEqual([expect.objectContaining({ word: visible, kind: "spelling" })]);
  });

  it("drops diagnostics produced by masked LaTeX placeholders", async () => {
    const source = String.raw`\documentclass{article}
\date{\today}
Visible wrng prose.`;
    const placeholder = { start: 0, end: "                       ".length, problem: "                       ", kind: "Formatting", message: "French spaces", suggestions: [" "] };
    const datePlaceholder = { start: source.indexOf("\\date"), end: source.indexOf("\\date") + "      ".length, problem: "      ", kind: "Formatting", message: "Repeated spaces", suggestions: [" "] };

    expect(await mapLatexLints(source, [], [placeholder, datePlaceholder])).toEqual([]);
  });

  it("honours the project dictionary after Harper returns its diagnostics", async () => {
    const source = "TexLite wrng";
    const lints = [rawLint(source, "TexLite"), rawLint(source, "wrng")];
    expect((await mapLatexLints(source, [], lints)).map((issue) => issue.word)).toEqual(["TexLite", "wrng"]);
    expect((await mapLatexLints(source, ["TexLite"], lints)).map((issue) => issue.word)).toEqual(["wrng"]);
  });

  it("does not reuse a client result across different LaTeX file types", async () => {
    const source = "TexLite wrng";
    const texLints = [rawLint(source, "wrng")];
    const styLints = [rawLint(source, "TexLite")];

    expect((await mapLatexLints(source, [], texLints, "main.tex")).map((issue) => issue.word)).toEqual(["wrng"]);
    expect((await mapLatexLints(source, [], styLints, "theme.sty")).map((issue) => issue.word)).toEqual(["TexLite"]);
  });

  it("keeps only the newest waiting request in one browser", async () => {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { source?: string };
      await new Promise((resolve) => setTimeout(resolve, 10));
      const source = body.source ?? "";
      const word = source.split(" ")[0] || "word";
      return Response.json({ lints: [rawLint(source, word)] });
    });
    const active = lintLatex("project", "main.tex", "Firstt sentence.");
    const obsolete = lintLatex("project", "main.tex", "Secondd sentence.");
    const latest = lintLatex("project", "main.tex", "Thirdd sentence.");

    await expect(obsolete).rejects.toBeInstanceOf(HarperLintSupersededError);
    await expect(active).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ word: "Firstt" })]));
    await expect(latest).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ word: "Thirdd" })]));
  });

  it("maps Unicode scalar offsets and preserves grammar suggestions", async () => {
    const source = "中文。 😀 Their going to the store.";
    const issue = (await mapLatexLints(source, [], [rawLint(source, "Their", "Grammar", ["They're"]) ]))[0];
    expect(issue).toMatchObject({ word: "Their", kind: "grammar", from: 7, to: 12, suggestions: ["They're"] });
  });

  it("keeps Harper scalar positions aligned after an astral character in masked LaTeX", async () => {
    const source = "% ignored 😀 misspeled comment\nVisible wrng prose.";
    const masked = maskLatexSource(source);
    const { start, end } = scalarOffset(source, "wrng");

    expect([...masked]).toHaveLength([...source].length);
    expect(masked).not.toContain("misspeled comment");
    const [issue] = await mapLatexLints(source, [], [{ start, end, problem: "wrng", kind: "Spelling", message: "Issue", suggestions: [] }]);
    expect(issue).toMatchObject({ word: "wrng", from: source.indexOf("wrng") });
  });

  it("parses Harper CLI JSON and retains directly applicable replacements", () => {
    const output = JSON.stringify([{
      file: "document.tex",
      lints: [
        {
          kind: "Spelling", message: "Did you mean to spell `wrng` this way?", matched_text: "wrng",
          span: { char_start: 4, char_end: 8 },
          suggestions: ["Replace with: “wrong”", "Replace with: “wrong”", "Ignore this issue"]
        },
        { kind: "Spelling", span: { char_start: "bad", char_end: 8 } }
      ]
    }]);

    expect(parseHarperCliOutput(output)).toEqual([{
      start: 4, end: 8, problem: "wrng", kind: "Spelling",
      message: "Did you mean to spell `wrng` this way?", suggestions: ["wrong"]
    }]);
  });

  it("treats a missing optional host command as a recoverable service error", async () => {
    const harper = new HarperService("texlite-test-missing-harper-command");
    try {
      await expect(harper.lint("A misspeled sentence.", "main.tex")).rejects.toBeInstanceOf(HarperUnavailableError);
    } finally {
      await harper.dispose();
    }
  });
});

const hostHarperAvailable = spawnSync("harper-cli", ["--version"], { stdio: "ignore" }).status === 0;
const nativeHarperIt = hostHarperAvailable ? it : it.skip;

describe("optional host Harper integration", () => {
  nativeHarperIt("uses Harper's native TeX parser for comments, citations, math, and TikZ", async () => {
    const harper = new HarperService();
    const source = String.raw`\section{Title}
This sentence has wrng prose.
% commment 😀 wrng
After the comment, typoo prose remains visible.
\cite{badcitation} \label{badlabel} \ref{badref}
\begin{axis}[colorbar,draw=rqblue!80!black]
\node {wrng};
\end{axis}
Inline $wrng$ math.`;
    try {
      await harper.preload();
      const lints = await harper.lint(source, "main.tex");
      expect(lints.map((lint) => lint.problem)).toContain("wrng");
      expect(lints.map((lint) => lint.problem)).toContain("typoo");
      expect(lints.map((lint) => lint.problem)).not.toContain("badcitation");
      expect(lints.map((lint) => lint.problem)).not.toContain("rqblue");
      const issues = await mapLatexLints(source, [], lints);
      expect(issues.find((issue) => issue.word === "wrng")).toMatchObject({ from: source.indexOf("wrng") });
      expect(issues.find((issue) => issue.word === "typoo")).toMatchObject({ from: source.indexOf("typoo") });
    } finally {
      await harper.dispose();
    }
  });
});
