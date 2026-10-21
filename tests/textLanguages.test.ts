import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { isLatexEditorFile, loadTextFileLanguage, textLanguageKind } from "../src/client/textLanguages";

describe("generic text editor languages", () => {
  it.each([
    ["config.json", '{"title": "Example", "enabled": true}'],
    ["config.yml", "# Settings\ntitle: Example\nenabled: true"],
    ["run.sh", '#!/bin/sh\nif true; then echo "hello"; fi'],
    ["settings.toml", '[server]\nhost = "localhost"'],
    ["script.ts", 'const title: string = "Example";'],
    ["module.mts", 'export const title: string = "Example";'],
    ["script.js", 'const title = "Example";'],
    ["component.jsx", 'const view = <div className="example" />;'],
    ["component.tsx", 'const view: Element = <div className="example" />;'],
    ["index.html", '<div class="content">Example</div>'],
    ["style.css", '.content { color: blue; }'],
    ["data.xml", '<root name="value">Example</root>'],
    ["script.py", 'def hello():\n  return "hello"'],
    ["README.md", '# Title\n**hello**'],
    ["latexmkrc", '$pdf_mode = 1; # Settings'],
    [".env", 'KEY=value\n# comment'],
    ["Dockerfile", 'FROM node:24\nRUN echo hello'],
    ["CMakeLists.txt", 'project(Example)\n# comment'],
    ["run", '#!/usr/bin/env bash\necho "hello"'],
    ["program", '#!/usr/bin/env python3\nprint("hello")']
  ])("parses and highlights %s using CodeMirror language support", async (file, source) => {
    const state = EditorState.create({ doc: source, extensions: await loadTextFileLanguage(file, source.split("\n")[0]) });
    const tree = ensureSyntaxTree(state, source.length, 1000);
    expect(tree).not.toBeNull();
    const marks: string[] = [];
    highlightTree(tree!, classHighlighter, (from, to) => marks.push(source.slice(from, to)));
    expect(marks.length).toBeGreaterThan(0);
    expect(isLatexEditorFile(file)).toBe(false);
  });

  it("leaves ordinary and unknown text plain instead of interpreting LaTeX", async () => {
    const source = String.raw`\begin{not-latex} $value # literal`;
    for (const file of ["notes.txt", "values.dat", "LICENSE", "custom.unusual"]) {
      expect(textLanguageKind(file)).toBeNull();
      const state = EditorState.create({ doc: source, extensions: await loadTextFileLanguage(file) });
      const marks: string[] = [];
      highlightTree(syntaxTree(state), classHighlighter, (from, to) => marks.push(source.slice(from, to)));
      expect(marks).toEqual([]);
    }
    expect(isLatexEditorFile("paper.TEX")).toBe(true);
    expect(isLatexEditorFile("custom.sty")).toBe(true);
    expect(isLatexEditorFile("references.bib")).toBe(false);
  });
});
