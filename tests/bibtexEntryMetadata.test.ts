import { describe, expect, it } from "vitest";
import { bibtexEntrySummaries, bibtexEntrySummary } from "../src/client/bibtex/entryMetadata";

describe("parser-backed BibTeX entry metadata", () => {
  it("extracts title, authors, year, venue, DOI and URL", () => {
    const source = [
      "@article{smith2025,",
      "  author = {Smith, Ada and Jones, Bob},",
      "  title = {A {Nested} title},",
      "  year = {2025},",
      "  journal = {Journal of Testing},",
      "  doi = {10.1000/example},",
      "  url = {https://example.test/a%20b}",
      "}",
      "@book{other, title = {Other entry}}"
    ].join("\n");

    expect(bibtexEntrySummary(source, "smith2025")).toEqual({
      key: "smith2025", entryType: "article", title: "A {Nested} title",
      authors: "Smith, Ada and Jones, Bob", year: "2025", venue: "Journal of Testing",
      doi: "10.1000/example", url: "https://example.test/a%20b"
    });
    expect(bibtexEntrySummary(source, "missing")).toBeNull();
    expect(bibtexEntrySummary(source, "other")).toMatchObject({
      entryType: "book", title: "Other entry", venue: null
    });
  });

  it("parses comments, quotes and parenthesized entries through the grammar", () => {
    const source = [
      "@article{commented,",
      "  title = {Hello},",
      "  % } comment with a closing brace, \"quotes\" and (parens)",
      "  year = {2024}",
      "}",
      "@article{quotedBrace,",
      `  title = {A "single quotation},`,
      "  year = {2025},",
      `  note = {Another "quoted, value" here}`,
      "}",
      "@inproceedings(parenthesized,",
      "  title = {Paren}, % ) comment",
      "  booktitle = {Proceedings of Testing},",
      "  year = {2026}",
      ")"
    ].join("\n");

    expect(bibtexEntrySummary(source, "commented")).toMatchObject({
      title: "Hello", year: "2024"
    });
    expect(bibtexEntrySummary(source, "quotedBrace")).toMatchObject({
      title: `A "single quotation`, year: "2025"
    });
    expect(bibtexEntrySummary(source, "parenthesized")).toMatchObject({
      title: "Paren", year: "2026", venue: "Proceedings of Testing"
    });
    expect([...bibtexEntrySummaries(source).keys()])
      .toEqual(["commented", "quotedBrace", "parenthesized"]);
  });
});
