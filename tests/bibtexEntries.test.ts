import { describe, expect, it } from "vitest";
import { parseBibtexDocument } from "../src/client/bibtex/entries";
import { findBibtexEntryKeys } from "../src/shared/bibtexReferences";

describe("BibTeX document model", () => {
  it("reports each entry's exact range, type as written, key and fields", () => {
    const source = "% heading\n@Article{smith2025,\n  Title = {One},\n  title = {Two},\n  YEAR = 2025\n}\n\n@book(b, author={X})\n";
    const { entries, hasSyntaxErrors } = parseBibtexDocument(source);
    expect(hasSyntaxErrors).toBe(false);
    expect(entries.map((entry) => [entry.key, entry.entryType])).toEqual([["smith2025", "Article"], ["b", "book"]]);
    expect(source.slice(entries[0].from, entries[0].to)).toBe("@Article{smith2025,\n  Title = {One},\n  title = {Two},\n  YEAR = 2025\n}");
    expect(source.slice(entries[1].from, entries[1].to)).toBe("@book(b, author={X})");
    expect(entries[0].fields).toEqual({ title: "Two", year: "2025" });
  });

  it("extracts values across comments, quotes, escapes and percent signs", () => {
    const { entries, hasSyntaxErrors } = parseBibtexDocument([
      "@article{k,",
      `  % a comment with , "quotes" {braces} (parens)`,
      "  author = {Smith, Ada and Jones, Bob},",
      "  title = {A {Nested} title},",
      "  year = {2025},",
      "  journal = {Journal of Testing},",
      "  doi = {10.1000/example},",
      `  note = "100% real, value",`,
      "  url = {https://example.test/a%20b}",
      "}"
    ].join("\n"));
    expect(hasSyntaxErrors).toBe(false);
    expect(entries[0].fields).toEqual({
      author: "Smith, Ada and Jones, Bob",
      title: "A {Nested} title",
      year: "2025",
      journal: "Journal of Testing",
      doi: "10.1000/example",
      note: "100% real, value",
      url: "https://example.test/a%20b"
    });
  });

  it("does not treat quotes inside braced values as field delimiters", () => {
    expect(parseBibtexDocument([
      `@article{k, title = {A "single quotation},`,
      "year = {2024},",
      `note = {Another "quoted, value" here}}`
    ].join("\n")).entries[0].fields).toEqual({
      title: `A "single quotation`, year: "2024", note: `Another "quoted, value" here`
    });
  });

  it("reads entries and fields whose names contain punctuation", () => {
    const { entries, hasSyntaxErrors } = parseBibtexDocument(
      `@string{j.bmj = "British Medical Journal"}\n@Misc1{k, alt:title = {T}, journal = j.bmj}\n@article-v2{second, year = 2026}`
    );
    expect(hasSyntaxErrors).toBe(false);
    expect(entries.map((entry) => [entry.key, entry.entryType])).toEqual([["k", "Misc1"], ["second", "article-v2"]]);
    expect(entries[0].fields).toEqual({ "alt:title": "T", journal: "j.bmj" });
  });

  it("keeps concatenations as written instead of splitting them at the delimiters", () => {
    const [entry] = parseBibtexDocument(`@article{k, title = "Deep " # "Learning", note = {A} # {B}, year = 2020}`).entries;
    expect(entry.fields).toMatchObject({ title: `"Deep " # "Learning"`, note: "{A} # {B}", year: "2020" });
  });

  it("does not list @string, @preamble or @comment, even when they hide entry-like text", () => {
    const { entries, hasSyntaxErrors } = parseBibtexDocument([
      `@string{s = "x"}`, `@preamble{"\\newcommand{\\x}{y}"}`, "@comment{@article{hidden, title={No}}}", "@article{shown, title={Yes}}"
    ].join("\n"));
    expect(hasSyntaxErrors).toBe(false);
    expect(entries.map((entry) => entry.key)).toEqual(["shown"]);
  });

  it.each([
    ["a missing comma", "@article{x title={Y}}"],
    ["a field without a value", "@article{x, title=}"],
    ["a bare word where a field belongs", "@article{x, nonsense}"],
    ["an unclosed entry", "@article{x, title={T}"],
    ["an empty key", "@article{,title={T}}"],
    ["a doubled comma", "@article{x, title={T},, year={2}}"]
  ])("flags %s as a syntax error", (_name, source) => {
    expect(parseBibtexDocument(source).hasSyntaxErrors).toBe(true);
  });

  it("treats text outside any entry as neither an entry nor an error", () => {
    expect(parseBibtexDocument("title = {One}, broken")).toEqual({ entries: [], hasSyntaxErrors: false });
  });

  it("accepts free text between entries and ignores commented-out entries", () => {
    const { entries, hasSyntaxErrors } = parseBibtexDocument(
      "notes, with commas\n% @article{ignored, title={No}}\n@article{a, title={A}}\nmore text\n@article{b, title={B}}"
    );
    expect(hasSyntaxErrors).toBe(false);
    expect(entries.map((entry) => entry.key)).toEqual(["a", "b"]);
  });
});

// The server cannot load the browser grammar, so it keeps its own scanner for
// completion and navigation. These sources are the shared contract: both must
// find the same entries, in the same places, however awkward the layout.
describe("server entry scanner agrees with the editor grammar", () => {
  const corpus: Record<string, string> = {
    "comment with a closing brace": "@article{a,\n  title = {Hello},\n  % } stray brace\n  year = {2024}\n}\n@article{b, title={B}}",
    "comment with an opening brace": "@article{a,\n  title = {Hello},\n  % { stray brace\n  year = {2024}\n}\n@article{b, title={B}}",
    "trailing comment on the last field": "@article{a, title = {T}, year = {2020} % note\n}\n@article{b, title={B}}",
    "percent inside quotes and braces": `@article{a, title = "50% off {x}", url={https://x.test/a%20b}}\n@article{b, title={B}}`,
    "quote inside a braced value": `@article{a, title = {A "single quotation}, year={2024}}\n@article{b, title={B}}`,
    "escaped brace": "@article{a, title = {Use \\} carefully}, year={2020}}\n@article{b, title={B}}",
    "parenthesized entries": "@article(a, title={A) valid title}, year={2026}) % ) comment\n@book(b, title={B})",
    "string, preamble and comment entries": `@string{s = "x"}\n@preamble{"\\x"}\n@comment{@article{hidden, title={No}}}\n@article{a, title={A}}`,
    "commented-out entry and free text": "text, here\n% @article{ignored, title={No}}\n@article{a, title={A}}\nmore\n@book{b, title={B}}",
    "key punctuation": "@article{Smith+2026:a/b.c, title={T}}\n@misc{k2, title={T}}",
    "case and spacing": "@ARTICLE {Upper, title={T}}\n@Book\n{Mixed, title={B}}",
    "concatenation and macros": `@string{j = "J"}\n@article{a, journal = j # { Suffix}, title = {A} # {B}}\n@book{b, title={B}}`,
    "key-only entry": "@misc{only}\n@misc{trailing,}\n@book{b, title={B}}",
    "entry types with digits, hyphens and underscores": "@misc1{a, title={A}}\n@article-v2{b, title={B}}\n@my_type{c, title={C}}\n@book{d, title={D}}",
    "macro and field names with punctuation": `@string{j.bmj = "J"}\n@article{a, journal = j.bmj, alt:title = {T}}\n@book{b, title={B}}`
  };

  it("never reads a field name as the key of an entry that has none", () => {
    const source = "@article{title = {A}, year = 2020}\n@book{b, title={B}}";
    const document = parseBibtexDocument(source);
    expect(document.hasSyntaxErrors).toBe(true);
    expect(document.entries.map((entry) => entry.key)).toEqual(["b"]);
    expect(findBibtexEntryKeys(source).map((entry) => entry.key)).toEqual(["b"]);
  });

  it.each(Object.entries(corpus))("%s", (_name, source) => {
    const document = parseBibtexDocument(source);
    expect(document.hasSyntaxErrors).toBe(false);
    expect(findBibtexEntryKeys(source).map((entry) => [entry.key, entry.entryFrom, entry.entryTo]))
      .toEqual(document.entries.map((entry) => [entry.key, entry.from, entry.to]));
  });
});
