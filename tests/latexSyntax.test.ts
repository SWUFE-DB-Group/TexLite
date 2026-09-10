import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { defaultHighlightStyle, foldable, matchBrackets, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import {
  bibtexCompletionSource,
  bibtexEditorExtensions,
  bibtexLanguage,
  bibtexLinter,
  latexLanguage
} from "../src/client/latexLanguage";
import { hasDocumentClass } from "../src/client/latexRoot";

describe("LaTeX syntax handling", () => {
  it("matches an outer resizebox brace after a nested tabular environment", () => {
    const source = String.raw`\resizebox{\linewidth}{!}{
  \begin{tabular}{ll}
    \textbf{Header} \\
  \end{tabular}
}`;
    const state = EditorState.create({ doc: source, extensions: [latexLanguage] });
    const openingLine = state.doc.line(1);
    const closingLine = state.doc.line(5);
    const opening = openingLine.from + openingLine.text.lastIndexOf("{");
    const closing = closingLine.from + closingLine.text.indexOf("}");
    const match = matchBrackets(state, closing + 1, -1);
    expect(match).toMatchObject({
      start: { from: closing, to: closing + 1 },
      end: { from: opening, to: opening + 1 },
      matched: true
    });
  });

  it("detects document roots after source changes while ignoring comments and listings", () => {
    expect(hasDocumentClass("% \\documentclass{article}\n")).toBe(false);
    const listing = "\\begin{verbatim}[options]\n\\documentclass{article}\n\\end{verbatim}";
    expect(hasDocumentClass(listing)).toBe(false);
    expect(hasDocumentClass("\\documentclass[11pt]{article}\n")).toBe(true);
  });

  it("parses TeX accent escapes in BibTeX values without losing brace matching", () => {
    const source = String.raw`@inproceedings{rombach2022high,
  title={High-Resolution Image Synthesis with Latent Diffusion Models},
  author={Rombach, Robin and Blattmann, Andreas and Lorenz, Dominik and Esser, Patrick and Ommer, Bj{\"o}rn},
  booktitle={Proceedings of the IEEE/CVF conference on computer vision and pattern recognition},
  pages={10684--10695},
  year={2022}
}
@article{next,
  title="The next entry"
}`;
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const errors: Array<{ from: number; to: number }> = [];
    let entryCount = 0;
    let escapeCount = 0;
    syntaxTree(state).iterate({
      enter(node) {
        if (node.type.isError) errors.push({ from: node.from, to: node.to });
        if (node.name === "Entry") entryCount += 1;
        if (node.name === "Escape") escapeCount += 1;
      }
    });

    expect(errors).toEqual([]);
    expect(entryCount).toBe(2);
    expect(escapeCount).toBe(1);

    const authorClosing = source.indexOf("},\n  booktitle");
    const authorOpening = source.indexOf("{", source.indexOf("author="));
    expect(matchBrackets(state, authorClosing + 1, -1)).toMatchObject({
      start: { from: authorClosing, to: authorClosing + 1 },
      end: { from: authorOpening, to: authorOpening + 1 },
      matched: true
    });
  });

  it("parses common BibTeX value forms and nested TeX accents", () => {
    const source = String.raw`@string{cvpr = "Proceedings of CVPR"}
@inproceedings(garcia2025,
  author = {Garc{\'i}a and M{\"u}ller},
  booktitle = cvpr # " 2025",
  year = 2025,
)`;
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const errors: Array<{ from: number; to: number }> = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.type.isError) errors.push({ from: node.from, to: node.to });
      }
    });
    expect(errors).toEqual([]);
  });

  it("preserves highlighting for BibTeX line comments", () => {
    const source = "% Generated bibliography\n@article{sample, title={Example}}";
    const state = EditorState.create({ doc: source, extensions: [bibtexLanguage] });
    const highlighted: string[] = [];
    highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => {
      highlighted.push(state.sliceDoc(from, to));
    });
    expect(highlighted).toContain("% Generated bibliography");
  });

  it("enables codemirror-lang-bib folding, diagnostics, and field completion", () => {
    const incompleteSource = String.raw`@article{example,
  title = {An incomplete entry}
}`;
    const state = EditorState.create({ doc: incompleteSource, extensions: [bibtexLanguage, ...bibtexEditorExtensions] });
    const openingLine = state.doc.line(1);
    const fold = foldable(state, openingLine.from, openingLine.to);
    expect(fold).toMatchObject({ to: state.doc.line(3).from });
    expect(fold?.from).toBeLessThan(openingLine.to);

    const diagnostics = bibtexLinter()({ state } as unknown as EditorView);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", source: "BibTeX" })
    ]));

    const completionSource = "@inproceedings{example,\n  aut";
    const completionState = EditorState.create({ doc: completionSource, extensions: [bibtexLanguage] });
    const completion = bibtexCompletionSource(new CompletionContext(completionState, completionSource.length, true));
    expect(completion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "author", type: "property" })
    ]));
  });
});
