import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractLatexSymbols } from "../src/shared/latexSymbols.js";

const source = readFileSync(new URL("./fixtures/latex/completion-symbols.tex", import.meta.url), "utf8");

describe("shared LaTeX completion symbols", () => {
  it("preserves command argument shapes and avoids snippets for unsupported xparse forms", () => {
    const { commands } = extractLatexSymbols(source);
    expect(commands.find((item) => item.label === "\\teamnote")).toMatchObject({ apply: "\\teamnote[${1}]{${2}}" });
    expect(commands.find((item) => item.label === "\\teamformat")).toMatchObject({ apply: "\\teamformat[${1}]{${2}}" });
    expect(commands.find((item) => item.label === "\\teamprimitive")).toMatchObject({ apply: "\\teamprimitive{${1}}{${2}}" });
    expect(commands.find((item) => item.label === "\\teamstar")).toBeDefined();
    expect(commands.find((item) => item.label === "\\teamstar")?.apply).toBeUndefined();
    expect(commands.map((item) => item.label)).toEqual(expect.arrayContaining(["\\teamargmax", "\\teamabs", "\\team_expl:n"]));
  });

  it("collects environments, packages, classes, and concrete reference definitions", () => {
    const symbols = extractLatexSymbols(source);
    expect(symbols.environments.map((item) => item.label)).toEqual(["teamdiscussion", "team:proof", "team.proof", "teamclaim"]);
    expect(symbols.packages.map((item) => item.label)).toEqual(["teamstyle", "localtools"]);
    expect(symbols.classes.map((item) => item.label)).toEqual(["teamclass"]);
    expect(symbols.labels.map((item) => item.label)).toEqual(["sec:team", "team-anchor"]);
    expect(symbols.citations.map((item) => item.label)).toEqual(["teammanual"]);
    expect(symbols.files.map((item) => item.label)).toEqual(["chapters/intro"]);
  });

  it("ignores comments and literal examples, including inline percent delimiters", () => {
    const symbols = extractLatexSymbols(source);
    const labels = Object.values(symbols).flat().map((item) => item.label);
    for (const label of [
      "\\commentfake", "\\literalfake", "\\inlinefake", "literalfakeenv", "literal-label", "literal-bibitem", "sec:#1", "old-use"
    ]) expect(labels).not.toContain(label);
    expect(symbols.commands.find((item) => item.label === "\\afterverb")).toMatchObject({ apply: "\\afterverb{${1}}" });
  });

  it("returns fresh source-neutral results without built-in commands", () => {
    const first = extractLatexSymbols(source);
    first.commands[0].source = "Current file";
    const second = extractLatexSymbols(source);
    expect(Object.values(second).flat().every((item) => item.source === undefined)).toBe(true);
    expect(second.commands.map((item) => item.label)).not.toContain("\\noindent");
    expect(second.commands.filter((item) => item.label === "\\textbf")).toHaveLength(1);
  });
});
