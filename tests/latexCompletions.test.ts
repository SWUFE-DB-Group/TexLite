import { describe, expect, it, vi } from "vitest";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFunction } from "i18next";
import { latexCompletions } from "../src/client/latexCompletions";
import { latexLanguage } from "../src/client/latexLanguage";
import type { LatexCompletionIndex } from "../src/client/types";

const t = ((key: string) => key) as TFunction;
const index: LatexCompletionIndex = {
  commands: [], environments: [{ label: "figure", kind: "keyword", detail: "Environment" }],
  labels: [{ label: "fig:second", kind: "constant", detail: "Label" }], citations: [],
  packages: [{ label: "amssymb", kind: "text", detail: "Package" }],
  classes: [{ label: "article", kind: "class", detail: "Document class" }],
  files: [{ label: "figure.png", kind: "text", detail: "Project file" }]
};

function complete(source: string, explicit = true) {
  const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
  return latexCompletions(new CompletionContext(state, source.length, explicit), t, index);
}

describe("editor LaTeX completion source", () => {
  it.each([
    [String.raw`\usepackage{amsmath, ams`, "amssymb", String.raw`\usepackage{amsmath, amssymb`],
    [String.raw`\RequirePackage[opt]{amsmath, ams`, "amssymb", String.raw`\RequirePackage[opt]{amsmath, amssymb`],
    [String.raw`\cref{fig:first, fig:`, "fig:second", String.raw`\cref{fig:first, fig:second`],
    [String.raw`\Cref{fig:first, fig:`, "fig:second", String.raw`\Cref{fig:first, fig:second`]
  ])("preserves earlier list entries in %s", (source, label, expected) => {
    const result = complete(source)!;
    expect(result.options.some((item) => item.label === label)).toBe(true);
    expect(source.slice(0, result.from) + label).toBe(expected);
    expect(result.validFor.test("item,")).toBe(false);
  });

  it.each(["nocite", "citep*", "citet*", "Parencite", "Textcite", "Autocite", "Citeauthor"])("completes %s citations", (command) => {
    const source = `\\${command}[see]{one, tw`;
    expect(complete(source)?.from).toBe(source.lastIndexOf("tw"));
  });

  it("completes subsequent multicite arguments", () => {
    const source = String.raw`\cites[see]{first}[p. 2]{seco`;
    expect(complete(source)?.from).toBe(source.lastIndexOf("seco"));
  });

  it("does not interpret a separate group after a single citation as another citation argument", () => {
    expect(complete(String.raw`\cite{first} {ordinary`, false)).toBeNull();
  });

  it("does not offer arbitrary project files as document classes", () => {
    expect(complete(String.raw`\documentclass{`)?.options.map((item) => item.label)).toEqual(["article"]);
  });

  it.each([String.raw`\end{fig`, String.raw`\end{fig}`])("closes end completions without duplicating braces: %s", (source) => {
    let state = EditorState.create({ doc: source });
    const to = source.indexOf("fig") + 3;
    const result = latexCompletions(new CompletionContext(state, to, true), t, index)!;
    const option = result.options.find((entry) => entry.label === "figure")!;
    expect(typeof option.apply).toBe("function");
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
    (option.apply as Exclude<Completion["apply"], string | undefined>)(view, option, result.from, to);
    expect(state.doc.toString()).toBe(String.raw`\end{figure}`);
  });

  it("keeps command menus free of descriptive text", () => {
    expect(complete(String.raw`\noind`)?.options.find((entry) => entry.label === "\\noindent")?.detail).toBeUndefined();
  });

  it("does not flatten the full document for symbol extraction while typing prose", () => {
    const state = EditorState.create({ doc: "Ordinary prose without a completion context." });
    const flatten = vi.spyOn(state.doc, "toString");
    expect(latexCompletions(new CompletionContext(state, state.doc.length, false), t, index)).toBeNull();
    expect(flatten).not.toHaveBeenCalled();
    flatten.mockRestore();
  });
});
