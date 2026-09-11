import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { findBibtexEntryKeys } from "../src/shared/bibtexReferences.js";
import { classifyLatexReferenceCommand } from "../src/shared/latexReferenceCommands.js";
import {
  findLatexBibliographyFiles,
  findLatexReferenceDefinitions,
  findLatexReferences,
  findLatexSourceIncludes
} from "../src/shared/latexReferences.js";

async function fixture(path: string): Promise<string> {
  return readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

describe("LaTeX/BibTeX reference corpus", () => {
  it("keeps paper-style command classification declarative and conservative", () => {
    expect(classifyLatexReferenceCommand("hyperref")).toMatchObject({
      kind: "label", argumentKind: "optional", maximumArguments: 1
    });
    expect(classifyLatexReferenceCommand("Crefrange")).toMatchObject({
      kind: "label", argumentKind: "mandatory", maximumArguments: 2
    });
    expect(classifyLatexReferenceCommand("smartcites")).toMatchObject({
      kind: "citation", maximumArguments: Number.MAX_SAFE_INTEGER
    });
    expect(classifyLatexReferenceCommand("setcitestyle")).toBeNull();
    expect(classifyLatexReferenceCommand("href")).toBeNull();
  });

  it("handles citations, labels, dependencies, comments, and literal forms together", async () => {
    const source = await fixture("latex/reference-paper.tex");
    expect(findLatexReferences(source).map((reference) => [reference.kind, reference.key])).toEqual([
      ["citation", "smith2024"],
      ["citation", "jones2025"],
      ["citation", "alpha2026"],
      ["citation", "beta2026"],
      ["label", "fig:overview"],
      ["label", "fig:result"],
      ["label", "sec:introduction"]
    ]);
    expect(findLatexReferenceDefinitions(source, "label").map((definition) => definition.key))
      .toEqual(["sec:introduction"]);
    expect(findLatexSourceIncludes(source).map((reference) => reference.path))
      .toEqual(["chapters/methods", "appendices/proof"]);
    expect(findLatexBibliographyFiles(source).map((reference) => reference.path))
      .toEqual(["bibliography/primary.bib", "bibliography/legacy", "bibliography/extra"]);
  });

  it("finds complete BibTeX keys in representative export-style records", async () => {
    const source = await fixture("bibtex/reference-library.bib");
    expect(findBibtexEntryKeys(source).map((entry) => entry.key))
      .toEqual(["smith2024", "jones2025", "after-record"]);
    expect(findLatexReferenceDefinitions(source, "citation", true).map((entry) => entry.key))
      .toEqual(["smith2024", "jones2025", "after-record"]);
  });
});
