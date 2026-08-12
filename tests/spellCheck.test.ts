import { describe, expect, it } from "vitest";
import { checkSpelling } from "../src/client/spellCheck";

describe("LaTeX spell checking", () => {
  it("ignores environment names and key/value option identifiers", () => {
    const source = String.raw`\begin{tikzpicture}
\tikzset{every node near coord/.append style={draw=rqblue!80!black}}
\end{tikzpicture}
This sentence has wrng spelling.`;
    expect(checkSpelling(source).map((issue) => issue.word)).toEqual(["wrng"]);
  });

  it("honours project-specific dictionary words", () => {
    expect(checkSpelling("LaTeX wrng", ["LaTeX"]).map((issue) => issue.word)).toEqual(["wrng"]);
  });

  it("skips comments, references, options, and table column specifications", () => {
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
    expect(checkSpelling(source).map((issue) => issue.word)).toEqual(["anotherr", "wrng"]);
  });

  it("checks the two parts of hyphenated words independently", () => {
    expect(checkSpelling("well-known misspeled").map((issue) => issue.word)).toEqual(["misspeled"]);
  });
});
