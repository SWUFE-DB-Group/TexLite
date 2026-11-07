import { describe, expect, it } from "vitest";
import { citationVenue, parseBibEntriesResult, parseSingleBibEntry } from "../src/client/citationLibrary";
import { MAX_CITATION_BIBTEX_BYTES } from "../src/server/limits.js";

const citationLimit = MAX_CITATION_BIBTEX_BYTES;

describe("citation library BibTeX parser", () => {
  it("preserves complete entries and extracts common metadata", () => {
    const source = `prefix % @article{ignored-inline, title={No}}
% @article{ignored, title={No}}
@article{smith2025,
  author = {Smith, Ada and Jones, Bob},
  title = {A {Nested} title},
  year = "2025",
  note = {A comma, inside braces}
}
@inproceedings(foo2024,
  title={Conference paper},
  author={Foo},
  year={2024}
)
@string{venue = "Journal"}
`;
    const { status, entries } = parseBibEntriesResult(source, citationLimit);
    expect(status).toBe("ok");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ citationKey: "smith2025", entryType: "article", title: "A {Nested} title", year: "2025" });
    expect(entries[0].bibtex).toContain("note = {A comma, inside braces}");
    expect(entries[1]).toMatchObject({ citationKey: "foo2024", entryType: "inproceedings", title: "Conference paper" });
  });

  it("accepts exactly one supported citation entry for library writes", () => {
    expect(parseSingleBibEntry("@article{one, title={One}}", citationLimit)?.citationKey).toBe("one");
    expect(parseSingleBibEntry("@comment{not a citation}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("@article{broken, title={Unclosed}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("@article{one, title={One}}\n@article{two, title={Two}}", citationLimit)).toBeNull();
  });

  it("rejects malformed fields and handles parentheses inside braced values", () => {
    expect(parseSingleBibEntry("@article{x, nonsense}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("@article{x, title=}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("@article(parenthesized, title={A) valid title}, year={2026})", citationLimit))
      .toMatchObject({ citationKey: "parenthesized", title: "A) valid title", year: "2026" });
    expect(parseSingleBibEntry("@misc{encoded, url={https://example.test/a%20b}, title=\"A {Nested} title\"}", citationLimit))
      .toMatchObject({ citationKey: "encoded", title: "A {Nested} title" });
  });

  it("extracts a conference or journal venue for citation cards", () => {
    expect(citationVenue({ bibtex: "@inproceedings{x,booktitle={Proceedings of Example},title={Paper}}" })).toBe("Proceedings of Example");
    expect(citationVenue({ bibtex: "@article{x,journal={Journal of Example},title={Paper}}" })).toBe("Journal of Example");
  });

  it("distinguishes an oversized document from an empty or invalid one", () => {
    expect(parseBibEntriesResult("", citationLimit)).toEqual({ status: "empty", entries: [] });
    expect(parseBibEntriesResult("@article{x title={Y}}", citationLimit)).toEqual({ status: "invalid", entries: [] });
    expect(parseBibEntriesResult("x".repeat(citationLimit + 1), citationLimit)).toEqual({ status: "too-large", entries: [] });
  });

  it("keeps an entry whole when a comment inside it contains an unpaired brace", () => {
    const entry = "@article{a,\n  title = {Hello},\n  % } stray brace in a comment\n  year = {2024}\n}";
    const result = parseBibEntriesResult(`${entry}\n@article{b, title={B}}`, citationLimit);
    expect(result.status).toBe("ok");
    expect(result.entries.map((item) => item.citationKey)).toEqual(["a", "b"]);
    expect(result.entries[0].bibtex).toBe(entry);
    expect(result.entries[0]).toMatchObject({ title: "Hello", year: "2024" });
    expect(parseSingleBibEntry(entry, citationLimit)).toMatchObject({ citationKey: "a", bibtex: entry, year: "2024" });
  });

  it("accepts a comment after the last field, as the editor does", () => {
    const source = "@article{a, title = {T}, year = {2020} % note\n}";
    expect(parseBibEntriesResult(source, citationLimit)).toMatchObject({ status: "ok", entries: [{ citationKey: "a", year: "2020" }] });
    expect(parseSingleBibEntry(source, citationLimit)).toMatchObject({ citationKey: "a", year: "2020" });
  });

  it("shows a concatenated value as written rather than cutting it at the inner delimiters", () => {
    expect(parseSingleBibEntry(`@article{a, title = "Deep " # "Learning", year = 2020}`, citationLimit))
      .toMatchObject({ title: `"Deep " # "Learning"`, year: "2020" });
    expect(parseSingleBibEntry("@article{a, title = {Deep } # {Learning}}", citationLimit))
      .toMatchObject({ title: "{Deep } # {Learning}" });
  });

  it("keeps the entry type as written and accepts an entry without fields", () => {
    expect(parseSingleBibEntry("@Article{Key, title={T}}", citationLimit)).toMatchObject({ entryType: "Article", citationKey: "Key" });
    expect(parseSingleBibEntry("@misc{only}", citationLimit)).toMatchObject({ citationKey: "only", title: null });
  });

  it("requires the text to be exactly one entry, with nothing around it", () => {
    expect(parseSingleBibEntry("  \n@article{one, title={One}}\n  ", citationLimit)?.bibtex).toBe("@article{one, title={One}}");
    expect(parseSingleBibEntry("@string{s = \"x\"}\n@article{one, title={One}}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("@article{one, title={One}}\n% trailing note", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("see below\n@article{one, title={One}}", citationLimit)).toBeNull();
    expect(parseSingleBibEntry("", citationLimit)).toBeNull();
  });

  it("reports an empty library when a document has no citeable entries", () => {
    expect(parseBibEntriesResult(`@string{s = "x"}\n@comment{@article{hidden, title={No}}}\n% only notes`, citationLimit))
      .toEqual({ status: "empty", entries: [] });
  });

  it("accepts macro names and entry types with the punctuation BibTeX allows", () => {
    const record = "@article{key, title={Title}, author={Doe, Jane}, journal=j.bmj, year={2026}}";
    expect(parseSingleBibEntry(record, citationLimit)).toMatchObject({ citationKey: "key", entryType: "article", year: "2026" });
    expect(parseBibEntriesResult(`@string{j.bmj = "British Medical Journal"}\n${record}`, citationLimit))
      .toMatchObject({ status: "ok", entries: [{ citationKey: "key", bibtex: record }] });
    expect(parseSingleBibEntry("@misc1{custom, title={T}}", citationLimit)).toMatchObject({ entryType: "misc1" });
    expect(parseSingleBibEntry("@article-v2{custom, title={T}}", citationLimit)).toMatchObject({ entryType: "article-v2" });
  });

  it("still rejects a bare value that is neither a number nor a macro name", () => {
    expect(parseSingleBibEntry("@article{key, title=1abc}", citationLimit)).toBeNull();
  });

  it("rejects the whole document when any entry has a syntax error", () => {
    expect(parseBibEntriesResult("@article{ok, title={T}}\n@article{broken, title={T}", citationLimit))
      .toEqual({ status: "invalid", entries: [] });
  });
});
