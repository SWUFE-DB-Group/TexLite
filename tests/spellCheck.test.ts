import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarperLintSupersededError as ServerHarperLintSupersededError,
  HarperService,
  HarperUnavailableError,
  parseHarperCliOutput
} from "../src/server/harper";
import { maskLatexSource } from "../src/server/latexSpellMask";
import { HarperLintSupersededError, lintLatex, mapLatexLints, type RawHarperLint } from "../src/client/spellCheck";
import { supportsWritingChecks } from "../src/shared/writingChecks";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A deterministic CLI substitute for testing scheduler behaviour. */
class DelayedHarperService extends HarperService {
  readonly firstLintStarted = deferred();
  private readonly releaseFirstLint = deferred();
  private lintRuns = 0;

  get lintRunCount(): number {
    return this.lintRuns;
  }

  releaseFirstLintRun(): void {
    this.releaseFirstLint.resolve();
  }

  protected override async runCommand(args: string[], _timeoutMs: number, _outputLimit: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (args[0] === "--version") return { code: 0, stdout: "harper-cli test", stderr: "" };
    this.lintRuns += 1;
    if (this.lintRuns === 1) {
      this.firstLintStarted.resolve();
      await this.releaseFirstLint.promise;
    }
    return { code: 0, stdout: "[]", stderr: "" };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Harper writing checks", () => {
  it("always disables writing checks for BibTeX files", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(supportsWritingChecks("references.bib")).toBe(false);
    expect(supportsWritingChecks("REFERENCES.BIB")).toBe(false);
    expect(supportsWritingChecks("main.tex")).toBe(true);
    await expect(lintLatex("project", "references.bib", "author = {Mispeled}"))
      .resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("linearly masks complex LaTeX syntax while preserving prose and Unicode scalar offsets", () => {
    const source = String.raw`\documentclass{article}
\usepackage[final]{acl}
\section{A mispeled heading}
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
    for (const syntax of ["article", "acl", "final", "comment mispeled", "missingCitation", "sec:mispeled", "rqblue", "colorbar", "llll", "\\node", "https://example.invalid/mispeled"]) {
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

  it("masks common inline code, macro definitions, and non-prose environment variants", () => {
    const source = String.raw`\texttt{isValid} \Verb|mispeledVerb| \lstinline|mispeledLstinline| \mintinline{python}|mispeledMintinline| \mintinline{python}{mispeledMintBrace}
\newcommand{\sys}[1][default]{\texttt{mispeledMacro #1}}
\NewDocumentCommand{\tool}{m}{\texttt{mispeledDocumentCommand #1}}
\DeclareMathOperator{\argmax}{mispeledOperator}
\begin{verbatim*}
mispeledVerbatim
\end{verbatim*}
\begin{cases}
mispeledCases & x > 0 \\
\end{cases}
\begin{aligned}
mispeledAligned &= x
\end{aligned}
Visible misspeled prose.`;
    const masked = maskLatexSource(source);

    for (const hidden of [
      "isValid", "mispeledVerb", "mispeledLstinline", "mispeledMintinline", "mispeledMintBrace", "mispeledMacro",
      "mispeledDocumentCommand", "mispeledOperator", "mispeledVerbatim", "mispeledCases", "mispeledAligned"
    ]) expect(masked).not.toContain(hidden);
    expect(masked).toContain("Visible misspeled prose.");
  });

  it("keeps an incomplete inline literal command on its own line", () => {
    const source = String.raw`\verb|mispeled literal code
Visible | misspeled prose.
\lstinline!another mispeled literal
Later ! wrng prose.
\lstinline{unclosed braced literal
Visible } misspeled braced prose.`;
    const masked = maskLatexSource(source);

    expect(masked).not.toContain("mispeled literal code");
    expect(masked).not.toContain("another mispeled literal");
    expect(masked).not.toContain("unclosed braced literal");
    expect(masked).toContain("Visible | misspeled prose.");
    expect(masked).toContain("Later ! wrng prose.");
    expect(masked).toContain("Visible } misspeled braced prose.");
  });

  it("keeps comments, literal commands, and literal environments from leaking into prose", () => {
    const source = String.raw`\newcommand{\first}% A comment containing a fake closing brace }
{mispeledMacroAfterComment}
\newcommand{\second}{% Another fake closing brace }
mispeledMacroBody}
\Verb[formatcom=\small]|mispeledVerbOption|
\lstinline[language=Python]{mispeledLstBraces} Visible misspeled prose.
\begin{verbatim*}
$ literal math marker and mispeledVerbatim
\end{verbatim*}
After $x$ misspeled prose.`;
    const masked = maskLatexSource(source);

    for (const hidden of [
      "mispeledMacroAfterComment", "mispeledMacroBody", "mispeledVerbOption", "mispeledLstBraces", "mispeledVerbatim", "literal math marker"
    ]) expect(masked).not.toContain(hidden);
    expect(masked).toContain("Visible misspeled prose.");
    expect(masked).toContain("After ");
    expect(masked).toContain("misspeled prose.");
    expect(masked).not.toContain("$x$");
  });

  it("preserves ordered masks, literal percent signs, and nested ordinary environments", () => {
    const source = String.raw`\documentclass% comment
{article}
\begin{axis}% comment
mispeledAxis
\end{axis}
\mintinline{python}{x % 2} Visible misspeled prose.
\verb%code% More misspeled prose.
\begin{tabular}{l}
\begin{tabular}{l}inner\end{tabular}
mispeledOuter
\end{tabular}
\begin{align}
% \end{align}
mispeledMath = x
\end{align}
Final prose.`;
    const masked = maskLatexSource(source);
    for (const hidden of ["documentclass", "begin", "article", "mispeledAxis", "mispeledOuter", "mispeledMath", "code", "x % 2"]) {
      expect(masked).not.toContain(hidden);
    }
    for (const prose of ["Visible misspeled prose.", "More misspeled prose.", "Final prose."]) expect(masked).toContain(prose);
    expect([...masked]).toHaveLength([...source].length);
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

  it("submits a newer revision before an older request resolves", async () => {
    const requests: Array<{ source: string; clientId: string; sequence: number }> = [];
    let resolveFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { source?: string; clientId?: string; sequence?: number };
      const source = body.source ?? "";
      requests.push({ source, clientId: body.clientId ?? "", sequence: body.sequence ?? 0 });
      if (source === "Firstt sentence.") await firstResponse;
      const word = source.split(" ")[0] || "word";
      return Response.json({ lints: [rawLint(source, word)] });
    });
    const active = lintLatex("project", "main.tex", "Firstt sentence.");
    expect(requests).toHaveLength(1);
    const latest = lintLatex("project", "main.tex", "Secondd sentence.");

    // This assertion runs while the first network response is deliberately
    // held back. The current source must not wait behind it in the browser.
    expect(requests.map((request) => request.source)).toEqual(["Firstt sentence.", "Secondd sentence."]);
    expect(requests[1].clientId).toBe(requests[0].clientId);
    expect(requests[1].sequence).toBe(requests[0].sequence + 1);
    expect(requests[0].clientId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);

    resolveFirst();
    await expect(active).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ word: "Firstt" })]));
    await expect(latest).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ word: "Secondd" })]));
  });

  it("treats a server-side supersession as a normal stale writing check", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      code: "SPELLCHECK_SUPERSEDED",
      error: "A newer writing check replaced this request."
    }, { status: 409 }));

    await expect(lintLatex("project", "main.tex", "Obsolete sentence.")).rejects.toBeInstanceOf(HarperLintSupersededError);
  });

  it("skips stale waiting host checks while preserving the newest revision", async () => {
    const harper = new DelayedHarperService();
    try {
      const active = harper.lint("First source.", "main.tex", "project\0session\0main.tex");
      await harper.firstLintStarted.promise;
      const obsolete = harper.lint("Second source.", "main.tex", "project\0session\0main.tex");
      const obsoleteExpectation = expect(obsolete).rejects.toBeInstanceOf(ServerHarperLintSupersededError);
      const latest = harper.lint("Third source.", "main.tex", "project\0session\0main.tex");

      await obsoleteExpectation;
      harper.releaseFirstLintRun();
      await expect(active).resolves.toEqual([]);
      await expect(latest).resolves.toEqual([]);
      expect(harper.lintRunCount).toBe(2);
    } finally {
      await harper.dispose();
    }
  });

  it("rejects a delayed older sequence without replacing the newest queued revision", async () => {
    const harper = new DelayedHarperService();
    const lane = "project\0user\0page-a\0main.tex";
    try {
      const running = harper.lint("First source.", "main.tex", lane, 1);
      await harper.firstLintStarted.promise;
      const newest = harper.lint("Newest source.", "main.tex", lane, 3);
      // Network delivery can invert request order: sequence 2 arrives after
      // the current sequence 3 was already accepted by the scheduler.
      const delayedOlder = harper.lint("Delayed older source.", "main.tex", lane, 2);

      await expect(delayedOlder).rejects.toBeInstanceOf(ServerHarperLintSupersededError);
      harper.releaseFirstLintRun();
      await expect(Promise.all([running, newest])).resolves.toEqual([[], []]);
      expect(harper.lintRunCount).toBe(2);
    } finally {
      await harper.dispose();
    }
  });

  it("allows an idempotent retry but rejects conflicting content with the same sequence", async () => {
    const harper = new DelayedHarperService();
    const lane = "project\0user\0page-a\0main.tex";
    try {
      const blocker = harper.lint("Blocking source.", "main.tex", "project\0user\0blocker\0main.tex", 1);
      await harper.firstLintStarted.promise;
      const current = harper.lint("Current source.", "main.tex", lane, 7);
      const retry = harper.lint("Current source.", "main.tex", lane, 7);
      const conflictingRetry = harper.lint("Conflicting source.", "main.tex", lane, 7);

      await expect(conflictingRetry).rejects.toBeInstanceOf(ServerHarperLintSupersededError);
      harper.releaseFirstLintRun();
      await expect(Promise.all([blocker, current, retry])).resolves.toEqual([[], [], []]);
      expect(harper.lintRunCount).toBe(2);
    } finally {
      await harper.dispose();
    }
  });

  it("keeps separate browser pages under one login from superseding each other", async () => {
    const harper = new DelayedHarperService();
    try {
      const blocker = harper.lint("Blocking source.", "main.tex", "project\0user\0blocker\0main.tex", 1);
      await harper.firstLintStarted.promise;
      // These lanes represent two tabs using the same authenticated cookie
      // (same project and user) but distinct page-local client IDs.
      const firstCollaborator = harper.lint("Shared source.", "main.tex", "project\0user\0page-a\0main.tex", 1);
      const secondCollaborator = harper.lint("Shared source.", "main.tex", "project\0user\0page-b\0main.tex", 1);
      const newerFirstCollaborator = harper.lint("Newer source.", "main.tex", "project\0user\0page-a\0main.tex", 2);

      harper.releaseFirstLintRun();
      await expect(Promise.all([blocker, firstCollaborator, secondCollaborator, newerFirstCollaborator]))
        .resolves.toEqual([[], [], [], []]);
      expect(harper.lintRunCount).toBe(3);
    } finally {
      await harper.dispose();
    }
  });

  it("coalesces identical in-flight checks even when their source is too large to cache", async () => {
    const harper = new DelayedHarperService();
    const largeSource = `Visible ${"prose ".repeat(100_000)}`;
    try {
      const active = harper.lint(largeSource, "main.tex", "project\0session-a\0main.tex");
      await harper.firstLintStarted.promise;
      const duplicate = harper.lint(largeSource, "main.tex", "project\0session-b\0main.tex");

      harper.releaseFirstLintRun();
      await expect(Promise.all([active, duplicate])).resolves.toEqual([[], []]);
      expect(harper.lintRunCount).toBe(1);
    } finally {
      await harper.dispose();
    }
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
Inline $wrng$ math.
\texttt{isValid} \Verb|mispeledVerb| \lstinline|mispeledLstinline|
\mintinline{python}{mispeledMint}
\newcommand{\tool}{mispeledMacro}
\begin{verbatim*}
mispeledVerbatim
\end{verbatim*}
\begin{cases}
mispeledCases & x > 0
\end{cases}`;
    try {
      await harper.preload();
      const lints = await harper.lint(source, "main.tex");
      expect(lints.map((lint) => lint.problem)).toContain("wrng");
      expect(lints.map((lint) => lint.problem)).toContain("typoo");
      expect(lints.map((lint) => lint.problem)).not.toContain("badcitation");
      expect(lints.map((lint) => lint.problem)).not.toContain("rqblue");
      for (const hidden of ["isValid", "mispeledVerb", "mispeledLstinline", "mispeledMint", "mispeledMacro", "mispeledVerbatim", "mispeledCases"]) {
        expect(lints.map((lint) => lint.problem)).not.toContain(hidden);
      }
      const issues = await mapLatexLints(source, [], lints);
      expect(issues.find((issue) => issue.word === "wrng")).toMatchObject({ from: source.indexOf("wrng") });
      expect(issues.find((issue) => issue.word === "typoo")).toMatchObject({ from: source.indexOf("typoo") });
    } finally {
      await harper.dispose();
    }
  });
});
